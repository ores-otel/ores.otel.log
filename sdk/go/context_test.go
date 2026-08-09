package nextloggers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestContextSnapshotMergeAndApply(t *testing.T) {
	user := map[string]any{"id": "u1"}
	base := WithLogContext(context.Background(), LogContext{
		LoggedInUser: user,
		TraceID:      "trace-1",
		Fields:       map[string]any{"request.id": "r1"},
		Tags:         []string{"http"},
	})
	user["id"] = "mutated"
	ctx := MergeLogContext(base, LogContext{
		LoggedInUser: map[string]any{"role": "admin"},
		SpanID:       "span-1",
		TraceIDs:     []string{"trace-1", "trace-2"},
		RoutineID:    "handler",
		Context:      []any{"request-context"},
	})

	got, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("log context was not installed")
	}
	if got.LoggedInUser["id"] != "u1" || got.LoggedInUser["role"] != "admin" {
		t.Fatalf("unexpected user context: %#v", got.LoggedInUser)
	}
	if len(got.TraceIDs) != 2 || got.TraceIDs[0] != "trace-1" || got.TraceIDs[1] != "trace-2" {
		t.Fatalf("trace IDs were not de-duplicated: %#v", got.TraceIDs)
	}

	transport := &MemoryTransport{}
	logger := NewLogger(Options{Transports: []Transport{transport}, Console: false})
	if err := logger.InfoContext(ctx, "hello").Send(); err != nil {
		t.Fatal(err)
	}
	if len(transport.Records) != 1 {
		t.Fatalf("expected one record, got %d", len(transport.Records))
	}
	record := transport.Records[0]
	if record.LoggedInUser["id"] != "u1" || record.LoggedInUser["role"] != "admin" {
		t.Fatalf("logged-in user context missing: %#v", record.LoggedInUser)
	}
	if record.Fields["otel.span_id"] != "span-1" || record.Fields["request.id"] != "r1" {
		t.Fatalf("trace/request fields missing: %#v", record.Fields)
	}
	if record.TraceID != "trace-1" || record.RoutineID != "handler" {
		t.Fatalf("trace/routine context missing: %#v", record)
	}
}

func TestContextGoroutineIsolation(t *testing.T) {
	const workers = 100
	var wait sync.WaitGroup
	errors := make(chan error, workers)
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			ctx := WithLoggedInUser(
				context.Background(),
				map[string]any{"id": index},
			)
			got, ok := LogContextFrom(ctx)
			if !ok || got.LoggedInUser["id"] != index {
				errors <- fmt.Errorf("worker %d observed %#v", index, got)
			}
		}(index)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}

func TestRequestMiddleware(t *testing.T) {
	handler := LogContextMiddleware(func(*http.Request) LogContext {
		return LogContext{LoggedInUser: map[string]any{"id": "request-user"}}
	})(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		got, ok := LogContextFromRequest(request)
		if !ok || got.LoggedInUser["id"] != "request-user" {
			t.Fatalf("missing request context: %#v", got)
		}
		writer.WriteHeader(http.StatusNoContent)
	}))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected status %d", response.Code)
	}
}

func TestTraceFlagsPreserveExplicitZero(t *testing.T) {
	base := WithTraceFlags(context.Background(), 1)
	cleared := MergeLogContext(base, LogContext{TraceFlags: 0, TraceFlagsSet: true})
	got, ok := LogContextFrom(cleared)
	if !ok || !got.TraceFlagsSet || got.TraceFlags != 0 {
		t.Fatalf("explicit zero trace flags were not preserved: %#v", got)
	}

	transport := &MemoryTransport{}
	logger := NewLogger(Options{Transports: []Transport{transport}, Console: false})
	if err := logger.InfoContext(cleared, "zero flags").Send(); err != nil {
		t.Fatal(err)
	}
	value, exists := transport.Records[0].Fields["otel.trace_flags"]
	traceFlags, numeric := value.(float64)
	if !exists || !numeric || traceFlags != 0 {
		t.Fatalf("explicit zero trace flags missing from record: %#v", transport.Records[0].Fields)
	}
}
