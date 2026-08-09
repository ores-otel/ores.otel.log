package nextloggers

import (
	"context"
	"errors"
	"testing"
)

func TestWithSpanKeepsSampledOutCorrelation(t *testing.T) {
	logger, transport := contextLogger()
	span := &fakeSpan{ctx: TraceContext{TraceID: "0123456789abcdef0123456789abcdef", SpanID: "0123456789abcdef"}, recording: false}
	got, err := WithSpan(context.Background(), logger, fakeTracer{span}, "sampled-out", nil, func(ctx context.Context, _ Span) (int, error) {
		ambient, ok := LogContextFrom(ctx)
		if !ok || ambient.TraceID != span.ctx.TraceID || ambient.SpanID != span.ctx.SpanID {
			t.Fatalf("sampled-out correlation missing: %#v", ambient)
		}
		return 7, nil
	})
	if err != nil || got != 7 || span.status != 0 || span.recorded != nil || span.ended != 1 {
		t.Fatalf("bad sampled-out path: value=%d err=%v span=%#v", got, err, span)
	}
	if len(transport.Records) != 2 || transport.Records[0].TraceID != span.ctx.TraceID {
		t.Fatalf("bridge logs not correlated: %#v", transport.Records)
	}
}

func TestWithSpanMutatesRecordingSpanOnly(t *testing.T) {
	logger, _ := contextLogger()
	boom := errors.New("boom")
	span := &fakeSpan{ctx: TraceContext{TraceID: "trace-error", SpanID: "span-error"}, recording: true}
	_, err := WithSpan(context.Background(), logger, fakeTracer{span}, "failure", nil, func(context.Context, Span) (int, error) { return 0, boom })
	if !errors.Is(err, boom) || !errors.Is(span.recorded, boom) || span.status != OtelStatusError || span.ended != 1 {
		t.Fatalf("bad recording error path: err=%v span=%#v", err, span)
	}
}
