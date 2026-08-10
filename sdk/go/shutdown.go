package nextloggers

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"
)

type ShutdownPhase string

const (
	ShutdownRunning  ShutdownPhase = "running"
	ShutdownDraining ShutdownPhase = "draining"
	ShutdownForcing  ShutdownPhase = "forcing"
	ShutdownStopped  ShutdownPhase = "stopped"
)

type ShutdownTrigger string

const (
	TriggerSIGINT       ShutdownTrigger = "SIGINT"
	TriggerSIGTERM      ShutdownTrigger = "SIGTERM"
	TriggerStdinEOF     ShutdownTrigger = "stdin-eof"
	TriggerTimeout      ShutdownTrigger = "timeout"
	TriggerContext      ShutdownTrigger = "context-canceled"
	TriggerServerError  ShutdownTrigger = "server-error"
	TriggerProgrammatic ShutdownTrigger = "programmatic"
)

type ShutdownEvent struct {
	Phase         ShutdownPhase
	PreviousPhase ShutdownPhase
	Trigger       ShutdownTrigger
	Interactive   bool
	Attempt       int
	Elapsed       time.Duration
	Message       string
	Err           error
}

type ShutdownObserver func(ShutdownEvent)

type HTTPServerLifecycle interface {
	Serve(net.Listener) error
	Shutdown(context.Context) error
	Close() error
}

type HTTPShutdownOptions struct {
	GracePeriod time.Duration
	// Interactive overrides terminal detection when non-nil.
	Interactive *bool
	Stdin       io.Reader
	// SignalChannel makes signal delivery injectable in tests. When nil,
	// os/signal is configured for SIGINT and SIGTERM (SIGINT only on Windows).
	SignalChannel <-chan os.Signal
	Observer      ShutdownObserver
	// Flush should flush next-loggers transports and the application-owned OTEL provider.
	Flush func(context.Context) error
	// ForceClose must close hijacked connections such as WebSockets.
	ForceClose func(context.Context) error
}

func shutdownMessage(phase ShutdownPhase, trigger ShutdownTrigger) string {
	switch phase {
	case ShutdownDraining:
		return "graceful shutdown started; no new work will be accepted"
	case ShutdownForcing:
		return "forced shutdown started; remaining work will be terminated"
	case ShutdownStopped:
		return "shutdown complete"
	default:
		return "shutdown coordinator running"
	}
}

func notifyShutdown(observer ShutdownObserver, event ShutdownEvent) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	observer(event)
}

