package nextloggers

import (
	"context"
	"net/http"
)

// LogContext is the language-neutral request/task context attached to log
// records. Go carries it explicitly through context.Context; this package does
// not emulate goroutine-local storage or derive goroutine identifiers.
type LogContext struct {
	LoggedInUser  map[string]any
	Users         []map[string]any
	Fields        map[string]any
	TraceID       string
	TraceIDs      []string
	SpanID        string
	TraceFlags    byte
	TraceFlagsSet bool
	TraceState    string
	Remote        bool
	HasRemote     bool
	Baggage       map[string]string
	RoutineID     string
	Tags          []string
	Context       []any
	Meta          []any
}

// TraceContext remains as a source-compatible name for tracing-focused callers.
type TraceContext = LogContext

type logContextKey struct{}

func cloneStringMap(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	target := make(map[string]string, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func cloneUserList(source []map[string]any) []map[string]any {
	if source == nil {
		return nil
	}
	target := make([]map[string]any, 0, len(source))
	for _, value := range source {
		target = append(target, cloneMap(value))
	}
	return target
}

func cloneLogContext(value LogContext) LogContext {
	if value.TraceFlags != 0 {
		value.TraceFlagsSet = true
	}
	value.LoggedInUser = cloneMap(value.LoggedInUser)
	value.Users = cloneUserList(value.Users)
	value.Fields = cloneMap(value.Fields)
	value.TraceIDs = append([]string(nil), value.TraceIDs...)
	value.Baggage = cloneStringMap(value.Baggage)
	value.Tags = append([]string(nil), value.Tags...)
	value.Context = append([]any(nil), value.Context...)
	value.Meta = append([]any(nil), value.Meta...)
	return value
}

func appendUniqueString(values []string, candidate string) []string {
	if candidate == "" {
		return values
	}
	for _, value := range values {
		if value == candidate {
			return values
		}
	}
	return append(values, candidate)
}

// MergeLogContexts applies canonical scope merge rules: maps merge with the
// inner scope winning; users/context/meta append; trace IDs and tags deduplicate
// while retaining order; and present scalar values replace their parent value.
func MergeLogContexts(base LogContext, patch LogContext) LogContext {
	merged := cloneLogContext(base)
	if merged.TraceID != "" {
		merged.TraceIDs = appendUniqueString(merged.TraceIDs, merged.TraceID)
	}
	for key, value := range patch.LoggedInUser {
		merged.LoggedInUser[key] = value
	}
	for _, user := range patch.Users {
		merged.Users = append(merged.Users, cloneMap(user))
	}
	for key, value := range patch.Fields {
		merged.Fields[key] = value
	}
	if patch.TraceID != "" {
		merged.TraceID = patch.TraceID
		merged.TraceIDs = appendUniqueString(merged.TraceIDs, patch.TraceID)
	}
	for _, traceID := range patch.TraceIDs {
		merged.TraceIDs = appendUniqueString(merged.TraceIDs, traceID)
	}
	if merged.TraceID == "" && len(merged.TraceIDs) > 0 {
		merged.TraceID = merged.TraceIDs[0]
	}
	if patch.SpanID != "" {
		merged.SpanID = patch.SpanID
	}
	// Trace flags are meaningful even when zero. Explicit TraceFlagsSet is the
	// unambiguous signal; trace/span IDs also identify an OTEL span context whose
	// sampled bit may legitimately be zero.
	if patch.TraceFlagsSet || patch.TraceFlags != 0 || patch.TraceID != "" || patch.SpanID != "" {
		merged.TraceFlags = patch.TraceFlags
		merged.TraceFlagsSet = true
	}
	if patch.TraceState != "" {
		merged.TraceState = patch.TraceState
	}
	if patch.HasRemote {
		merged.Remote = patch.Remote
		merged.HasRemote = true
	}
	if merged.Baggage == nil && len(patch.Baggage) > 0 {
		merged.Baggage = make(map[string]string, len(patch.Baggage))
	}
	for key, value := range patch.Baggage {
		merged.Baggage[key] = value
	}
	if patch.RoutineID != "" {
		merged.RoutineID = patch.RoutineID
	}
	for _, tag := range patch.Tags {
		merged.Tags = appendUniqueString(merged.Tags, tag)
	}
	merged.Context = append(merged.Context, patch.Context...)
	merged.Meta = append(merged.Meta, patch.Meta...)
	return merged
}

// MergeLogContext preserves the tracing-focused value-level API introduced by
// the canonical Go SDK while using the complete LogContext merge semantics.
func MergeLogContext(outer, inner TraceContext) TraceContext {
	return MergeLogContexts(outer, inner)
}

func withLogContextSnapshot(parent context.Context, value LogContext) context.Context {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithValue(parent, logContextKey{}, cloneLogContext(value))
}

// WithLogContext returns a child context carrying an immutable merged snapshot.
// Child goroutines must receive the returned context explicitly.
func WithLogContext(parent context.Context, value LogContext) context.Context {
	if parent == nil {
		parent = context.Background()
	}
	current, _ := LogContextFrom(parent)
	return withLogContextSnapshot(parent, MergeLogContexts(current, value))
}

// WithMergedLogContext is an explicit alias for callers that want the merge
// semantics to be visible at the call site.
func WithMergedLogContext(parent context.Context, patch LogContext) context.Context {
	return WithLogContext(parent, patch)
}

// LogContextFrom returns an immutable copy of the context value.
func LogContextFrom(ctx context.Context) (LogContext, bool) {
	if ctx == nil {
		return LogContext{}, false
	}
	value, ok := ctx.Value(logContextKey{}).(LogContext)
	if !ok {
		return LogContext{}, false
	}
	return cloneLogContext(value), true
}

// UpdateLogContext replaces the current immutable snapshot with the value
// returned by update. The callback receives a defensive copy.
func UpdateLogContext(ctx context.Context, update func(LogContext) LogContext) context.Context {
	if update == nil {
		return ctx
	}
	current, _ := LogContextFrom(ctx)
	return withLogContextSnapshot(ctx, update(current))
}

func WithLoggedInUser(ctx context.Context, user map[string]any) context.Context {
	return WithLogContext(ctx, LogContext{LoggedInUser: user})
}

// LoggedInUserFrom returns a defensive copy of the current authenticated user.
func LoggedInUserFrom(ctx context.Context) (map[string]any, bool) {
	value, ok := LogContextFrom(ctx)
	if !ok || len(value.LoggedInUser) == 0 {
		return nil, false
	}
	return cloneMap(value.LoggedInUser), true
}

func WithTraceFlags(ctx context.Context, traceFlags byte) context.Context {
	return WithLogContext(ctx, LogContext{
		TraceFlags:    traceFlags,
		TraceFlagsSet: true,
	})
}

func WithTrace(ctx context.Context, traceID, spanID string) context.Context {
	return WithLogContext(ctx, LogContext{
		TraceID:  traceID,
		TraceIDs: []string{traceID},
		SpanID:   spanID,
	})
}

// RequestWithLogContext snapshots value into a cloned *http.Request.
func RequestWithLogContext(request *http.Request, value LogContext) *http.Request {
	if request == nil {
		return nil
	}
	return request.WithContext(WithLogContext(request.Context(), value))
}

func LogContextFromRequest(request *http.Request) (LogContext, bool) {
	if request == nil {
		return LogContext{}, false
	}
	return LogContextFrom(request.Context())
}

// LogContextMiddleware resolves a request context once and installs it on the
// request passed to downstream handlers. Request.Context remains the canonical
// propagation mechanism across goroutines and cancellation boundaries.
func LogContextMiddleware(resolve func(*http.Request) LogContext) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if resolve == nil {
				next.ServeHTTP(writer, request)
				return
			}
			next.ServeHTTP(writer, RequestWithLogContext(request, resolve(request)))
		})
	}
}

