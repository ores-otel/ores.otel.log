package nextloggers

import (
	"context"
	"net/http"
)

// RequestContextSchema is the versioned semantic contract shared by
// ores-middleware and ores-otel.
const RequestContextSchema = "ores.request-context.v1"

// RequestContext contains only allowlisted correlation identifiers. It must
// never contain authorization headers, cookies, raw tokens, credentials, or
// direct identity data such as email addresses.
//
// UserID remains as a source-compatible alias for older middleware callers.
// New code should use LoggedInUserID.
type RequestContext struct {
	RequestID       string            `json:"requestId"`
	LoggedInUserID  string            `json:"loggedInUserId,omitempty"`
	UserID          string            `json:"userId,omitempty"`
	TenantID        string            `json:"tenantId,omitempty"`
	SessionID       string            `json:"sessionId,omitempty"`
	CorrelationID   string            `json:"correlationId,omitempty"`
	ParentRequestID string            `json:"parentRequestId,omitempty"`
	TraceID         string            `json:"traceId,omitempty"`
	SpanID          string            `json:"spanId,omitempty"`
	Operation       string            `json:"operation,omitempty"`
	ServiceName     string            `json:"serviceName,omitempty"`
	Locale          string            `json:"locale,omitempty"`
	StartedAtUnixMS int64             `json:"startedAtUnixMs,omitempty"`
	DeadlineUnixMS  int64             `json:"deadlineUnixMs,omitempty"`
	Baggage         map[string]string `json:"baggage,omitempty"`
}

// EffectiveLoggedInUserID normalizes the preferred field and its legacy alias.
func (value RequestContext) EffectiveLoggedInUserID() string {
	if value.LoggedInUserID != "" {
		return value.LoggedInUserID
	}
	return value.UserID
}

func requestContextFields(value RequestContext) map[string]any {
	fields := map[string]any{
		"request.context.schema": RequestContextSchema,
	}
	putRequestString(fields, "request.id", value.RequestID)
	putRequestString(fields, "user.id", value.EffectiveLoggedInUserID())
	putRequestString(fields, "tenant.id", value.TenantID)
	putRequestString(fields, "session.id", value.SessionID)
	putRequestString(fields, "correlation.id", value.CorrelationID)
	putRequestString(fields, "request.parent_id", value.ParentRequestID)
	putRequestString(fields, "operation.name", value.Operation)
	putRequestString(fields, "service.name", value.ServiceName)
	putRequestString(fields, "request.locale", value.Locale)
	if value.StartedAtUnixMS > 0 {
		fields["request.started_at_unix_ms"] = value.StartedAtUnixMS
	}
	if value.DeadlineUnixMS > 0 {
		fields["request.deadline_unix_ms"] = value.DeadlineUnixMS
	}
	return fields
}

func putRequestString(fields map[string]any, key, value string) {
	if value != "" {
		fields[key] = value
	}
}

// LogContextForRequest converts the middleware-facing request contract into
// the single immutable LogContext snapshot already stored by this SDK.
func LogContextForRequest(value RequestContext) LogContext {
	userID := value.EffectiveLoggedInUserID()
	loggedInUser := map[string]any(nil)
	if userID != "" {
		loggedInUser = map[string]any{"id": userID}
	}
	traceIDs := []string(nil)
	if value.TraceID != "" {
		traceIDs = []string{value.TraceID}
	}
	return LogContext{
		LoggedInUser: loggedInUser,
		Fields:       requestContextFields(value),
		TraceID:      value.TraceID,
		TraceIDs:     traceIDs,
		SpanID:       value.SpanID,
		Baggage:      cloneStringMap(value.Baggage),
		RoutineID:    value.RequestID,
		Tags:         []string{"ores-request-context"},
	}
}

// WithRequestContext attaches one fat immutable request snapshot to the
// existing context.Context chain. It deliberately does not introduce a second
// private context key or a process-wide request registry.
func WithRequestContext(parent context.Context, value RequestContext) context.Context {
	return WithLogContext(parent, LogContextForRequest(value))
}

