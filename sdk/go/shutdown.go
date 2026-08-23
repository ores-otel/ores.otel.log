package nextloggers

import (
	"context"
	"errors"
	"fmt"
	"io"
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

type ShutdownStateEvent string

const (
	ShutdownTrigger    ShutdownStateEvent = "trigger"
	ShutdownForceNow   ShutdownStateEvent = "force-now"
	ShutdownMarkClosed ShutdownStateEvent = "mark-closed"
)

type ShutdownAction string

const (
	ShutdownBeginGraceful ShutdownAction = "begin-graceful"
	ShutdownForce         ShutdownAction = "force"
	ShutdownClose         ShutdownAction = "close"
	ShutdownIgnore        ShutdownAction = "ignore"
)

type ShutdownTransition struct {
	Phase  ShutdownPhase
	Action ShutdownAction
}

type shutdownPattern struct {
	phase ShutdownPhase
	event ShutdownStateEvent
}

// TransitionShutdownState is the pure, total relation refined from the shared
// TLA+ lifecycle vectors. Go has no algebraic-data-type pattern syntax, so a
// comparable struct is used as the pair pattern. Invalid open-string values are
// rejected instead of silently extending the closed formal state space.
func TransitionShutdownState(
	phase ShutdownPhase,
	event ShutdownStateEvent,
) (ShutdownTransition, error) {
	validPhase := phase == ShutdownRunning || phase == ShutdownDraining ||
		phase == ShutdownForced || phase == ShutdownClosed
	validEvent := event == ShutdownTrigger || event == ShutdownForceNow ||
		event == ShutdownMarkClosed
	if !validPhase || !validEvent {
		return ShutdownTransition{}, fmt.Errorf(
			"invalid shutdown transition pair %q:%q",
			phase,
			event,
		)
	}

	switch (shutdownPattern{phase: phase, event: event}) {
	case shutdownPattern{phase: ShutdownRunning, event: ShutdownTrigger}:
		return ShutdownTransition{Phase: ShutdownDraining, Action: ShutdownBeginGraceful}, nil
	case shutdownPattern{phase: ShutdownDraining, event: ShutdownTrigger},
		shutdownPattern{phase: ShutdownRunning, event: ShutdownForceNow},
		shutdownPattern{phase: ShutdownDraining, event: ShutdownForceNow}:
		return ShutdownTransition{Phase: ShutdownForced, Action: ShutdownForce}, nil
	case shutdownPattern{phase: ShutdownDraining, event: ShutdownMarkClosed}:
		return ShutdownTransition{Phase: ShutdownClosed, Action: ShutdownClose}, nil
	default:
		return ShutdownTransition{Phase: phase, Action: ShutdownIgnore}, nil
	}
}

type ShutdownPhase string

const (
	ShutdownRunning  ShutdownPhase = "running"
	ShutdownDraining ShutdownPhase = "draining"
	ShutdownForced   ShutdownPhase = "forced"
	ShutdownClosed   ShutdownPhase = "closed"
)

type ShutdownEvent struct {
	Phase       ShutdownPhase
	Cause       ShutdownCause
	Interactive bool
	// SignalCount counts operating-system SIGINT/SIGTERM events only.
	SignalCount int
	Message     string
	Err         error
}

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

type ShutdownOptions struct {
	Timeout time.Duration

	// Interactive overrides TTY detection when non-nil.
	Interactive *bool
	Stdin       io.Reader
	// DisableStdinEOF prevents Ctrl-D from replacing the second Ctrl-C. Even
	// when enabled, stdin is not read until the first interactive SIGINT.
	DisableStdinEOF bool

	// SignalChannel and EOFChannel are injectable test/embedding boundaries. If
	// SignalChannel is nil, os.Interrupt and SIGTERM are registered directly.
	// EOFChannel is dormant until the first interactive SIGINT.
	SignalChannel <-chan os.Signal
	EOFChannel    <-chan struct{}

	BeforeGraceful func(context.Context, ShutdownCause) error
	Flush          func(context.Context, ShutdownCause) error
	AfterGraceful  func(context.Context, ShutdownCause) error
	Force          func(ShutdownCause) error
	Log            func(ShutdownEvent)
	Clock          func() time.Time
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

// armEOF returns an EOF source only after an interactive SIGINT. A stale
// injected EOF that happened before arming is discarded so Ctrl-D can never be
// remembered as a future second-stage shutdown request.
func armEOF(stdin io.Reader, options ShutdownOptions) <-chan struct{} {
	if options.EOFChannel != nil {
		select {
		case _, ok := <-options.EOFChannel:
			if !ok {
				return nil
			}
			// Discard one pre-arm injected event, then listen for a later event.
			return options.EOFChannel
		default:
			return options.EOFChannel
		}
	}
	return watchEOF(stdin)
}

type gracefulShutdownOutcome struct {
	drainErr error
	err      error
}

// RunGracefulShutdown blocks for SIGINT/SIGTERM (or parent cancellation), then
// invokes Shutdown with a deadline.
//
// TTY policy:
//   - first SIGINT starts graceful drain and only then arms Ctrl-D;
//   - second SIGINT/another termination signal or armed Ctrl-D forces Close;
//   - SIGTERM starts graceful drain but never reads stdin.
//
// Non-TTY policy: stdin is never read; one signal starts graceful drain and a
// second signal or the deadline is the force fallback.
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
	parentDone := parent.Done()

	firstCause := ShutdownProgrammatic
	for {
		select {
		case value, ok := <-signals:
			if !ok {
				signals = nil
				if parentDone == nil {
					now := clock()
					return ShutdownResult{
						Phase:    ShutdownForced,
						Cause:    ShutdownProgrammatic,
						Started:  now,
						Finished: now,
						Err:      errors.New("nextloggers: shutdown signal source closed"),
					}
				}
				continue
			}
			signalCount++
			firstCause = signalCause(value)
		case <-parentDone:
			firstCause = ShutdownProgrammatic
			parentDone = nil
		}
		break
	}

	var eof <-chan struct{}
	if interactive && firstCause == ShutdownSIGINT && !options.DisableStdinEOF {
		eof = armEOF(stdin, options)
	}

	started := clock()
	emitShutdown(options, ShutdownEvent{
		Phase:       ShutdownDraining,
		Cause:       firstCause,
		Interactive: interactive,
		SignalCount: signalCount,
		Message: func() string {
			if interactive && firstCause == ShutdownSIGINT {
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
		// Prefer a completed graceful path over a near-simultaneous force event.
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
