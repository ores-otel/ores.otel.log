package nextloggers

import (
	"context"
	"errors"
	"net/http"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"
)

type fakeShutdownServer struct {
	once         sync.Once
	started      chan struct{}
	release      chan struct{}
	shutdownErr  error
	panicOnClose bool
	closeCalls   int
	mutex        sync.Mutex
}

func newFakeShutdownServer() *fakeShutdownServer {
	return &fakeShutdownServer{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (server *fakeShutdownServer) Shutdown(ctx context.Context) error {
	server.once.Do(func() { close(server.started) })
	if server.shutdownErr != nil {
		return server.shutdownErr
	}
	select {
	case <-server.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (server *fakeShutdownServer) Close() error {
	if server.panicOnClose {
		panic("close panic")
	}
	server.mutex.Lock()
	server.closeCalls++
	server.mutex.Unlock()
	select {
	case <-server.release:
	default:
		close(server.release)
	}
	return nil
}

func (server *fakeShutdownServer) calls() int {
	server.mutex.Lock()
	defer server.mutex.Unlock()
	return server.closeCalls
}

type shutdownEvents struct {
	mu     sync.Mutex
	events []ShutdownEvent
}

func (events *shutdownEvents) add(event ShutdownEvent) {
	events.mu.Lock()
	events.events = append(events.events, event)
	events.mu.Unlock()
}

func (events *shutdownEvents) snapshot() []ShutdownEvent {
	events.mu.Lock()
	defer events.mu.Unlock()
	return append([]ShutdownEvent(nil), events.events...)
}

func TestInteractiveSecondSignalForcesAndCountsSignals(t *testing.T) {
	server := newFakeShutdownServer()
	signals := make(chan os.Signal, 2)
	result := make(chan ShutdownResult, 1)
	logs := &shutdownEvents{}
	go func() {
		result <- RunGracefulShutdown(context.Background(), server, ShutdownOptions{
			Interactive:     NewInteractiveOverride(true),
			SignalChannel:   signals,
			DisableStdinEOF: true,
			Timeout:         time.Second,
			Log:             logs.add,
		})
	}()

	signals <- os.Interrupt
	<-server.started
	select {
	case <-result:
		t.Fatal("shutdown returned before graceful completion or force signal")
	default:
	}
	signals <- os.Interrupt
	got := <-result
	if got.Phase != ShutdownForced || got.Cause != ShutdownSIGINT || server.calls() != 1 {
		t.Fatalf("unexpected result %#v; close calls=%d", got, server.calls())
	}
	events := logs.snapshot()
	if len(events) < 2 || events[len(events)-1].SignalCount != 2 {
		t.Fatalf("expected two OS signals in lifecycle logs, got %#v", events)
	}
}

func TestCtrlDCanReplaceSecondCtrlCWithoutIncrementingSignalCount(t *testing.T) {
	server := newFakeShutdownServer()
	signals := make(chan os.Signal, 1)
	eof := make(chan struct{})
	result := make(chan ShutdownResult, 1)
	logs := &shutdownEvents{}
	go func() {
		result <- RunGracefulShutdown(context.Background(), server, ShutdownOptions{
			Interactive:   NewInteractiveOverride(true),
			SignalChannel: signals,
			EOFChannel:    eof,
			Timeout:       time.Second,
			Log:           logs.add,
		})
	}()

	signals <- os.Interrupt
	<-server.started
	close(eof)
	got := <-result
	if got.Cause != ShutdownStdinEOF || got.Phase != ShutdownForced {
		t.Fatalf("unexpected result %#v", got)
	}
	events := logs.snapshot()
	if len(events) < 2 || events[len(events)-1].SignalCount != 1 {
		t.Fatalf("EOF must not increment OS signal count: %#v", events)
	}
}

func TestEOFBeforeFirstSIGINTIsDormantAndDiscarded(t *testing.T) {
	server := newFakeShutdownServer()
	signals := make(chan os.Signal, 1)
	eof := make(chan struct{}, 1)
	eof <- struct{}{}
	result := make(chan ShutdownResult, 1)
	go func() {
		result <- RunGracefulShutdown(context.Background(), server, ShutdownOptions{
			Interactive:   NewInteractiveOverride(true),
			SignalChannel: signals,
			EOFChannel:    eof,
			Timeout:       time.Second,
		})
	}()

	select {
	case <-server.started:
		t.Fatal("pre-SIGINT EOF started graceful shutdown")
	case <-time.After(20 * time.Millisecond):
	}

	signals <- os.Interrupt
	<-server.started
	close(server.release)
	got := <-result
	if got.Phase != ShutdownClosed || got.Cause != ShutdownSIGINT || server.calls() != 0 {
		t.Fatalf("stale EOF should be ignored, got %#v; close calls=%d", got, server.calls())
	}
}

func TestTTYSIGTERMDoesNotArmEOF(t *testing.T) {
	server := newFakeShutdownServer()
	signals := make(chan os.Signal, 1)
	eof := make(chan struct{})
	close(eof)
	result := make(chan ShutdownResult, 1)
	logs := &shutdownEvents{}
	go func() {
		result <- RunGracefulShutdown(context.Background(), server, ShutdownOptions{
			Interactive:   NewInteractiveOverride(true),
			SignalChannel: signals,
			EOFChannel:    eof,
			Timeout:       time.Second,
			Log:           logs.add,
		})
	}()

	signals <- syscall.SIGTERM
	<-server.started
	close(server.release)
	got := <-result
	if got.Phase != ShutdownClosed || got.Cause != ShutdownSIGTERM || server.calls() != 0 {
		t.Fatalf("TTY SIGTERM should drain without EOF arming, got %#v", got)
	}
	for _, event := range logs.snapshot() {
		if event.Cause == ShutdownStdinEOF {
			t.Fatalf("EOF was observed after SIGTERM: %#v", event)
		}
	}
}

func TestNonInteractiveOneSignalGracefulAndEOFIsIgnored(t *testing.T) {
	server := newFakeShutdownServer()
	signals := make(chan os.Signal, 1)
	eof := make(chan struct{})
	close(eof)
	result := make(chan ShutdownResult, 1)
	go func() {
		result <- RunGracefulShutdown(context.Background(), server, ShutdownOptions{
			Interactive:   NewInteractiveOverride(false),
			SignalChannel: signals,
			EOFChannel:    eof,
			Timeout:       time.Second,
		})
	}()

	signals <- os.Interrupt
	<-server.started
	close(server.release)
	got := <-result
	if got.Phase != ShutdownClosed || got.Cause != ShutdownSIGINT || server.calls() != 0 {
		t.Fatalf("unexpected result %#v; close calls=%d", got, server.calls())
	}
}

func TestTimeoutAndShutdownErrorsForceClose(t *testing.T) {
	for name, setup := range map[string]func(*fakeShutdownServer, *ShutdownOptions){
		"timeout": func(_ *fakeShutdownServer, options *ShutdownOptions) {
			options.Timeout = 5 * time.Millisecond
		},
		"shutdown error": func(server *fakeShutdownServer, _ *ShutdownOptions) {
			server.shutdownErr = errors.New("drain failed")
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := newFakeShutdownServer()
			signals := make(chan os.Signal, 1)
			signals <- os.Interrupt
			options := ShutdownOptions{
				Interactive:     NewInteractiveOverride(false),
				SignalChannel:   signals,
				DisableStdinEOF: true,
				Timeout:         time.Second,
			}
			setup(server, &options)
			got := RunGracefulShutdown(context.Background(), server, options)
			if got.Phase != ShutdownForced || server.calls() != 1 || got.Err == nil {
				t.Fatalf("unexpected result %#v; close calls=%d", got, server.calls())
			}
		})
	}
}

func TestClosePanicAndLoggerSinkAreFailOpen(t *testing.T) {
	server := newFakeShutdownServer()
	server.panicOnClose = true
	signals := make(chan os.Signal, 2)
	signals <- os.Interrupt
	signals <- os.Interrupt
	transport := &MemoryTransport{}
	logger := NewLogger(Options{Transports: []Transport{transport}, Console: false})
	got := RunGracefulShutdown(context.Background(), server, ShutdownOptions{
		Interactive:     NewInteractiveOverride(true),
		SignalChannel:   signals,
		DisableStdinEOF: true,
		Timeout:         time.Second,
		Log:             LoggerShutdownLog(logger),
	})
	if got.Phase != ShutdownForced || got.Err == nil {
		t.Fatalf("expected recovered force failure, got %#v", got)
	}
	if len(transport.Records) < 2 {
		t.Fatalf("expected structured lifecycle records, got %d", len(transport.Records))
	}
}

func TestHTTPServerImplementsShutdownContract(t *testing.T) {
	var _ ShutdownServer = (*http.Server)(nil)
}

func TestSecondSignalForcesWhileFlushIsBlockedAndFlushRunsOnce(t *testing.T) {
	server := newFakeShutdownServer()
	signals := make(chan os.Signal, 2)
	flushStarted := make(chan struct{})
	flushRelease := make(chan struct{})
	var flushOnce sync.Once
	var flushCalls int
	var flushMu sync.Mutex
	result := make(chan ShutdownResult, 1)
	go func() {
		result <- RunGracefulShutdown(context.Background(), server, ShutdownOptions{
			Interactive:     NewInteractiveOverride(true),
			SignalChannel:   signals,
			DisableStdinEOF: true,
			Timeout:         25 * time.Millisecond,
			Flush: func(context.Context, ShutdownCause) error {
				flushMu.Lock()
				flushCalls++
				flushMu.Unlock()
				flushOnce.Do(func() { close(flushStarted) })
				<-flushRelease
				return nil
			},
		})
	}()

	signals <- os.Interrupt
	<-server.started
	close(server.release)
	<-flushStarted
	signals <- os.Interrupt
	got := <-result
	if got.Phase != ShutdownForced || got.Cause != ShutdownSIGINT {
		t.Fatalf("unexpected result %#v", got)
	}
	flushMu.Lock()
	calls := flushCalls
	flushMu.Unlock()
	if calls != 1 {
		t.Fatalf("flush ran %d times", calls)
	}
	close(flushRelease)
}
