package nextloggers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type fakeSpan struct {
	ctx       TraceContext
	recording bool
	status    int
	recorded  error
	ended     int
}

func (span *fakeSpan) LogContext() TraceContext     { return span.ctx }
func (span *fakeSpan) IsRecording() bool            { return span.recording }
func (span *fakeSpan) RecordError(err error)        { span.recorded = err }
func (span *fakeSpan) SetStatus(code int, _ string) { span.status = code }
func (span *fakeSpan) End()                         { span.ended++ }

type fakeTracer struct{ span *fakeSpan }

func (tracer fakeTracer) Start(ctx context.Context, _ string, _ map[string]any) (context.Context, Span) {
	return ctx, tracer.span
}

func contextLogger() (*Logger, *MemoryTransport) {
	transport := &MemoryTransport{}
	logger := NewLogger(Options{
		AppName:    "payments",
		MaxLevel:   Debug,
		Transports: []Transport{transport},
		Console:    false,
	})
	return logger, transport
}

func TestMergeAndApplyContext(t *testing.T) {
	outer := TraceContext{
		LoggedInUser: map[string]any{"id": "user-1", "role": "viewer"},
		Users:        []map[string]any{{"id": "outer"}},
		Fields:       map[string]any{"request": "outer", "keep": true},
		TraceID:      "trace-outer",
		TraceIDs:     []string{"trace-outer"},
		Tags:         []string{"outer"},
		Baggage:      map[string]string{"tenant": "one"},
	}
	inner := TraceContext{
		LoggedInUser: map[string]any{"role": "admin"},
		Users:        []map[string]any{{"id": "inner"}},
		Fields:       map[string]any{"request": "inner"},
		TraceID:      "trace-inner",
		TraceIDs:     []string{"trace-outer", "trace-inner"},
		SpanID:       "span-1",
		TraceFlags:   1,
		TraceState:   "vendor=value",
		RoutineID:    "checkout",
		Tags:         []string{"inner", "outer"},
		Baggage:      map[string]string{"region": "west"},
		HasRemote:    true,
	}

	mergedValue := MergeLogContext(outer, inner)
	if mergedValue.TraceID != "trace-inner" || mergedValue.LoggedInUser["role"] != "admin" {
		t.Fatalf("value-level merge failed: %#v", mergedValue)
	}

	ctx := WithLogContext(WithLogContext(context.Background(), outer), inner)
	merged, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("missing merged context")
	}
	if merged.LoggedInUser["id"] != "user-1" || merged.LoggedInUser["role"] != "admin" {
		t.Fatalf("bad user merge: %#v", merged.LoggedInUser)
	}
	if len(merged.Users) != 2 || merged.Fields["request"] != "inner" || merged.Fields["keep"] != true {
		t.Fatalf("bad collection merge: %#v", merged)
	}
	if merged.TraceID != "trace-inner" || len(merged.TraceIDs) != 2 || len(merged.Tags) != 2 {
		t.Fatalf("bad trace/tag merge: %#v", merged)
	}

	logger, transport := contextLogger()
	if err := logger.InfoContext(ctx, "inside").Send(); err != nil {
		t.Fatal(err)
	}
	record := transport.Records[0]
	if record.TraceID != "trace-inner" || record.Fields["otel.span_id"] != "span-1" || record.RoutineID != "checkout" {
		t.Fatalf("context not applied: %#v", record)
	}
	if record.LoggedInUser["role"] != "admin" || len(record.Users) != 2 {
		t.Fatalf("users not applied: %#v", record)
	}
	if remote, exists := record.Fields["otel.remote"]; !exists || remote != false {
		t.Fatalf("remote span marker missing: %#v", record.Fields)
	}

	merged.Fields["request"] = "mutated"
	again, _ := LogContextFrom(ctx)
	if again.Fields["request"] != "inner" {
		t.Fatal("context snapshot leaked mutable state")
	}
}

func TestContextSnapshotMergeAndApply(t *testing.T) {
	user := map[string]any{"id": "u1"}
	base := WithLogContext(context.Background(), LogContext{
		LoggedInUser: user,
		TraceID:      "trace-1",
		Fields:       map[string]any{"request.id": "r1"},
		Tags:         []string{"http"},
	})
	user["id"] = "mutated"
	ctx := WithMergedLogContext(base, LogContext{
		LoggedInUser: map[string]any{"role": "admin"},
		SpanID:       "span-1",
		TraceIDs:     []string{"trace-1", "trace-2"},
		RoutineID:    "handler",
		Context:      []any{"request-context"},
		Meta:         []any{"request-meta"},
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
	if len(record.Context) != 1 || record.Context[0] != "request-context" {
		t.Fatalf("record context missing: %#v", record.Context)
	}
	if len(record.Meta) != 1 || record.Meta[0] != "request-meta" {
		t.Fatalf("record metadata missing: %#v", record.Meta)
	}
}

func TestContextGoroutineIsolation(t *testing.T) {
	const workers = 100
	var wait sync.WaitGroup
	errorsFound := make(chan error, workers)
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			expected := fmt.Sprintf("trace-%d", index)
			ctx := WithLogContext(context.Background(), LogContext{
				LoggedInUser: map[string]any{"id": index},
				TraceID:      expected,
				Fields:       map[string]any{"index": index},
			})
			got, ok := LogContextFrom(ctx)
			if !ok || got.TraceID != expected || got.LoggedInUser["id"] != index || got.Fields["index"] != index {
				errorsFound <- fmt.Errorf("worker %d observed %#v", index, got)
			}
		}(index)
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
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
	cleared := WithLogContext(base, LogContext{TraceFlags: 0, TraceFlagsSet: true})
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
