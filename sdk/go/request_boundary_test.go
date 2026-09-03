package nextloggers

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func boundaryTestContext(slot int) RequestContext {
	return RequestContext{
		RequestID:      fmt.Sprintf("request-%d", slot),
		LoggedInUserID: fmt.Sprintf("user-%d", slot),
		TenantID:       fmt.Sprintf("tenant-%d", slot),
		TraceID:        fmt.Sprintf("%032x", slot),
	}
}

func boundaryForSlot(slot int) RequestBoundary {
	switch slot % 5 {
	case 0:
		return HTTPRequestBoundary("handler", fmt.Sprintf("http-%d", slot))
	case 1:
		return TCPConnectionBoundary("accept", fmt.Sprintf("connection-%d", slot), "tcp.accept")
	case 2:
		return TCPMessageBoundary("decode", fmt.Sprintf("connection-%d", slot), fmt.Sprintf("message-%d", slot), "tcp.decode")
	case 3:
		return WebSocketSessionBoundary("upgrade", fmt.Sprintf("session-%d", slot), "websocket.upgrade")
	case 4:
		return WebSocketMessageBoundary("dispatch", fmt.Sprintf("session-%d", slot), fmt.Sprintf("message-%d", slot), "websocket.dispatch")
	default:
		panic("unreachable slot")
	}
}

func TestRequestBoundariesKeepConcurrentFailuresIsolated(t *testing.T) {
	t.Parallel()
	const count = 64
	type report struct {
		requestID string
		transport RequestTransport
		scope     RequestScope
	}
	reports := make([]report, 0, count)
	var reportsMu sync.Mutex
	results := make([]RequestBoundaryResult[int], count)

	var group sync.WaitGroup
	group.Add(count)
	for slot := 0; slot < count; slot++ {
		slot := slot
		go func() {
			defer group.Done()
			results[slot] = RunWithRequestBoundary(
				context.Background(),
				boundaryTestContext(slot),
				boundaryForSlot(slot),
				func(ctx context.Context) (int, error) {
					time.Sleep(time.Duration((count-slot)%7) * time.Millisecond)
					requestID, ok := RequestIDFrom(ctx)
					if !ok || requestID != fmt.Sprintf("request-%d", slot) {
						return 0, fmt.Errorf("wrong request context: %q", requestID)
					}
					return 0, fmt.Errorf("failure-%d", slot)
				},
				RequestBoundaryOptions{
					Now: func() time.Time { return time.UnixMilli(int64(1_000 + slot)) },
					Report: func(ctx context.Context, failure RequestBoundaryFailure) {
						requestID, ok := RequestIDFrom(ctx)
						if !ok || requestID != fmt.Sprintf("request-%d", slot) {
							panic(fmt.Sprintf("reporter saw wrong request: %q", requestID))
						}
						reportsMu.Lock()
						reports = append(reports, report{
							requestID: failure.Context.RequestID,
							transport: failure.Boundary.Transport,
							scope:     failure.Boundary.Scope,
						})
						reportsMu.Unlock()
					},
				},
			)
		}()
	}
	group.Wait()

	if len(reports) != count {
		t.Fatalf("expected %d reports, got %d", count, len(reports))
	}
	for slot, result := range results {
		if result.OK() || result.Failure == nil {
			t.Fatalf("slot %d unexpectedly succeeded", slot)
		}
		failure := result.Failure
		if failure.Kind != RequestFailureException {
			t.Fatalf("slot %d: unexpected kind %q", slot, failure.Kind)
		}
		if got, want := failure.Context.RequestID, fmt.Sprintf("request-%d", slot); got != want {
			t.Fatalf("slot %d: request ID = %q, want %q", slot, got, want)
		}
		if got, want := failure.ObservedAtUnixMS, int64(1_000+slot); got != want {
			t.Fatalf("slot %d: observed time = %d, want %d", slot, got, want)
		}
		if failure.Err == nil || failure.Err.Error() != fmt.Sprintf("failure-%d", slot) {
			t.Fatalf("slot %d: wrong error: %v", slot, failure.Err)
		}
	}
}

func TestRequestBoundaryRecoversOperationAndReporterPanics(t *testing.T) {
	t.Parallel()
	result := RunWithRequestBoundary(
		context.Background(),
		boundaryTestContext(70),
		WebSocketMessageBoundary("dispatch", "session-70", "message-70", "websocket.dispatch"),
		func(context.Context) (int, error) {
			panic("handler panic")
		},
		RequestBoundaryOptions{
			Report: func(context.Context, RequestBoundaryFailure) {
				panic("telemetry panic")
			},
		},
	)

	if result.Failure == nil || result.Failure.Kind != RequestFailurePanic {
		t.Fatalf("expected recovered panic, got %#v", result.Failure)
	}
	if result.Failure.Recovered != "handler panic" {
		t.Fatalf("wrong recovered value: %#v", result.Failure.Recovered)
	}
	if result.Failure.Context.RequestID != "request-70" {
		t.Fatalf("panic lost request context: %#v", result.Failure.Context)
	}
}

func TestRequestBoundaryClassifiesCancellationTimeoutAndDisconnect(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		want RequestFailureKind
	}{
		{name: "timeout", err: context.DeadlineExceeded, want: RequestFailureTimeout},
		{name: "cancelled", err: context.Canceled, want: RequestFailureCancelled},
		{name: "disconnect", err: fmt.Errorf("socket closed: %w", ErrPeerDisconnected), want: RequestFailureDisconnect},
	}

	for index, testCase := range tests {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			result := RunWithRequestBoundary(
				context.Background(),
				boundaryTestContext(80+index),
				TCPMessageBoundary("read", "connection", "message", "tcp.read"),
				func(context.Context) (int, error) { return 0, testCase.err },
				RequestBoundaryOptions{},
			)
			if result.Failure == nil || result.Failure.Kind != testCase.want {
				t.Fatalf("kind = %#v, want %q", result.Failure, testCase.want)
			}
		})
	}
}

func TestRequestBoundaryRestoresExplicitParentContext(t *testing.T) {
	t.Parallel()
	parent := WithRequestContext(context.Background(), boundaryTestContext(90))
	result := RunWithRequestBoundary(
		parent,
		boundaryTestContext(91),
		HTTPRequestBoundary("handler", "http.handler"),
		func(ctx context.Context) (string, error) {
			requestID, _ := RequestIDFrom(ctx)
			return requestID, nil
		},
		RequestBoundaryOptions{},
	)
	if !result.OK() || result.Value != "request-91" {
		t.Fatalf("unexpected result: %#v", result)
	}
	requestID, ok := RequestIDFrom(parent)
	if !ok || requestID != "request-90" {
		t.Fatalf("parent context changed: %q", requestID)
	}
}

func TestInvalidBoundaryFailsWithoutRunningOperation(t *testing.T) {
	t.Parallel()
	ran := false
	result := RunWithRequestBoundary(
		context.Background(),
		boundaryTestContext(100),
		RequestBoundary{Transport: RequestTransportHTTP, Scope: RequestScopeMessage, Phase: "handler"},
		func(context.Context) (int, error) {
			ran = true
			return 1, nil
		},
		RequestBoundaryOptions{},
	)
	if ran {
		t.Fatal("invalid boundary executed the operation")
	}
	if result.Failure == nil || !errors.Is(result.Failure.Err, result.Failure.Err) {
		t.Fatalf("expected validation failure, got %#v", result.Failure)
	}
	if result.Failure.Context.RequestID != "request-100" {
		t.Fatalf("validation failure lost request context: %#v", result.Failure.Context)
	}
}
