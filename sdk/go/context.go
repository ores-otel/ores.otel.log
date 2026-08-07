package nextloggers

import (
	"context"
	"fmt"
	"time"
)

// TraceContext is the language-neutral subset of W3C/OpenTelemetry span context
// attached to next-loggers records. It is carried explicitly in context.Context;
// the package never emulates goroutine-local storage.
type TraceContext struct {
	TraceID    string
	SpanID     string
	TraceFlags byte
	TraceState string
	Baggage    map[string]string
	Fields     map[string]any
	Tags       []string
}

type logContextKey struct{}

func cloneTraceContext(value TraceContext) TraceContext {
	clone := value
	clone.Baggage = make(map[string]string, len(value.Baggage))
	for key, entry := range value.Baggage {
		clone.Baggage[key] = entry
	}
	clone.Fields = cloneMap(value.Fields)
	clone.Tags = append([]string(nil), value.Tags...)
	return clone
}

// WithLogContext returns a child context carrying an immutable snapshot.
func WithLogContext(ctx context.Context, value TraceContext) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, logContextKey{}, cloneTraceContext(value))
}

func LogContextFrom(ctx context.Context) (TraceContext, bool) {
	if ctx == nil {
		return TraceContext{}, false
	}
	value, ok := ctx.Value(logContextKey{}).(TraceContext)
	return cloneTraceContext(value), ok
}

func (event *Event) ApplyContext(ctx context.Context) *Event {
	value, ok := LogContextFrom(ctx)
	if !ok {
		return event
	}
	if value.TraceID != "" {
		event.AddTrace(value.TraceID)
	}
	fields := cloneMap(value.Fields)
	if value.SpanID != "" {
		fields["otel.span_id"] = value.SpanID
	}
	fields["otel.trace_flags"] = value.TraceFlags
	if value.TraceState != "" {
		fields["otel.trace_state"] = value.TraceState
	}
	if len(value.Baggage) > 0 {
		baggage := make(map[string]string, len(value.Baggage))
		for key, entry := range value.Baggage {
			baggage[key] = entry
		}
		fields["otel.baggage"] = baggage
	}
	event.AddFields(fields)
	event.AddTags(append([]string{"otel"}, value.Tags...)...)
	return event
}

func (logger *Logger) TraceContext(ctx context.Context, values ...any) *Event {
	return logger.Trace(values...).ApplyContext(ctx)
}
func (logger *Logger) DebugContext(ctx context.Context, values ...any) *Event {
	return logger.Debug(values...).ApplyContext(ctx)
}
func (logger *Logger) InfoContext(ctx context.Context, values ...any) *Event {
	return logger.Info(values...).ApplyContext(ctx)
}
func (logger *Logger) WarnContext(ctx context.Context, values ...any) *Event {
	return logger.Warn(values...).ApplyContext(ctx)
}
func (logger *Logger) ErrorContext(ctx context.Context, values ...any) *Event {
	return logger.Error(values...).ApplyContext(ctx)
}
func (logger *Logger) FatalContext(ctx context.Context, values ...any) *Event {
	return logger.Fatal(values...).ApplyContext(ctx)
}

