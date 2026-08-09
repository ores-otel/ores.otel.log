package nextloggers

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func adversarialLogger(transports ...Transport) (*Logger, *MemoryTransport) {
	memory := &MemoryTransport{}
	all := []Transport{memory}
	all = append(all, transports...)
	return NewLogger(Options{
		AppName:    "adversarial",
		MaxLevel:   Trace,
		Transports: all,
		Console:    false,
	}), memory
}

func TestLogContextSnapshotIsolation(t *testing.T) {
	original := TraceContext{
		TraceID: "trace-original",
		SpanID:  "span-original",
		Baggage: map[string]string{"tenant": "acme"},
		Fields:  map[string]any{"route": "/pay"},
		Tags:    []string{"request"},
	}
	ctx := WithLogContext(context.Background(), original)
	original.TraceID = "mutated"
	original.Baggage["tenant"] = "mutated"
	original.Fields["route"] = "/mutated"
	original.Tags[0] = "mutated"

	stored, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("context missing")
	}
	if stored.TraceID != "trace-original" || stored.Baggage["tenant"] != "acme" ||
		stored.Fields["route"] != "/pay" || stored.Tags[0] != "request" {
		t.Fatalf("stored context changed with caller input: %#v", stored)
	}

	stored.Baggage["tenant"] = "second mutation"
	stored.Fields["route"] = "/second"
	stored.Tags[0] = "second"
	again, _ := LogContextFrom(ctx)
	if again.Baggage["tenant"] != "acme" || again.Fields["route"] != "/pay" ||
		again.Tags[0] != "request" {
		t.Fatalf("returned context was not cloned: %#v", again)
	}
}

func TestNestedLogContextsDoNotLeak(t *testing.T) {
	parent := WithLogContext(context.Background(), TraceContext{TraceID: "parent"})
	child := WithLogContext(parent, TraceContext{TraceID: "child"})
	parentValue, _ := LogContextFrom(parent)
	childValue, _ := LogContextFrom(child)
	if parentValue.TraceID != "parent" || childValue.TraceID != "child" {
		t.Fatalf("nested contexts leaked: parent=%#v child=%#v", parentValue, childValue)
	}
	if _, ok := LogContextFrom(context.Background()); ok {
		t.Fatal("background context unexpectedly contains logging state")
	}
}

func TestWithLogContextAcceptsNilParent(t *testing.T) {
	ctx := WithLogContext(nil, TraceContext{TraceID: "trace-nil-parent"})
	value, ok := LogContextFrom(ctx)
	if !ok || value.TraceID != "trace-nil-parent" {
		t.Fatalf("nil parent was not normalized: %#v %v", value, ok)
	}
	if _, ok := LogContextFrom(nil); ok {
		t.Fatal("nil lookup unexpectedly returned context")
	}
}

func TestExplicitEventTraceRemainsPrimary(t *testing.T) {
	logger, memory := adversarialLogger()
	ctx := WithLogContext(context.Background(), TraceContext{
		TraceID: "trace-ambient",
		SpanID:  "span-ambient",
	})
	if err := logger.Info("inside").AddTrace("trace-explicit").ApplyContext(ctx).Send(); err != nil {
		t.Fatal(err)
	}
	record := memory.Records[0]
	if record.TraceID != "trace-explicit" {
		t.Fatalf("ambient trace replaced explicit trace: %#v", record)
	}
	if len(record.TraceIDs) != 2 || record.TraceIDs[0] != "trace-explicit" ||
		record.TraceIDs[1] != "trace-ambient" {
		t.Fatalf("trace set is incomplete or reordered: %#v", record.TraceIDs)
	}
}

func TestContextMethodsCoverEveryLevel(t *testing.T) {
	logger, memory := adversarialLogger()
	ctx := WithLogContext(context.Background(), TraceContext{TraceID: "trace-levels"})
	events := []*Event{
		logger.TraceContext(ctx, "trace"),
		logger.DebugContext(ctx, "debug"),
		logger.InfoContext(ctx, "info"),
		logger.WarnContext(ctx, "warn"),
		logger.ErrorContext(ctx, "error"),
		logger.FatalContext(ctx, "fatal"),
	}
	for _, event := range events {
		if err := event.Send(); err != nil {
			t.Fatal(err)
		}
	}
	got := make([]Level, 0, len(memory.Records))
	for _, record := range memory.Records {
		got = append(got, record.Level)
		if record.TraceID != "trace-levels" {
			t.Fatalf("context missing from level %s: %#v", record.Level, record)
		}
	}
	want := []Level{Trace, Debug, Info, Warn, Error, Fatal}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("levels differ: got=%v want=%v", got, want)
	}
}