func detectInteractive(reader io.Reader) bool {
	file, ok := reader.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func triggerForSignal(sig os.Signal) ShutdownTrigger {
	if sig == os.Interrupt {
		return TriggerSIGINT
	}
	name := strings.ToUpper(sig.String())
	if strings.Contains(name, "TERM") {
		return TriggerSIGTERM
	}
	return ShutdownTrigger(name)
}

func loggerShutdownObserver(logger *Logger) ShutdownObserver {
	return func(event ShutdownEvent) {
		if logger == nil {
			return
		}
		values := []any{event.Message}
		if event.Err != nil {
			values = append(values, event.Err)
		}
		var entry *Event
		switch event.Phase {
		case ShutdownForcing:
			entry = logger.Warn(values...)
		case ShutdownStopped:
			entry = logger.Info(values...)
		default:
			entry = logger.Info(values...)
		}
		entry.Fields["shutdown.phase"] = string(event.Phase)
		entry.Fields["shutdown.previous_phase"] = string(event.PreviousPhase)
		entry.Fields["shutdown.trigger"] = string(event.Trigger)
		entry.Fields["shutdown.interactive"] = event.Interactive
		entry.Fields["shutdown.attempt"] = event.Attempt
		entry.Fields["shutdown.elapsed_ms"] = event.Elapsed.Milliseconds()
		_ = entry.Send()
	}
}

// LoggerShutdownObserver returns an observer that emits structured next-loggers records.
// OpenTelemetry remains application-owned; configure an OTEL transport on logger.
func LoggerShutdownObserver(logger *Logger) ShutdownObserver {
	return loggerShutdownObserver(logger)
}

func flushShutdown(ctx context.Context, options HTTPShutdownOptions) error {
	if options.Flush == nil {
		return nil
	}
	return options.Flush(ctx)
}

// ServeHTTPWithShutdown owns server.Serve and applies the shared two-phase contract:
// first signal/EOF drains through Server.Shutdown; a second signal/EOF or timeout
// escalates through Server.Close. Hijacked connections are delegated to ForceClose.
func ServeHTTPWithShutdown(
	ctx context.Context,
	server HTTPServerLifecycle,
	listener net.Listener,
	options HTTPShutdownOptions,
) error {
	if server == nil {
		return errors.New("nextloggers: HTTP server is required")
	}
	if listener == nil {
		return errors.New("nextloggers: listener is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if options.GracePeriod <= 0 {
		options.GracePeriod = 30 * time.Second
	}
	if options.Stdin == nil {
		options.Stdin = os.Stdin
	}
	interactive := detectInteractive(options.Stdin)
	if options.Interactive != nil {
		interactive = *options.Interactive
	}

	startedAt := time.Now()
	phase := ShutdownRunning
	attempt := 0
	emit := func(next ShutdownPhase, trigger ShutdownTrigger, err error) {
		previous := phase
		phase = next
		notifyShutdown(options.Observer, ShutdownEvent{
			Phase:         next,
			PreviousPhase: previous,
			Trigger:       trigger,
			Interactive:   interactive,
			Attempt:       attempt,
			Elapsed:       time.Since(startedAt),
			Message:       shutdownMessage(next, trigger),
			Err:           err,
		})
	}

	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	var ownedSignals chan os.Signal
	signals := options.SignalChannel
	if signals == nil {
		ownedSignals = make(chan os.Signal, 2)
		signal.Notify(ownedSignals, defaultShutdownSignals()...)
		defer signal.Stop(ownedSignals)
		signals = ownedSignals
	}

	var stdinEOF <-chan struct{}
	if interactive && options.Stdin != nil {
		channel := make(chan struct{}, 1)
		stdinEOF = channel
		go func() {
			_, _ = io.Copy(io.Discard, options.Stdin)
			channel <- struct{}{}
		}()
	}

	var firstTrigger ShutdownTrigger
	select {
	case <-ctx.Done():
		firstTrigger = TriggerContext
	case sig, ok := <-signals:
		if !ok {
			firstTrigger = TriggerContext
		} else {
			firstTrigger = triggerForSignal(sig)
		}
	case <-stdinEOF:
		firstTrigger = TriggerStdinEOF
	case err := <-serveDone:
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		emit(ShutdownStopped, TriggerServerError, err)
		flushErr := flushShutdown(context.Background(), options)
		return errors.Join(err, flushErr)
	}

	attempt++
	emit(ShutdownDraining, firstTrigger, nil)
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), options.GracePeriod)
	defer cancelDrain()
	drainDone := make(chan error, 1)
	go func() { drainDone <- server.Shutdown(drainCtx) }()

	var failures []error
	force := func(trigger ShutdownTrigger, cause error) error {
		attempt++
		emit(ShutdownForcing, trigger, cause)
		if cause != nil && !errors.Is(cause, context.DeadlineExceeded) {
			failures = append(failures, cause)
		}
		if err := server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			failures = append(failures, err)
		}
		if options.ForceClose != nil {
			if err := options.ForceClose(context.Background()); err != nil {
				failures = append(failures, err)
			}
		}
		emit(ShutdownStopped, trigger, errors.Join(failures...))
		if err := flushShutdown(context.Background(), options); err != nil {
			failures = append(failures, err)
		}
		return errors.Join(failures...)
	}

	for {
		select {
		case err := <-drainDone:
			if err != nil {
				return force(TriggerTimeout, err)
			}
			emit(ShutdownStopped, firstTrigger, errors.Join(failures...))
			if err := flushShutdown(context.Background(), options); err != nil {
				failures = append(failures, err)
			}
			return errors.Join(failures...)
		case sig, ok := <-signals:
			if !ok {
				return force(TriggerContext, nil)
			}
			return force(triggerForSignal(sig), nil)
		case <-stdinEOF:
			return force(TriggerStdinEOF, nil)
		case <-drainCtx.Done():
			return force(TriggerTimeout, drainCtx.Err())
		case <-ctx.Done():
			return force(TriggerContext, ctx.Err())
		case err := <-serveDone:
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				failures = append(failures, err)
			}
			// Shutdown closes listeners immediately, so Serve normally returns
			// ErrServerClosed before active requests have finished. Keep waiting
			// for Shutdown rather than exiting the process too early.
			serveDone = nil
		}
	}
}