// Span and Tracer are deliberately structural adapters. Integrations wrap the
// installed OpenTelemetry implementation; next-loggers does not import or
// auto-install an SDK.
type Span interface {
	LogContext() TraceContext
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

func (noopSpan) LogContext() TraceContext          { return TraceContext{} }
func (noopSpan) RecordError(error)                 {}
func (noopSpan) SetStatus(int, string)             {}
func (noopSpan) End()                              {}

func sendSpanLogSafely(event *Event) {
	if event == nil {
		return
	}
	defer func() { _ = recover() }()
	_ = event.Send()
}

func invokeSpanSafely(
	ctx context.Context,
	logger *Logger,
	operation string,
	callback func(),
) {
	defer func() {
		if recovered := recover(); recovered != nil {
			sendSpanLogSafely(
				logger.WarnContext(ctx, "OpenTelemetry", operation, "failed:", recovered).
					AddFields(map[string]any{"otel.bridge_operation": operation}).
					AddTags("otel-span", "otel-bridge-error"),
			)
		}
	}()
	callback()
}

func readSpanContextSafely(
	ctx context.Context,
	logger *Logger,
	span Span,
) (value TraceContext) {
	defer func() {
		if recovered := recover(); recovered != nil {
			value = TraceContext{}
			sendSpanLogSafely(
				logger.WarnContext(ctx, "OpenTelemetry read span context failed:", recovered).
					AddFields(map[string]any{"otel.bridge_operation": "read span context"}).
					AddTags("otel-span", "otel-bridge-error"),
			)
		}
	}()
	return span.LogContext()
}

func reportStartFailure(ctx context.Context, logger *Logger, name string, failure any) {
	sendSpanLogSafely(
		logger.ErrorContext(ctx, "OpenTelemetry start span failed:", name, failure).
			AddFields(map[string]any{
				"otel.bridge_operation": "start span",
				"otel.span_name":       name,
				"otel.span_phase":      "start-error",
			}).
			AddTags("otel-span", "otel-bridge-error"),
	)
}

func startSpanSafely(
	ctx context.Context,
	logger *Logger,
	tracer Tracer,
	name string,
	attributes map[string]any,
) (spanCtx context.Context, span Span) {
	if ctx == nil {
		ctx = context.Background()
	}
	spanCtx = ctx
	span = noopSpan{}
	defer func() {
		if recovered := recover(); recovered != nil {
			reportStartFailure(ctx, logger, name, recovered)
			spanCtx = ctx
			span = noopSpan{}
		}
	}()
	startedCtx, startedSpan := tracer.Start(ctx, name, cloneMap(attributes))
	if startedCtx != nil {
		spanCtx = startedCtx
	}
	if startedSpan == nil {
		reportStartFailure(ctx, logger, name, "tracer returned a nil span")
		span = noopSpan{}
		return spanCtx, span
	}
	span = startedSpan
	return spanCtx, span
}

// WithSpan starts and ends one explicit span and mirrors its lifecycle through
// next-loggers. Logging and OTel lifecycle failures never replace the
// application result. A panic from the application callback is recorded and
// then re-raised unchanged. A tracer startup failure runs the callback with a
// no-op span after emitting a next-loggers bridge-error record.
func WithSpan[T any](
	ctx context.Context,
	logger *Logger,
	tracer Tracer,
	name string,
	attributes map[string]any,
	callback func(context.Context, Span) (T, error),
) (result T, err error) {
	if logger == nil {
		return result, fmt.Errorf("nextloggers: logger is nil")
	}
	if tracer == nil {
		return result, fmt.Errorf("nextloggers: tracer is nil")
	}
	if callback == nil {
		return result, fmt.Errorf("nextloggers: callback is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	spanCtx, span := startSpanSafely(ctx, logger, tracer, name, attributes)
	spanCtx = WithLogContext(spanCtx, readSpanContextSafely(spanCtx, logger, span))
	started := time.Now()
	sendSpanLogSafely(
		logger.DebugContext(spanCtx, "span started:", name).
			AddFields(map[string]any{"otel.span_name": name, "otel.span_phase": "start"}).
			AddTags("otel-span"),
	)

	defer func() {
		if recovered := recover(); recovered != nil {
			invokeSpanSafely(spanCtx, logger, "record panic", func() {
				span.RecordError(fmt.Errorf("panic: %v", recovered))
			})
			invokeSpanSafely(spanCtx, logger, "set panic status", func() {
				span.SetStatus(OtelStatusError, fmt.Sprint(recovered))
			})
			sendSpanLogSafely(
				logger.ErrorContext(spanCtx, "span panicked:", name, recovered).
					AddFields(map[string]any{
						"otel.span_name":   name,
						"otel.span_phase":  "panic",
						"otel.duration_ms": float64(time.Since(started).Microseconds()) / 1000,
					}).
					AddTags("otel-span"),
			)
			invokeSpanSafely(spanCtx, logger, "end span", span.End)
			panic(recovered)
		}
		invokeSpanSafely(spanCtx, logger, "end span", span.End)
	}()

	result, err = callback(spanCtx, span)
	if err != nil {
		invokeSpanSafely(spanCtx, logger, "record exception", func() { span.RecordError(err) })
		invokeSpanSafely(spanCtx, logger, "set error status", func() {
			span.SetStatus(OtelStatusError, err.Error())
		})
		sendSpanLogSafely(
			logger.ErrorContext(spanCtx, "span failed:", name, err).
				AddFields(map[string]any{
					"otel.span_name":   name,
					"otel.span_phase":  "error",
					"otel.duration_ms": float64(time.Since(started).Microseconds()) / 1000,
				}).
				AddTags("otel-span"),
		)
		return result, err
	}
	invokeSpanSafely(spanCtx, logger, "set success status", func() {
		span.SetStatus(OtelStatusOK, "")
	})
	sendSpanLogSafely(
		logger.DebugContext(spanCtx, "span completed:", name).
			AddFields(map[string]any{
				"otel.span_name":   name,
				"otel.span_phase":  "end",
				"otel.duration_ms": float64(time.Since(started).Microseconds()) / 1000,
			}).
			AddTags("otel-span"),
	)
	return result, nil
}
