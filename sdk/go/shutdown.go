package nextloggers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type ShutdownCause string

const (
	ShutdownSIGINT       ShutdownCause = "SIGINT"
	ShutdownSIGTERM      ShutdownCause = "SIGTERM"
	ShutdownStdinEOF     ShutdownCause = "stdin-eof"
	ShutdownTimeout      ShutdownCause = "timeout"
	ShutdownProgrammatic ShutdownCause = "programmatic"
)

type ShutdownPhase string

const (
	ShutdownRunning  ShutdownPhase = "running"
	ShutdownDraining ShutdownPhase = "draining"
	ShutdownForced   ShutdownPhase = "forced"
	ShutdownClosed   ShutdownPhase = "closed"
	// ShutdownForcing and ShutdownStopped retain the earlier HTTP lifecycle
	// vocabulary while the canonical coordinator keeps forced/closed.
	ShutdownForcing ShutdownPhase = "forcing"
	ShutdownStopped ShutdownPhase = "stopped"
)

type ShutdownTrigger = ShutdownCause

const (
	TriggerSIGINT       ShutdownTrigger = ShutdownSIGINT
	TriggerSIGTERM      ShutdownTrigger = ShutdownSIGTERM
	TriggerStdinEOF     ShutdownTrigger = ShutdownStdinEOF
	TriggerTimeout      ShutdownTrigger = ShutdownTimeout
	TriggerProgrammatic ShutdownTrigger = ShutdownProgrammatic
	TriggerContext      ShutdownTrigger = "context-canceled"
	TriggerServerError  ShutdownTrigger = "server-error"
)

type ShutdownEvent struct {
	Phase         ShutdownPhase
	PreviousPhase ShutdownPhase
	Cause         ShutdownCause
	Trigger       ShutdownTrigger
	Interactive   bool
	SignalCount   int
	Attempt       int
	Elapsed       time.Duration
	Message       string
	Err           error
}

type ShutdownObserver func(ShutdownEvent)

type ShutdownResult struct {
	Phase    ShutdownPhase
	Cause    ShutdownCause
	Started  time.Time
	Finished time.Time
	Err      error
}

// ShutdownServer is implemented by *http.Server. Shutdown must stop accepting
// connections and wait for active work; Close is the forceful escalation path.
type ShutdownServer interface {
	Shutdown(context.Context) error
	Close() error
}

// HTTPServerLifecycle is the serve-owning form of ShutdownServer.
type HTTPServerLifecycle interface {
	ShutdownServer
	Serve(net.Listener) error
}

type ShutdownOptions struct {
	Timeout time.Duration

	// Interactive overrides TTY detection when non-nil.
	Interactive *bool
	Stdin       io.Reader
	// DisableStdinEOF avoids consuming stdin in applications that own it. By
	// default Ctrl-D is watched only when stdin is an interactive terminal.
	DisableStdinEOF bool

	// SignalChannel and EOFChannel are injectable test/embedding boundaries. If
	// SignalChannel is nil, os.Interrupt and SIGTERM are registered directly.
	SignalChannel <-chan os.Signal
	EOFChannel    <-chan struct{}

	BeforeGraceful func(context.Context, ShutdownCause) error
	Flush          func(context.Context, ShutdownCause) error
	AfterGraceful  func(context.Context, ShutdownCause) error
	Force          func(ShutdownCause) error
	Log            func(ShutdownEvent)
	Clock          func() time.Time
}

// HTTPShutdownOptions preserves the serve-owning API while delegating drain
// and force semantics to the same bounded two-phase contract.
type HTTPShutdownOptions struct {
	GracePeriod   time.Duration
	Interactive   *bool
	Stdin         io.Reader
	SignalChannel <-chan os.Signal
	Observer      ShutdownObserver
	Flush         func(context.Context) error
	ForceClose    func(context.Context) error
}

func boolPointer(value bool) *bool { return &value }