func TestConcurrentContextsNeverCrossContaminate(t *testing.T) {
	logger, memory := adversarialLogger()
	const count = 100
	var wait sync.WaitGroup
	wait.Add(count)
	for index := 0; index < count; index++ {
		index := index
		go func() {
			defer wait.Done()
			traceID := fmt.Sprintf("trace-%03d", index)
			message := fmt.Sprintf("message-%03d", index)
			ctx := WithLogContext(context.Background(), TraceContext{
				TraceID: traceID,
				SpanID:  fmt.Sprintf("span-%03d", index),
			})
			if err := logger.InfoContext(ctx, message).Send(); err != nil {
				t.Errorf("send failed: %v", err)
			}
		}()
	}
	wait.Wait()
	if len(memory.Records) != count {
		t.Fatalf("record count=%d want=%d", len(memory.Records), count)
	}
	for _, record := range memory.Records {
		var index int
		if _, err := fmt.Sscanf(record.Message, "message-%03d", &index); err != nil {
			t.Fatalf("invalid message %q: %v", record.Message, err)
		}
		wantTrace := fmt.Sprintf("trace-%03d", index)
		wantSpan := fmt.Sprintf("span-%03d", index)
		if record.TraceID != wantTrace || record.Fields["otel.span_id"] != wantSpan {
			t.Fatalf("context contamination: %#v", record)
		}
	}
}

type adversarialSpan struct {
	ctx          TraceContext
	status       int
	description  string
	recorded     error
	ended        int
	panicContext bool
	panicRecord  bool
	panicStatus  bool
	panicEnd     bool
}

func (span *adversarialSpan) LogContext() TraceContext {
	if span.panicContext {
		panic("context unavailable")
	}
	return span.ctx
}
func (span *adversarialSpan) IsRecording() bool { return true }
func (span *adversarialSpan) RecordError(err error) {
	if span.panicRecord {
		panic("record unavailable")
	}
	span.recorded = err
}
func (span *adversarialSpan) SetStatus(code int, description string) {
	if span.panicStatus {
		panic("status unavailable")
	}
	span.status = code
	span.description = description
}
func (span *adversarialSpan) End() {
	if span.panicEnd {
		panic("end unavailable")
	}
	span.ended++
}

type adversarialTracer struct {
	span       Span
	panicStart bool
	seen       map[string]any
}

func (tracer *adversarialTracer) Start(
	ctx context.Context,
	_ string,
	attributes map[string]any,
) (context.Context, Span) {
	if tracer.panicStart {
		panic("tracer unavailable")
	}
	tracer.seen = attributes
	return ctx, tracer.span
}

func TestTracerStartPanicFallsBackToNoopSpan(t *testing.T) {
	logger, memory := adversarialLogger()
	got, err := WithSpan(
		context.Background(),
		logger,
		&adversarialTracer{panicStart: true},
		"fallback",
		map[string]any{"mutable": "original"},
		func(_ context.Context, span Span) (int, error) {
			if span == nil {
				t.Fatal("fallback span is nil")
			}
			return 17, nil
		},
	)
	if err != nil || got != 17 {
		t.Fatalf("start failure replaced application result: got=%d err=%v", got, err)
	}
	if !containsBridgeOperation(memory.Records, "start span") {
		t.Fatalf("start failure was not logged: %#v", memory.Records)
	}
}

func TestNilSpanFallsBackToNoopSpan(t *testing.T) {
	logger, memory := adversarialLogger()
	got, err := WithSpan(
		context.Background(),
		logger,
		&adversarialTracer{span: nil},
		"nil-span",
		nil,
		func(_ context.Context, span Span) (string, error) {
			if span == nil {
				t.Fatal("nil span reached callback")
			}
			return "ok", nil
		},
	)
	if err != nil || got != "ok" {
		t.Fatalf("nil span fallback failed: got=%q err=%v", got, err)
	}
	if !containsBridgeOperation(memory.Records, "start span") {
		t.Fatalf("nil span was not diagnosed: %#v", memory.Records)
	}
}