// ApplyContext enriches an event from context.Context without retaining the
// context itself or any mutable map supplied by the caller.
func (event *Event) ApplyContext(ctx context.Context) *Event {
	value, ok := LogContextFrom(ctx)
	if !ok {
		return event
	}

	fields := cloneMap(value.Fields)
	if value.SpanID != "" {
		fields["otel.span_id"] = value.SpanID
	}
	if value.TraceFlagsSet {
		fields["otel.trace_flags"] = value.TraceFlags
	}
	if value.TraceState != "" {
		fields["otel.trace_state"] = value.TraceState
	}
	if value.HasRemote {
		fields["otel.remote"] = value.Remote
	}
	if len(value.Baggage) > 0 {
		fields["otel.baggage"] = cloneStringMap(value.Baggage)
	}
	if len(fields) > 0 {
		event.AddFields(fields)
	}
	if len(value.LoggedInUser) > 0 {
		event.AddLoggedInUserInfo(value.LoggedInUser)
	}
	for _, user := range value.Users {
		event.AddUserInfo(user)
	}
	if value.TraceID != "" {
		// An explicitly attached event trace remains primary; the ambient trace
		// is still retained in TraceIDs for correlation.
		event.AddTrace(value.TraceID)
	}
	for _, traceID := range value.TraceIDs {
		event.AddTrace(traceID)
	}
	if value.RoutineID != "" {
		event.AddRoutineID(value.RoutineID)
	}
	otelContext := value.TraceID != "" || value.SpanID != "" || value.TraceFlagsSet || value.TraceState != "" || value.HasRemote || len(value.Baggage) > 0
	if otelContext {
		event.AddTags("otel")
	}
	if len(value.Tags) > 0 {
		event.AddTags(value.Tags...)
	}
	for _, item := range value.Context {
		event.AddContext(item)
	}
	for _, item := range value.Meta {
		event.AddMeta(item)
	}
	return event
}