// RequestContextFrom reconstructs a defensive request snapshot from the
// canonical LogContext value.
func RequestContextFrom(ctx context.Context) (RequestContext, bool) {
	logContext, ok := rawLogContextFrom(ctx)
	if !ok {
		return RequestContext{}, false
	}
	requestID := stringField(logContext.Fields, "request.id")
	userID := loggedInUserIDFromLogContext(logContext)
	value := RequestContext{
		RequestID:       requestID,
		LoggedInUserID:  userID,
		UserID:          userID,
		TenantID:        stringField(logContext.Fields, "tenant.id"),
		SessionID:       stringField(logContext.Fields, "session.id"),
		CorrelationID:   stringField(logContext.Fields, "correlation.id"),
		ParentRequestID: stringField(logContext.Fields, "request.parent_id"),
		TraceID:         logContext.TraceID,
		SpanID:          logContext.SpanID,
		Operation:       stringField(logContext.Fields, "operation.name"),
		ServiceName:     stringField(logContext.Fields, "service.name"),
		Locale:          stringField(logContext.Fields, "request.locale"),
		StartedAtUnixMS: int64Field(logContext.Fields, "request.started_at_unix_ms"),
		DeadlineUnixMS:  int64Field(logContext.Fields, "request.deadline_unix_ms"),
		Baggage:         cloneStringMap(logContext.Baggage),
	}
	return value, requestID != ""
}

// CaptureRequestContext returns a detached immutable snapshot suitable for a
// queue payload or an explicitly propagated goroutine.
func CaptureRequestContext(ctx context.Context) (RequestContext, bool) {
	return RequestContextFrom(ctx)
}

// RunWithRequestContext invokes operation with a child carrying the canonical
// request context. Child goroutines must receive the returned context explicitly.
func RunWithRequestContext[T any](
	parent context.Context,
	value RequestContext,
	operation func(context.Context) (T, error),
) (T, error) {
	return operation(WithRequestContext(parent, value))
}

// HTTPRequestWithRequestContext returns a shallow request clone carrying the
// canonical context through cancellation and deadline boundaries.
func HTTPRequestWithRequestContext(request *http.Request, value RequestContext) *http.Request {
	if request == nil {
		return nil
	}
	return request.WithContext(WithRequestContext(request.Context(), value))
}

// RequestContextMiddleware resolves and installs one request snapshot.
func RequestContextMiddleware(resolve func(*http.Request) RequestContext) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if resolve == nil {
				next.ServeHTTP(writer, request)
				return
			}
			next.ServeHTTP(writer, HTTPRequestWithRequestContext(request, resolve(request)))
		})
	}
}

func rawLogContextFrom(ctx context.Context) (LogContext, bool) {
	if ctx == nil {
		return LogContext{}, false
	}
	value, ok := ctx.Value(logContextKey{}).(LogContext)
	return value, ok
}

func stringField(fields map[string]any, key string) string {
	value, _ := fields[key].(string)
	return value
}

func int64Field(fields map[string]any, key string) int64 {
	switch value := fields[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case float32:
		return int64(value)
	default:
		return 0
	}
}

func loggedInUserIDFromLogContext(value LogContext) string {
	if candidate, ok := value.LoggedInUser["id"].(string); ok && candidate != "" {
		return candidate
	}
	if candidate, ok := value.LoggedInUser["ddUserId"].(string); ok && candidate != "" {
		return candidate
	}
	return stringField(value.Fields, "user.id")
}

func RequestIDFrom(ctx context.Context) (string, bool) {
	value, ok := rawLogContextFrom(ctx)
	if !ok {
		return "", false
	}
	result := stringField(value.Fields, "request.id")
	return result, result != ""
}

func LoggedInUserIDFrom(ctx context.Context) (string, bool) {
	value, ok := rawLogContextFrom(ctx)
	if !ok {
		return "", false
	}
	result := loggedInUserIDFromLogContext(value)
	return result, result != ""
}

func TenantIDFrom(ctx context.Context) (string, bool) {
	value, ok := rawLogContextFrom(ctx)
	if !ok {
		return "", false
	}
	result := stringField(value.Fields, "tenant.id")
	return result, result != ""
}

func SessionIDFrom(ctx context.Context) (string, bool) {
	value, ok := rawLogContextFrom(ctx)
	if !ok {
		return "", false
	}
	result := stringField(value.Fields, "session.id")
	return result, result != ""
}

func CorrelationIDFrom(ctx context.Context) (string, bool) {
	value, ok := rawLogContextFrom(ctx)
	if !ok {
		return "", false
	}
	result := stringField(value.Fields, "correlation.id")
	return result, result != ""
}