func TestBrokenSpanContextFailsOpen(t *testing.T) {
	logger, memory := adversarialLogger()
	span := &adversarialSpan{panicContext: true}
	got, err := WithSpan(
		context.Background(), logger, &adversarialTracer{span: span}, "broken-context", nil,
		func(ctx context.Context, _ Span) (int, error) {
			value, ok := LogContextFrom(ctx)
			if !ok || value.TraceID != "" {
				t.Fatalf("expected empty fallback context: %#v %v", value, ok)
			}
			return 19, nil
		},
	)
	if err != nil || got != 19 {
		t.Fatalf("broken context replaced result: got=%d err=%v", got, err)
	}
	if !containsBridgeOperation(memory.Records, "read span context") {
		t.Fatalf("context failure was not logged: %#v", memory.Records)
	}
}

func TestCallbackErrorIdentityAndLifecycle(t *testing.T) {
	logger, _ := adversarialLogger()
	span := &adversarialSpan{ctx: TraceContext{TraceID: "trace-error"}}
	expected := errors.New("declined")
	_, err := WithSpan(
		context.Background(), logger, &adversarialTracer{span: span}, "error", nil,
		func(context.Context, Span) (int, error) { return 0, expected },
	)
	if !errors.Is(err, expected) || !errors.Is(span.recorded, expected) {
		t.Fatalf("error identity lost: returned=%v recorded=%v", err, span.recorded)
	}
	if span.status != OtelStatusError || span.description != "declined" || span.ended != 1 {
		t.Fatalf("bad error lifecycle: %#v", span)
	}
}

func TestCallbackPanicIdentityAndLifecycle(t *testing.T) {
	logger, _ := adversarialLogger()
	span := &adversarialSpan{ctx: TraceContext{TraceID: "trace-panic"}}
	expected := &struct{ message string }{"panic-value"}
	defer func() {
		recovered := recover()
		if recovered != expected {
			t.Fatalf("panic identity lost: got=%#v want=%#v", recovered, expected)
		}
		if span.status != OtelStatusError || span.ended != 1 || span.recorded == nil {
			t.Fatalf("panic lifecycle incomplete: %#v", span)
		}
	}()
	_, _ = WithSpan(
		context.Background(), logger, &adversarialTracer{span: span}, "panic", nil,
		func(context.Context, Span) (int, error) { panic(expected) },
	)
	t.Fatal("panic was not re-raised")
}

type alwaysFailTransport struct{ err error }

func (transport alwaysFailTransport) Write(LogRecord) error { return transport.err }

func TestLifecycleLoggingFailuresDoNotReplaceApplicationResult(t *testing.T) {
	expectedTransportError := errors.New("sink unavailable")
	logger, _ := adversarialLogger(alwaysFailTransport{err: expectedTransportError})
	span := &adversarialSpan{
		ctx:         TraceContext{TraceID: "trace-resilient"},
		panicRecord: true,
		panicStatus: true,
		panicEnd:    true,
	}
	got, err := WithSpan(
		context.Background(), logger, &adversarialTracer{span: span}, "resilient", nil,
		func(context.Context, Span) (int, error) { return 23, nil },
	)
	if err != nil || got != 23 {
		t.Fatalf("telemetry failure replaced result: got=%d err=%v", got, err)
	}
}

func TestCanceledContextRemainsCanceledInsideSpan(t *testing.T) {
	base, cancel := context.WithCancel(context.Background())
	cancel()
	logger, _ := adversarialLogger()
	span := &adversarialSpan{}
	_, err := WithSpan(
		base, logger, &adversarialTracer{span: span}, "canceled", nil,
		func(ctx context.Context, _ Span) (int, error) {
			if !errors.Is(ctx.Err(), context.Canceled) {
				t.Fatalf("cancellation was lost: %v", ctx.Err())
			}
			return 29, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
}

func TestWithSpanInputValidation(t *testing.T) {
	logger, _ := adversarialLogger()
	span := &adversarialSpan{}
	tracer := &adversarialTracer{span: span}
	if _, err := WithSpan[int](context.Background(), nil, tracer, "x", nil, func(context.Context, Span) (int, error) { return 0, nil }); err == nil {
		t.Fatal("nil logger accepted")
	}
	if _, err := WithSpan[int](context.Background(), logger, nil, "x", nil, func(context.Context, Span) (int, error) { return 0, nil }); err == nil {
		t.Fatal("nil tracer accepted")
	}
	if _, err := WithSpan[int](context.Background(), logger, tracer, "x", nil, nil); err == nil {
		t.Fatal("nil callback accepted")
	}
}

func containsBridgeOperation(records []LogRecord, operation string) bool {
	for _, record := range records {
		if record.Fields["otel.bridge_operation"] == operation {
			return true
		}
	}
	return false
}
