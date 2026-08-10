package nextloggers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"
)

type fakeAddr string

func (a fakeAddr) Network() string { return string(a) }
func (a fakeAddr) String() string  { return string(a) }

type fakeListener struct{}

func (fakeListener) Accept() (net.Conn, error) { return nil, errors.New("unused") }
func (fakeListener) Close() error              { return nil }
func (fakeListener) Addr() net.Addr            { return fakeAddr("fake") }

type fakeHTTPServer struct {
	mu        sync.Mutex
	serveDone chan struct{}
	drainDone chan struct{}
	shutdowns int
	closes    int
}

func newFakeHTTPServer() *fakeHTTPServer {
	return &fakeHTTPServer{serveDone: make(chan struct{}), drainDone: make(chan struct{})}
}
func (s *fakeHTTPServer) Serve(net.Listener) error { <-s.serveDone; return http.ErrServerClosed }
func (s *fakeHTTPServer) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.shutdowns++
	s.mu.Unlock()
	select {
	case <-s.drainDone:
		close(s.serveDone)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *fakeHTTPServer) Close() error {
	s.mu.Lock()
	s.closes++
	s.mu.Unlock()
	select {
	case <-s.serveDone:
	default:
		close(s.serveDone)
	}
	return nil
}

func TestContextCaptureAndEvent(t *testing.T) {
	ctx := WithLogContext(context.Background(), LogContext{
		Fields:       map[string]any{"request.id": "r1"},
		LoggedInUser: map[string]any{"id": "u1"},
		TraceID:      "trace-1",
		Tags:         []string{"api"},
	})
	captured := CaptureLogContext(ctx)
	captured.Fields["request.id"] = "mutated"
	current, ok := LogContextFrom(ctx)
	if !ok || current.Fields["request.id"] != "r1" {
		t.Fatalf("context snapshot leaked mutation: %#v", current)
	}
	logger := NewLogger(Options{Console: false})
	event := logger.InfoContext(ctx, "hello")
	if event.Fields["request.id"] != "r1" || event.LoggedInUser["id"] != "u1" || event.TraceID != "trace-1" {
		t.Fatalf("context not applied: %#v", event)
	}
}

func TestSecondSignalForces(t *testing.T) {
	server := newFakeHTTPServer()
	sigs := make(chan os.Signal, 2)
	phases := make(chan ShutdownPhase, 4)
	interactive := true
	result := make(chan error, 1)
	go func() {
		result <- ServeHTTPWithShutdown(context.Background(), server, fakeListener{}, HTTPShutdownOptions{
			GracePeriod:   time.Second,
			Interactive:   &interactive,
			SignalChannel: sigs,
			Observer:      func(event ShutdownEvent) { phases <- event.Phase },
		})
	}()
	sigs <- os.Interrupt
	select {
	case p := <-phases:
		if p != ShutdownDraining {
			t.Fatalf("phase=%s", p)
		}
	case <-time.After(time.Second):
		t.Fatal("no drain")
	}
	sigs <- os.Interrupt
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("force returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("no forced completion")
	}
	server.mu.Lock()
	shutdowns, closes := server.shutdowns, server.closes
	server.mu.Unlock()
	if shutdowns != 1 || closes != 1 {
		t.Fatalf("shutdowns=%d closes=%d", shutdowns, closes)
	}
}

func TestOneSignalCanDrain(t *testing.T) {
	server := newFakeHTTPServer()
	sigs := make(chan os.Signal, 1)
	interactive := false
	result := make(chan error, 1)
	go func() {
		result <- ServeHTTPWithShutdown(context.Background(), server, fakeListener{}, HTTPShutdownOptions{
			GracePeriod:   time.Second,
			Interactive:   &interactive,
			SignalChannel: sigs,
		})
	}()
	sigs <- os.Interrupt
	time.Sleep(10 * time.Millisecond)
	close(server.drainDone)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("graceful returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("no graceful completion")
	}
	server.mu.Lock()
	closes := server.closes
	server.mu.Unlock()
	if closes != 0 {
		t.Fatalf("force close called during graceful drain: %d", closes)
	}
}
