package nextloggers

import "context"

// TraceContext is the language-neutral context attached to next-loggers
// records. Go carries it explicitly in context.Context; this package never
// emulates goroutine-local storage.
type TraceContext struct {
	LoggedInUser map[string]any
	Users        []map[string]any
	Fields       map[string]any
	TraceID      string
	TraceIDs     []string
	SpanID       string
	TraceFlags   byte
	TraceState   string
	Remote       bool
	HasRemote    bool
	Baggage      map[string]string
	RoutineID    string
	Tags         []string
	Context      []any
	Meta         []any
}

// LogContext is the canonical public name. TraceContext remains as a
// compatibility alias for callers that adopted the earlier OTEL-focused API.
type LogContext = TraceContext

type logContextKey struct{}

func cloneStringMap(value map[string]string) map[string]string {
	if value == nil {
		return nil
	}
	result := make(map[string]string, len(value))
	for key, entry := range value {
		result[key] = entry
	}
	return result
}

func cloneUsers(value []map[string]any) []map[string]any {
	if value == nil {
		return nil
	}
	result := make([]map[string]any, 0, len(value))
	for _, user := range value {
		result = append(result, cloneMap(user))
	}
	return result
}

func cloneTraceContext(value TraceContext) TraceContext {
	value.LoggedInUser = cloneMap(value.LoggedInUser)
	value.Users = cloneUsers(value.Users)
	value.Fields = cloneMap(value.Fields)
	value.TraceIDs = append([]string(nil), value.TraceIDs...)
	value.Baggage = cloneStringMap(value.Baggage)
	value.Tags = append([]string(nil), value.Tags...)
	value.Context = append([]any(nil), value.Context...)
	value.Meta = append([]any(nil), value.Meta...)
	return value
}

func mergeMap(outer, inner map[string]any) map[string]any {
	result := cloneMap(outer)
	for key, value := range inner {
		result[key] = value
	}
	return result
}

func mergeStringMap(outer, inner map[string]string) map[string]string {
	result := cloneStringMap(outer)
	if result == nil && len(inner) > 0 {
		result = make(map[string]string, len(inner))
	}
	for key, value := range inner {
		result[key] = value
	}
	return result
}

func appendUniqueStrings(target []string, values ...string) []string {
	for _, value := range values {
		if value == "" {
			continue
		}
		found := false
		for _, existing := range target {
			if existing == value {
				found = true
				break
			}
		}
		if !found {
			target = append(target, value)
		}
	}
	return target
}

// MergeLogContext applies canonical scope merge rules: maps merge with the
// inner scope winning; users append; trace IDs/tags deduplicate while retaining
// first occurrence; and a non-empty inner primary trace ID becomes primary.
func MergeLogContext(outer, inner TraceContext) TraceContext {
	result := cloneTraceContext(outer)
	result.LoggedInUser = mergeMap(result.LoggedInUser, inner.LoggedInUser)
	result.Users = append(result.Users, cloneUsers(inner.Users)...)
	result.Fields = mergeMap(result.Fields, inner.Fields)
	result.Baggage = mergeStringMap(result.Baggage, inner.Baggage)
	result.TraceIDs = appendUniqueStrings(result.TraceIDs, inner.TraceIDs...)
	if inner.TraceID != "" {
		result.TraceID = inner.TraceID
		result.TraceIDs = appendUniqueStrings(result.TraceIDs, inner.TraceID)
	}
	if inner.SpanID != "" {
		result.SpanID = inner.SpanID
	}
	if inner.TraceState != "" {
		result.TraceState = inner.TraceState
	}
	if inner.TraceFlags != 0 || inner.SpanID != "" || inner.TraceID != "" {
		result.TraceFlags = inner.TraceFlags
	}
	if inner.HasRemote {
		result.Remote = inner.Remote
		result.HasRemote = true
	}
	if inner.RoutineID != "" {
		result.RoutineID = inner.RoutineID
	}
	result.Tags = appendUniqueStrings(result.Tags, inner.Tags...)
	result.Context = append(result.Context, inner.Context...)
	result.Meta = append(result.Meta, inner.Meta...)
	return result
}

// WithLogContext returns a child context containing an immutable merged
// snapshot. The caller must pass the returned context to child goroutines.
func WithLogContext(ctx context.Context, value TraceContext) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if outer, ok := LogContextFrom(ctx); ok {
		value = MergeLogContext(outer, value)
	}
	return context.WithValue(ctx, logContextKey{}, cloneTraceContext(value))
}

func BackgroundLogContext(value LogContext) context.Context {
	return WithLogContext(context.Background(), value)
}

func CaptureLogContext(ctx context.Context) LogContext {
	value, _ := LogContextFrom(ctx)
	return value
}

func WithCapturedLogContext(parent context.Context, captured LogContext) context.Context {
	return WithLogContext(parent, captured)
}

func LogContextFrom(ctx context.Context) (TraceContext, bool) {
	if ctx == nil {
		return TraceContext{}, false
	}
	value, ok := ctx.Value(logContextKey{}).(TraceContext)
	if !ok {
		return TraceContext{}, false
	}
	return cloneTraceContext(value), true
}

func UpdateLogContext(ctx context.Context, update func(TraceContext) TraceContext) context.Context {
	if update == nil {
		return ctx
	}
	current, _ := LogContextFrom(ctx)
	return WithLogContext(ctx, update(current))
}

func (event *Event) ApplyContext(ctx context.Context) *Event {
	value, ok := LogContextFrom(ctx)
	if !ok {
		return event
	}
	if value.TraceID != "" {
		// Ambient context augments an event but must not replace an explicit
		// event-level primary trace chosen by the caller.
		event.AddTrace(value.TraceID)
	}
	for _, traceID := range value.TraceIDs {
		event.AddTrace(traceID)
	}
	fields := cloneMap(value.Fields)
	if value.SpanID != "" {
		fields["otel.span_id"] = value.SpanID
	}
	fields["otel.trace_flags"] = value.TraceFlags
	if value.TraceState != "" {
		fields["otel.trace_state"] = value.TraceState
	}
	if value.HasRemote {
		fields["otel.remote"] = value.Remote
	}
	if len(value.Baggage) > 0 {
		fields["otel.baggage"] = cloneStringMap(value.Baggage)
	}
	event.AddFields(fields)
	if len(value.LoggedInUser) > 0 {
		event.AddLoggedInUserInfo(value.LoggedInUser)
	}
	for _, user := range value.Users {
		event.AddUserInfo(user)
	}
	if value.RoutineID != "" {
		event.AddRoutineID(value.RoutineID)
	}
	event.AddTags(append([]string{"otel"}, value.Tags...)...)
	for _, entry := range value.Context {
		event.AddContext(entry)
	}
	for _, entry := range value.Meta {
		event.AddMeta(entry)
	}
	return event
}

func ApplyLogContext(ctx context.Context, event *Event) *Event {
	if event == nil {
		return nil
	}
	return event.ApplyContext(ctx)
}
