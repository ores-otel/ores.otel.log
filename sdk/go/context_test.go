package nextloggers

import (
	"context"
	"fmt"
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
	logger := NewLogger(Options{AppName: "payments", MaxLevel: Debug, Transports: []Transport{transport}, Console: false})
	return logger, transport
}

func TestMergeAndApplyContext(t *testing.T) {
	outer := TraceContext{
		LoggedInUser: map[string]any{"id": "user-1", "role": "viewer"},
		Users:        []map[string]any{{"id": "outer"}},
		Fields:       map[string]any{"request": "outer", "keep": true},
		TraceID:      "trace-outer", TraceIDs: []string{"trace-outer"},
		Tags: []string{"outer"}, Baggage: map[string]string{"tenant": "one"},
	}
	inner := TraceContext{
		LoggedInUser: map[string]any{"role": "admin"},
		Users:        []map[string]any{{"id": "inner"}},
		Fields:       map[string]any{"request": "inner"},
		TraceID:      "trace-inner", TraceIDs: []string{"trace-outer", "trace-inner"},
		SpanID: "span-1", TraceFlags: 1, TraceState: "vendor=value",
		RoutineID: "checkout", Tags: []string{"inner", "outer"},
		Baggage: map[string]string{"region": "west"}, HasRemote: true,
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
	merged.Fields["request"] = "mutated"
	again, _ := LogContextFrom(ctx)
	if again.Fields["request"] != "inner" {
		t.Fatal("context snapshot leaked mutable state")
	}
}

func TestContextIsolatedAcrossGoroutines(t *testing.T) {
	const count = 64
	var wait sync.WaitGroup
	errorsFound := make(chan error, count)
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			expected := fmt.Sprintf("trace-%d", index)
			ctx := WithLogContext(context.Background(), TraceContext{TraceID: expected, Fields: map[string]any{"index": index}})
			value, ok := LogContextFrom(ctx)
			if !ok || value.TraceID != expected || value.Fields["index"] != index {
				errorsFound <- fmt.Errorf("goroutine %d observed %#v", index, value)
			}
		}(index)
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Error(err)
	}
}