func stdinIsTerminal(reader io.Reader) bool {
	file, ok := reader.(*os.File)
	if !ok || file == nil {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func signalCause(value os.Signal) ShutdownCause {
	if value == os.Interrupt || value == syscall.SIGINT {
		return ShutdownSIGINT
	}
	if value == syscall.SIGTERM {
		return ShutdownSIGTERM
	}
	return ShutdownProgrammatic
}

func emitShutdown(options ShutdownOptions, event ShutdownEvent) {
	if options.Log == nil {
		return
	}
	defer func() { _ = recover() }()
	options.Log(event)
}

func runHook(
	ctx context.Context,
	cause ShutdownCause,
	hook func(context.Context, ShutdownCause) error,
) (err error) {
	if hook == nil {
		return nil
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errors.Join(err, fmt.Errorf("shutdown hook panicked: %v", recovered))
		}
	}()
	return hook(ctx, cause)
}

// runHookBounded protects shutdown from callbacks that ignore cancellation.
// The callback may continue in its goroutine after the deadline, but process
// termination is never held hostage by it.
func runHookBounded(
	ctx context.Context,
	cause ShutdownCause,
	hook func(context.Context, ShutdownCause) error,
) error {
	if hook == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- runHook(ctx, cause, hook) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func runForceHook(cause ShutdownCause, hook func(ShutdownCause) error) (err error) {
	if hook == nil {
		return nil
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errors.Join(err, fmt.Errorf("force hook panicked: %v", recovered))
		}
	}()
	return hook(cause)
}

func runForceHookBounded(
	ctx context.Context,
	cause ShutdownCause,
	hook func(ShutdownCause) error,
) error {
	if hook == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- runForceHook(cause, hook) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func callShutdownSafely(server ShutdownServer, ctx context.Context) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errors.Join(err, fmt.Errorf("server Shutdown panicked: %v", recovered))
		}
	}()
	return server.Shutdown(ctx)
}

func callCloseSafely(server ShutdownServer) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errors.Join(err, fmt.Errorf("server Close panicked: %v", recovered))
		}
	}()
	return server.Close()
}

func ignorableServerCloseError(err error) bool {
	return err == nil || errors.Is(err, http.ErrServerClosed)
}

// LoggerShutdownLog adapts shutdown events to next-loggers records. It is
// intentionally best-effort so a failed transport can never block termination.
func LoggerShutdownLog(logger *Logger) func(ShutdownEvent) {
	return func(event ShutdownEvent) {
		if logger == nil {
			return
		}
		fields := map[string]any{
			"shutdown.phase":        string(event.Phase),
			"shutdown.cause":        string(event.Cause),
			"shutdown.interactive":  event.Interactive,
			"shutdown.signal_count": event.SignalCount,
		}
		var record *Event
		switch {
		case event.Err != nil:
			record = logger.Error(event.Message, event.Err)
		case event.Phase == ShutdownForced:
			record = logger.Warn(event.Message)
		default:
			record = logger.Info(event.Message)
		}
		_ = record.AddFields(fields).AddTags("shutdown", string(event.Phase)).Send()
	}
}

func watchEOF(reader io.Reader) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, reader)
		close(done)
	}()
	return done
}

type gracefulShutdownOutcome struct {
	drainErr error
	err      error
}

