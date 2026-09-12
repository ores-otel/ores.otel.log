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
		target = append(target, cloneContextMap(value))
	}
	return target
}

// cloneLogContext returns a deep, detached copy: every nested collection is
// rebuilt so the result never aliases the input. A non-zero TraceFlags is
// treated as explicitly set.
func cloneLogContext(value LogContext) LogContext {
	return LogContext{
		LoggedInUser:  cloneContextMap(value.LoggedInUser),
		Users:         cloneUserList(value.Users),
		Fields:        cloneContextMap(value.Fields),
		TraceID:       value.TraceID,
		TraceIDs:      append([]string(nil), value.TraceIDs...),
		SpanID:        value.SpanID,
		TraceFlags:    value.TraceFlags,
		TraceFlagsSet: value.TraceFlagsSet || value.TraceFlags != 0,
		TraceState:    value.TraceState,
		Remote:        value.Remote,
		HasRemote:     value.HasRemote,
		Baggage:       cloneStringMap(value.Baggage),
		RoutineID:     value.RoutineID,
		Tags:          append([]string(nil), value.Tags...),
		Context:       cloneContextSlice(value.Context),
		Meta:          cloneContextSlice(value.Meta),
	}
}

// firstNonEmpty returns the first non-empty candidate, or "".
func firstNonEmpty(candidates ...string) string {
	for _, candidate := range candidates {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// mergedBaggage keeps the nil shape of an absent baggage map: a nil base with
// nothing to add stays nil; otherwise both maps are merged into a new one.
func mergedBaggage(base, overlay map[string]string) map[string]string {
	if base == nil && len(overlay) == 0 {
		return nil
	}
	return mergeMaps(base, overlay)
}

// MergeLogContexts applies canonical scope merge rules: maps merge with the
// inner scope winning; users/context/meta append; trace IDs and tags deduplicate
// while retaining order; and present scalar values replace their parent value.
//
// Both inputs are snapshotted first and a new context is built from their
// parts; neither argument, nor anything it references, is written to.
func MergeLogContexts(base LogContext, patch LogContext) LogContext {
	outer := cloneLogContext(base)
	inner := cloneLogContext(patch)
	// Trace ids accumulate in this order: the outer list, the outer primary id,
	// the inner primary id, then the inner list.
	traceIDs := appendAllUnique(
		appendAllUnique(outer.TraceIDs, outer.TraceID, inner.TraceID),
		inner.TraceIDs...,
	)
	// Trace flags are meaningful even when zero. Explicit TraceFlagsSet is the
	// unambiguous signal; trace/span IDs also identify an OTEL span context whose
	// sampled bit may legitimately be zero.
	innerHasSpanContext := inner.TraceFlagsSet || inner.TraceFlags != 0 ||
		inner.TraceID != "" || inner.SpanID != ""
	return LogContext{
		LoggedInUser:  mergeMaps(outer.LoggedInUser, inner.LoggedInUser),
		Users:         concat(outer.Users, mapSlice(inner.Users, cloneContextMap)),
		Fields:        mergeMaps(outer.Fields, inner.Fields),
		TraceID:       firstNonEmpty(inner.TraceID, outer.TraceID, firstString(traceIDs)),
		TraceIDs:      traceIDs,
		SpanID:        firstNonEmpty(inner.SpanID, outer.SpanID),
		TraceFlags:    pick(innerHasSpanContext, inner.TraceFlags, outer.TraceFlags),
		TraceFlagsSet: innerHasSpanContext || outer.TraceFlagsSet,
		TraceState:    firstNonEmpty(inner.TraceState, outer.TraceState),
		Remote:        pick(inner.HasRemote, inner.Remote, outer.Remote),
		HasRemote:     inner.HasRemote || outer.HasRemote,
		Baggage:       mergedBaggage(outer.Baggage, inner.Baggage),
		RoutineID:     firstNonEmpty(inner.RoutineID, outer.RoutineID),
		Tags:          appendAllUnique(outer.Tags, inner.Tags...),
		Context:       concat(outer.Context, inner.Context),
		Meta:          concat(outer.Meta, inner.Meta),
	}
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
	return cloneContextMap(value.LoggedInUser), true
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

	// value is already a detached snapshot, so its fields can be merged with
	// the span attributes into one new map without a second clone.
	fields := mergeMaps(value.Fields, mapOf(
		kvWhen[string, any](value.SpanID != "", "otel.span_id", value.SpanID),
		kvWhen[string, any](value.TraceFlagsSet, "otel.trace_flags", value.TraceFlags),
		kvWhen[string, any](value.TraceState != "", "otel.trace_state", value.TraceState),
		kvWhen[string, any](value.HasRemote, "otel.remote", value.Remote),
		kvWhen[string, any](len(value.Baggage) > 0, "otel.baggage", cloneStringMap(value.Baggage)),
	))
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
