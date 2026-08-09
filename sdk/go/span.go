package nextloggers

import (
	"context"
	"fmt"
	"time"
)

// Span and Tracer are structural adapters around application-owned OTEL
// objects. next-loggers never imports, installs, or shuts down an OTEL SDK.
type Span interface {
	LogContext() TraceContext
	IsRecording() bool
	RecordError(error)
	SetStatus(code int, description string)
	End()
}

type Tracer interface {
	Start(context.Context, string, map[string]any) (context.Context, Span)
}

const (
	OtelStatusOK    = 1
	OtelStatusError = 2
)

type noopSpan struct{}

func (noopSpan) LogContext() TraceContext { return TraceContext{} }
func (noopSpan) IsRecording() bool        { return false }
func (noopSpan) RecordError(error)        {}
func (noopSpan) SetStatus(int, string)    {}
func (noopSpan) End()                     {}

func sendBridgeLog(event *Event) {
	if event == nil {
		return
	}
	defer func() { _ = recover() }()
	_ = event.Send()
}

func safeSpanCall(ctx context.Context, logger *Logger, operation string, callback func()) {
	defer func() {
		if recovered := recover(); recovered != nil {
			sendBridgeLog(logger.WarnContext(ctx, "OpenTelemetry", operation, "failed:", recovered).
				AddFields(map[string]any{"otel.bridge_operation": operation}).
				AddTags("otel-span", "otel-bridge-error"))
		}
	}()
	callback()
}

func safeRecording(span Span) (recording bool) {
	defer func() { _ = recover() }()
	return span.IsRecording()
}

func safeSpanContext(ctx context.Context, logger *Logger, span Span) (value TraceContext) {
	defer func() {
		if recovered := recover(); recovered != nil {
			value = TraceContext{}
			sendBridgeLog(logger.WarnContext(ctx, "OpenTelemetry read span context failed:", recovered).
				AddFields(map[string]any{"otel.bridge_operation": "read span context"}).
				AddTags("otel-span", "otel-bridge-error"))
		}
	}()
	return span.LogContext()
}

func startSpan(ctx context.Context, logger *Logger, tracer Tracer, name string, attributes map[string]any) (spanCtx context.Context, span Span) {
	spanCtx = ctx
	span = noopSpan{}
	defer func() {
		if recovered := recover(); recovered != nil {
			sendBridgeLog(logger.ErrorContext(ctx, "OpenTelemetry start span failed:", name, recovered).
				AddFields(map[string]any{"otel.bridge_operation": "start span", "otel.span_name": name}).
				AddTags("otel-span", "otel-bridge-error"))
			spanCtx, span = ctx, noopSpan{}
		}
	}()
	startedCtx, startedSpan := tracer.Start(ctx, name, cloneMap(attributes))
	if startedCtx != nil {
		spanCtx = startedCtx
	}
	if startedSpan != nil {
		span = startedSpan
	} else {
		sendBridgeLog(logger.WarnContext(ctx, "OpenTelemetry start span returned nil:", name).
			AddFields(map[string]any{"otel.bridge_operation": "start span", "otel.span_name": name}).
			AddTags("otel-span", "otel-bridge-error"))
	}
	return spanCtx, span
}

// WithSpan starts one explicit application-owned span. Correlation is carried
// even when the span is sampled out; span mutation is recording-only. OTEL
// failures never replace the application result, while application panics are
// recorded when possible and re-raised unchanged.
func WithSpan[T any](ctx context.Context, logger *Logger, tracer Tracer, name string, attributes map[string]any, callback func(context.Context, Span) (T, error)) (result T, err error) {
	if logger == nil || tracer == nil || callback == nil {
		return result, fmt.Errorf("nextloggers: logger, tracer, and callback are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	spanCtx, span := startSpan(ctx, logger, tracer, name, attributes)
	spanCtx = WithLogContext(spanCtx, safeSpanContext(spanCtx, logger, span))
	started := time.Now()
	sendBridgeLog(logger.DebugContext(spanCtx, "span started:", name).
		AddFields(map[string]any{"otel.span_name": name, "otel.span_phase": "start"}).
		AddTags("otel-span"))

	defer func() {
		if recovered := recover(); recovered != nil {
			if safeRecording(span) {
				safeSpanCall(spanCtx, logger, "record panic", func() { span.RecordError(fmt.Errorf("panic: %v", recovered)) })
				safeSpanCall(spanCtx, logger, "set panic status", func() { span.SetStatus(OtelStatusError, fmt.Sprint(recovered)) })
			}
			sendBridgeLog(logger.ErrorContext(spanCtx, "span panicked:", name, recovered).
				AddFields(map[string]any{"otel.span_name": name, "otel.span_phase": "panic", "otel.duration_ms": float64(time.Since(started).Microseconds()) / 1000}).
				AddTags("otel-span"))
			safeSpanCall(spanCtx, logger, "end span", span.End)
			panic(recovered)
		}
		safeSpanCall(spanCtx, logger, "end span", span.End)
	}()

	result, err = callback(spanCtx, span)
	if err != nil {
		if safeRecording(span) {
			safeSpanCall(spanCtx, logger, "record exception", func() { span.RecordError(err) })
			safeSpanCall(spanCtx, logger, "set error status", func() { span.SetStatus(OtelStatusError, err.Error()) })
		}
		sendBridgeLog(logger.ErrorContext(spanCtx, "span failed:", name, err).
			AddFields(map[string]any{"otel.span_name": name, "otel.span_phase": "error", "otel.duration_ms": float64(time.Since(started).Microseconds()) / 1000}).
			AddTags("otel-span"))
		return result, err
	}
	if safeRecording(span) {
		safeSpanCall(spanCtx, logger, "set success status", func() { span.SetStatus(OtelStatusOK, "") })
	}
	sendBridgeLog(logger.DebugContext(spanCtx, "span completed:", name).
		AddFields(map[string]any{"otel.span_name": name, "otel.span_phase": "end", "otel.duration_ms": float64(time.Since(started).Microseconds()) / 1000}).
		AddTags("otel-span"))
	return result, nil
}