// RunGracefulShutdown blocks until one shutdown event arrives, then invokes
// Shutdown with a deadline. While draining (including telemetry flushes), a
// second SIGINT/SIGTERM or stdin EOF immediately escalates to Close. In
// non-interactive deployments one signal is sufficient: the function returns
// as soon as the graceful drain completes.
func RunGracefulShutdown(
	parent context.Context,
	server ShutdownServer,
	options ShutdownOptions,
) ShutdownResult {
	if parent == nil {
		parent = context.Background()
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	stdin := options.Stdin
	if stdin == nil {
		stdin = os.Stdin
	}
	interactive := stdinIsTerminal(stdin)
	if options.Interactive != nil {
		interactive = *options.Interactive
	}
	if server == nil {
		now := clock()
		return ShutdownResult{
			Phase:    ShutdownForced,
			Cause:    ShutdownProgrammatic,
			Started:  now,
			Finished: now,
			Err:      errors.New("nextloggers: shutdown server is nil"),
		}
	}

	signalCount := 0
	signals := options.SignalChannel
	var ownedSignals chan os.Signal
	if signals == nil {
		ownedSignals = make(chan os.Signal, 2)
		signal.Notify(ownedSignals, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(ownedSignals)
		signals = ownedSignals
	}

	eof := options.EOFChannel
	if eof == nil && interactive && !options.DisableStdinEOF {
		eof = watchEOF(stdin)
	}
	parentDone := parent.Done()

	firstCause := ShutdownProgrammatic
	for {
		select {
		case value, ok := <-signals:
			if !ok {
				signals = nil
				continue
			}
			signalCount++
			firstCause = signalCause(value)
		case <-eof:
			signalCount++
			firstCause = ShutdownStdinEOF
			// EOF is a one-shot close notification; leaving the closed channel in
			// later selects would incorrectly count the same Ctrl-D twice.
			eof = nil
		case <-parentDone:
			firstCause = ShutdownProgrammatic
			parentDone = nil
		}
		break
	}

	started := clock()
	emitShutdown(options, ShutdownEvent{
		Phase:       ShutdownDraining,
		Cause:       firstCause,
		Interactive: interactive,
		SignalCount: signalCount,
		Message: func() string {
			if interactive {
				return "graceful shutdown started; send Ctrl-C again or Ctrl-D to force"
			}
			return "graceful shutdown started"
		}(),
	})

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), timeout)
	defer cancelShutdown()

	var flushOnce sync.Once
	flushDone := make(chan struct{})
	var flushErr error
	flush := func(ctx context.Context, cause ShutdownCause) error {
		flushOnce.Do(func() {
			go func() {
				flushErr = runHook(ctx, cause, options.Flush)
				close(flushDone)
			}()
		})
		select {
		case <-flushDone:
			return flushErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	gracefulDone := make(chan gracefulShutdownOutcome, 1)
	initialSignalCount := signalCount
	go func() {
		var failures []error
		if err := runHookBounded(shutdownCtx, firstCause, options.BeforeGraceful); err != nil {
			failures = append(failures, err)
			emitShutdown(options, ShutdownEvent{
				Phase:       ShutdownDraining,
				Cause:       firstCause,
				Interactive: interactive,
				SignalCount: initialSignalCount,
				Message:     "pre-shutdown hook failed; server drain continues",
				Err:         err,
			})
		}

		drainErr := callShutdownSafely(server, shutdownCtx)
		if !ignorableServerCloseError(drainErr) {
			gracefulDone <- gracefulShutdownOutcome{
				drainErr: drainErr,
				err:      errors.Join(failures...),
			}
			return
		}

		if err := flush(shutdownCtx, firstCause); err != nil {
			failures = append(failures, err)
		}
		if err := runHookBounded(shutdownCtx, firstCause, options.AfterGraceful); err != nil {
			failures = append(failures, err)
		}
		gracefulDone <- gracefulShutdownOutcome{err: errors.Join(failures...)}
	}()

	force := func(cause ShutdownCause, trigger error) ShutdownResult {
		cancelShutdown()
		var failures []error
		if trigger != nil {
			failures = append(failures, trigger)
		}
		emitShutdown(options, ShutdownEvent{
			Phase:       ShutdownForced,
			Cause:       cause,
			Interactive: interactive,
			SignalCount: signalCount,
			Message:     "forcing server and long-lived connection shutdown",
			Err:         trigger,
		})
		if err := callCloseSafely(server); !ignorableServerCloseError(err) {
			failures = append(failures, err)
		}

		forceCtx, forceCancel := context.WithTimeout(context.Background(), timeout)
		defer forceCancel()
		if err := runForceHookBounded(forceCtx, cause, options.Force); err != nil {
			failures = append(failures, err)
		}
		if err := flush(forceCtx, cause); err != nil {
			failures = append(failures, err)
		}
		return ShutdownResult{
			Phase:    ShutdownForced,
			Cause:    cause,
			Started:  started,
			Finished: clock(),
			Err:      errors.Join(failures...),
		}
	}

	finishGraceful := func(outcome gracefulShutdownOutcome) ShutdownResult {
		if outcome.drainErr != nil {
			cause := firstCause
			if errors.Is(outcome.drainErr, context.DeadlineExceeded) || shutdownCtx.Err() != nil {
				cause = ShutdownTimeout
			}
			return force(cause, errors.Join(outcome.err, outcome.drainErr))
		}
		emitShutdown(options, ShutdownEvent{
			Phase:       ShutdownClosed,
			Cause:       firstCause,
			Interactive: interactive,
			SignalCount: signalCount,
			Message:     "graceful shutdown completed",
			Err:         outcome.err,
		})
		return ShutdownResult{
			Phase:    ShutdownClosed,
			Cause:    firstCause,
			Started:  started,
			Finished: clock(),
			Err:      outcome.err,
		}
	}

	for {
		// Prefer a completed graceful path over a near-simultaneous timeout or
		// signal so a fully drained server is not mislabeled as forced.
		select {
		case outcome := <-gracefulDone:
			return finishGraceful(outcome)
		default:
		}

		select {
		case outcome := <-gracefulDone:
			return finishGraceful(outcome)
		case value, ok := <-signals:
			if !ok {
				signals = nil
				continue
			}
			signalCount++
			return force(signalCause(value), nil)
		case <-eof:
			signalCount++
			eof = nil
			return force(ShutdownStdinEOF, nil)
		case <-parentDone:
			parentDone = nil
			return force(ShutdownProgrammatic, parent.Err())
		case <-shutdownCtx.Done():
			select {
			case outcome := <-gracefulDone:
				return finishGraceful(outcome)
			default:
				return force(ShutdownTimeout, shutdownCtx.Err())
			}
		}
	}
}

// NewInteractiveOverride is a small convenience for configuration builders.
func NewInteractiveOverride(value bool) *bool { return boolPointer(value) }

func shutdownMessage(phase ShutdownPhase, trigger ShutdownTrigger) string {
	switch phase {
	case ShutdownDraining:
		return "graceful shutdown started; no new work will be accepted"
	case ShutdownForcing:
		return "forced shutdown started; remaining work will be terminated"
	case ShutdownStopped:
		return "shutdown complete"
	default:
		return fmt.Sprintf("shutdown transition (%s)", trigger)
	}
}

func notifyShutdown(observer ShutdownObserver, event ShutdownEvent) {
	if observer == nil {
		return
	}
	defer func() { _ = recover() }()
	observer(event)
}

// LoggerShutdownObserver emits structured lifecycle records without allowing a
// logger or transport failure to interfere with process termination.
func LoggerShutdownObserver(logger *Logger) ShutdownObserver {
	logEvent := LoggerShutdownLog(logger)
	return func(event ShutdownEvent) {
		if event.Cause == "" {
			event.Cause = event.Trigger
		}
		logEvent(event)
	}
}

// ServeHTTPWithShutdown owns server.Serve and implements the same first-event
// drain, second-event force, bounded deadline, and exactly-once flush contract
// as RunGracefulShutdown.
func ServeHTTPWithShutdown(
	parent context.Context,
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
	if parent == nil {
		parent = context.Background()
	}
	gracePeriod := options.GracePeriod
	if gracePeriod <= 0 {
		gracePeriod = 30 * time.Second
	}
	stdin := options.Stdin
	if stdin == nil {
		stdin = os.Stdin
	}
	interactive := stdinIsTerminal(stdin)
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
			Cause:         trigger,
			Trigger:       trigger,
			Interactive:   interactive,
			SignalCount:   attempt,
			Attempt:       attempt,
			Elapsed:       time.Since(startedAt),
			Message:       shutdownMessage(next, trigger),
			Err:           err,
		})
	}

	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	signals := options.SignalChannel
	var ownedSignals chan os.Signal
	if signals == nil {
		ownedSignals = make(chan os.Signal, 2)
		signal.Notify(ownedSignals, defaultShutdownSignals()...)
		defer signal.Stop(ownedSignals)
		signals = ownedSignals
	}

	var stdinEOF <-chan struct{}
	if interactive && stdin != nil {
		stdinEOF = watchEOF(stdin)
	}

	firstTrigger := TriggerProgrammatic
	select {
	case <-parent.Done():
		firstTrigger = TriggerContext
	case value, ok := <-signals:
		if ok {
			firstTrigger = signalCause(value)
		} else {
			firstTrigger = TriggerContext
			signals = nil
		}
	case <-stdinEOF:
		firstTrigger = TriggerStdinEOF
		stdinEOF = nil
	case err := <-serveDone:
		if ignorableServerCloseError(err) {
			return nil
		}
		emit(ShutdownStopped, TriggerServerError, err)
		if options.Flush != nil {
			return errors.Join(err, options.Flush(context.Background()))
		}
		return err
	}

	attempt++
	emit(ShutdownDraining, firstTrigger, nil)
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), gracePeriod)
	defer cancelDrain()
	drainDone := make(chan error, 1)
	go func() { drainDone <- callShutdownSafely(server, drainCtx) }()

	var flushOnce sync.Once
	var flushErr error
	flush := func(ctx context.Context) error {
		flushOnce.Do(func() {
			if options.Flush != nil {
				flushErr = options.Flush(ctx)
			}
		})
		return flushErr
	}

	force := func(trigger ShutdownTrigger, cause error) error {
		attempt++
		emit(ShutdownForcing, trigger, cause)
		var failures []error
		if cause != nil && !errors.Is(cause, context.DeadlineExceeded) {
			failures = append(failures, cause)
		}
		if err := callCloseSafely(server); !ignorableServerCloseError(err) {
			failures = append(failures, err)
		}
		if options.ForceClose != nil {
			if err := options.ForceClose(context.Background()); err != nil {
				failures = append(failures, err)
			}
		}
		if err := flush(context.Background()); err != nil {
			failures = append(failures, err)
		}
		joined := errors.Join(failures...)
		emit(ShutdownStopped, trigger, joined)
		return joined
	}

	for {
		select {
		case err := <-drainDone:
			if !ignorableServerCloseError(err) {
				return force(TriggerTimeout, err)
			}
			var failures []error
			if err := flush(context.Background()); err != nil {
				failures = append(failures, err)
			}
			joined := errors.Join(failures...)
			emit(ShutdownStopped, firstTrigger, joined)
			return joined
		case value, ok := <-signals:
			if !ok {
				signals = nil
				return force(TriggerContext, nil)
			}
			return force(signalCause(value), nil)
		case <-stdinEOF:
			stdinEOF = nil
			return force(TriggerStdinEOF, nil)
		case <-drainCtx.Done():
			return force(TriggerTimeout, drainCtx.Err())
		case <-parent.Done():
			return force(TriggerContext, parent.Err())
		case err := <-serveDone:
			if !ignorableServerCloseError(err) {
				return force(TriggerServerError, err)
			}
			// Shutdown closes listeners before active requests complete. Keep
			// waiting for Shutdown rather than reporting an early clean exit.
			serveDone = nil
		}
	}
}
