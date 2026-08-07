package nextloggers

import (
	"context"
	"errors"
	"testing"
)

type fakeSpan struct {
	ctx         TraceContext
	status      int
	recorded    error
	ended       int
	panicStatus bool
	panicEnd    bool
}

func (span *fakeSpan) LogContext() TraceContext { return span.ctx }
func (span *fakeSpan) RecordError(err error)    { span.recorded = err }
func (span *fakeSpan) SetStatus(code int, _ string) {
	if span.panicStatus {
		panic("status unavailable")
	}
	span.status = code
}
func (span *fakeSpan) End() {
	if span.panicEnd {
		panic("end unavailable")
	}
	span.ended++
}

type fakeTracer struct{ span *fakeSpan }

func (tracer fakeTracer) Start(
	ctx context.Context,
	_ string,
	_ map[string]any,
) (context.Context, Span) {
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

func TestApplyContext(t *testing.T) {
	logger, transport := contextLogger()
	ctx := WithLogContext(context.Background(), TraceContext{
		TraceID:    "trace-1",
		SpanID:     "span-1",
		TraceFlags: 1,
		Fields:     map[string]any{"route": "/pay"},
		Tags:       []string{"request"},
	})
	if err := logger.InfoContext(ctx, "inside").Send(); err != nil {
		t.Fatal(err)
	}
	if len(transport.Records) != 1 {
		t.Fatalf("expected one record, got %d", len(transport.Records))
	}
	record := transport.Records[0]
	if record.TraceID != "trace-1" {
		t.Fatalf("unexpected trace ID: %q", record.TraceID)
	}
	if record.Fields["otel.span_id"] != "span-1" {
		t.Fatalf("span context not applied: %#v", record.Fields)
	}
	if record.Fields["route"] != "/pay" {
		t.Fatalf("request fields not applied: %#v", record.Fields)
	}
}

func TestWithSpanIgnoresTelemetryLifecyclePanics(t *testing.T) {
	logger, transport := contextLogger()
	span := &fakeSpan{
		ctx:         TraceContext{TraceID: "trace-resilient", SpanID: "span-resilient"},
		panicStatus: true,
		panicEnd:    true,
	}
	got, err := WithSpan(
		context.Background(), logger, fakeTracer{span}, "resilient", nil,
		func(context.Context, Span) (int, error) { return 9, nil },
	)
	if err != nil || got != 9 {
		t.Fatalf("telemetry panic replaced application result: value=%d err=%v", got, err)
	}
	if len(transport.Records) < 4 {
		t.Fatalf("expected lifecycle and OTEL bridge warning records, got %d", len(transport.Records))
	}
}

func TestWithSpan(t *testing.T) {
	logger, transport := contextLogger()
	span := &fakeSpan{ctx: TraceContext{TraceID: "trace-span", SpanID: "span-span"}}
	got, err := WithSpan(
		context.Background(),
		logger,
		fakeTracer{span},
		"operation",
		map[string]any{"component": "test"},
		func(ctx context.Context, _ Span) (int, error) {
			ambient, ok := LogContextFrom(ctx)
			if !ok || ambient.TraceID != "trace-span" {
				t.Fatalf("span context not propagated: %#v", ambient)
			}
			return 7, nil
		},
	)
	if err != nil || got != 7 || span.status != OtelStatusOK || span.ended != 1 {
		t.Fatalf("bad success: value=%d err=%v span=%#v", got, err, span)
	}
	if len(transport.Records) != 2 {
		t.Fatalf("expected start/end records, got %d", len(transport.Records))
	}

	boom := errors.New("boom")
	failureSpan := &fakeSpan{ctx: TraceContext{TraceID: "trace-error", SpanID: "span-error"}}
	_, err = WithSpan(
		context.Background(),
		logger,
		fakeTracer{failureSpan},
		"failure",
		nil,
		func(context.Context, Span) (int, error) { return 0, boom },
	)
	if !errors.Is(err, boom) || !errors.Is(failureSpan.recorded, boom) ||
		failureSpan.status != OtelStatusError || failureSpan.ended != 1 {
		t.Fatalf("bad error path: err=%v span=%#v", err, failureSpan)
	}
}
