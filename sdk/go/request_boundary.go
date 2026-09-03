package nextloggers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// RequestTransport is a closed set of protocol families supported by the
// request failure boundary.
type RequestTransport string

const (
	RequestTransportHTTP      RequestTransport = "http"
	RequestTransportTCP       RequestTransport = "tcp"
	RequestTransportWebSocket RequestTransport = "websocket"
)

// RequestScope distinguishes a long-lived connection/session from one message.
type RequestScope string

const (
	RequestScopeRequest    RequestScope = "request"
	RequestScopeConnection RequestScope = "connection"
	RequestScopeSession    RequestScope = "session"
	RequestScopeMessage    RequestScope = "message"
)

// RequestFailureKind is intentionally closed so middleware adapters must map
// every recoverable outcome explicitly.
type RequestFailureKind string

const (
	RequestFailureException  RequestFailureKind = "exception"
	RequestFailurePanic      RequestFailureKind = "panic"
	RequestFailureTimeout    RequestFailureKind = "timeout"
	RequestFailureCancelled  RequestFailureKind = "cancelled"
	RequestFailureDisconnect RequestFailureKind = "disconnect"
)

// ErrPeerDisconnected can wrap a protocol-specific peer disconnect.
var ErrPeerDisconnected = errors.New("peer disconnected")

// RequestBoundary contains only allowlisted protocol correlation values. Never
// store payloads, authorization headers, cookies, raw tokens, or credentials.
type RequestBoundary struct {
	Transport    RequestTransport `json:"transport"`
	Scope        RequestScope     `json:"scope"`
	Phase        string           `json:"phase"`
	Operation    string           `json:"operation,omitempty"`
	ConnectionID string           `json:"connectionId,omitempty"`
	MessageID    string           `json:"messageId,omitempty"`
}

func HTTPRequestBoundary(phase, operation string) RequestBoundary {
	return RequestBoundary{
		Transport: RequestTransportHTTP,
		Scope:     RequestScopeRequest,
		Phase:     phase,
		Operation: operation,
	}
}

func TCPConnectionBoundary(phase, connectionID, operation string) RequestBoundary {
	return RequestBoundary{
		Transport:    RequestTransportTCP,
		Scope:        RequestScopeConnection,
		Phase:        phase,
		Operation:    operation,
		ConnectionID: connectionID,
	}
}

func TCPMessageBoundary(phase, connectionID, messageID, operation string) RequestBoundary {
	return RequestBoundary{
		Transport:    RequestTransportTCP,
		Scope:        RequestScopeMessage,
		Phase:        phase,
		Operation:    operation,
		ConnectionID: connectionID,
		MessageID:    messageID,
	}
}

func WebSocketSessionBoundary(phase, connectionID, operation string) RequestBoundary {
	return RequestBoundary{
		Transport:    RequestTransportWebSocket,
		Scope:        RequestScopeSession,
		Phase:        phase,
		Operation:    operation,
		ConnectionID: connectionID,
	}
}

func WebSocketMessageBoundary(phase, connectionID, messageID, operation string) RequestBoundary {
	return RequestBoundary{
		Transport:    RequestTransportWebSocket,
		Scope:        RequestScopeMessage,
		Phase:        phase,
		Operation:    operation,
		ConnectionID: connectionID,
		MessageID:    messageID,
	}
}

func (boundary RequestBoundary) normalized() (RequestBoundary, error) {
	boundary.Phase = strings.TrimSpace(boundary.Phase)
	boundary.Operation = strings.TrimSpace(boundary.Operation)
	boundary.ConnectionID = strings.TrimSpace(boundary.ConnectionID)
	boundary.MessageID = strings.TrimSpace(boundary.MessageID)
	if err := boundedBoundaryText("phase", boundary.Phase, 128, true); err != nil {
		return RequestBoundary{}, err
	}
	for field, value := range map[string]string{
		"operation":    boundary.Operation,
		"connectionId": boundary.ConnectionID,
		"messageId":    boundary.MessageID,
	} {
		if err := boundedBoundaryText(field, value, 256, false); err != nil {
			return RequestBoundary{}, err
		}
	}

	switch boundary.Transport {
	case RequestTransportHTTP:
		if boundary.Scope != RequestScopeRequest || boundary.ConnectionID != "" || boundary.MessageID != "" {
			return RequestBoundary{}, errors.New("HTTP boundaries require request scope and no connection/message IDs")
		}
	case RequestTransportTCP:
		switch boundary.Scope {
		case RequestScopeConnection:
			if boundary.MessageID != "" {
				return RequestBoundary{}, errors.New("TCP connection scope cannot carry a message ID")
			}
		case RequestScopeMessage:
		default:
			return RequestBoundary{}, errors.New("TCP boundaries require connection or message scope")
		}
	case RequestTransportWebSocket:
		switch boundary.Scope {
		case RequestScopeSession:
			if boundary.MessageID != "" {
				return RequestBoundary{}, errors.New("WebSocket session scope cannot carry a message ID")
			}
		case RequestScopeMessage:
		default:
			return RequestBoundary{}, errors.New("WebSocket boundaries require session or message scope")
		}
	default:
		return RequestBoundary{}, fmt.Errorf("unsupported request transport %q", boundary.Transport)
	}
	return boundary, nil
}

func boundedBoundaryText(field, value string, maximum int, required bool) error {
	if value == "" {
		if required {
			return fmt.Errorf("%s is required", field)
		}
		return nil
	}
	if len(value) > maximum || strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s must be bounded text", field)
	}
	return nil
}

// RequestBoundaryFailure keeps the original error or recovered panic value and
// an immutable request-context snapshot for one protocol operation.
type RequestBoundaryFailure struct {
	Kind             RequestFailureKind `json:"kind"`
	Boundary         RequestBoundary    `json:"boundary"`
	Context          RequestContext     `json:"context"`
	Err              error              `json:"-"`
	Recovered        any                `json:"-"`
	ObservedAtUnixMS int64              `json:"observedAtUnixMs"`
}

// RequestBoundaryResult makes success and failure explicit without relying on
// a process-global panic or exception hook.
type RequestBoundaryResult[T any] struct {
	Value   T
	Failure *RequestBoundaryFailure
}

func (result RequestBoundaryResult[T]) OK() bool {
	return result.Failure == nil
}

// RequestBoundaryOptions controls classification and request-scoped reporting.
type RequestBoundaryOptions struct {
	Classify func(error, RequestBoundary) RequestFailureKind
	Report   func(context.Context, RequestBoundaryFailure)
	Now      func() time.Time
}

func defaultFailureKind(err error) RequestFailureKind {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return RequestFailureTimeout
	case errors.Is(err, context.Canceled):
		return RequestFailureCancelled
	case errors.Is(err, ErrPeerDisconnected):
		return RequestFailureDisconnect
	default:
		return RequestFailureException
	}
}

func validFailureKind(kind RequestFailureKind) bool {
	switch kind {
	case RequestFailureException,
		RequestFailurePanic,
		RequestFailureTimeout,
		RequestFailureCancelled,
		RequestFailureDisconnect:
		return true
	default:
		return false
	}
}

func requestFailure(
	ctx context.Context,
	boundary RequestBoundary,
	kind RequestFailureKind,
	err error,
	recovered any,
	now func() time.Time,
) RequestBoundaryFailure {
	snapshot, ok := CaptureRequestContext(ctx)
	if !ok {
		snapshot = RequestContext{}
	}
	return RequestBoundaryFailure{
		Kind:             kind,
		Boundary:         boundary,
		Context:          snapshot,
		Err:              err,
		Recovered:        recovered,
		ObservedAtUnixMS: now().UnixMilli(),
	}
}

func reportRequestFailure(
	ctx context.Context,
	failure RequestBoundaryFailure,
	reporter func(context.Context, RequestBoundaryFailure),
) {
	if reporter == nil {
		return
	}
	defer func() {
		// Telemetry/reporting panics cannot replace the request's original result.
		_ = recover()
	}()
	reporter(ctx, failure)
}

// RunWithRequestBoundary installs the canonical context.Context value, catches
// errors and panics from exactly one logical HTTP/TCP/WebSocket operation, and
// reports while that context remains active. Child goroutines must still receive
// ctx explicitly and install their own recovery boundary.
func RunWithRequestBoundary[T any](
	parent context.Context,
	requestContext RequestContext,
	boundary RequestBoundary,
	operation func(context.Context) (T, error),
	options RequestBoundaryOptions,
) (result RequestBoundaryResult[T]) {
	if parent == nil {
		parent = context.Background()
	}
	ctx := WithRequestContext(parent, requestContext)
	now := options.Now
	if now == nil {
		now = time.Now
	}

	normalized, validationError := boundary.normalized()
	if validationError != nil {
		failure := requestFailure(
			ctx,
			boundary,
			RequestFailureException,
			validationError,
			nil,
			now,
		)
		reportRequestFailure(ctx, failure, options.Report)
		return RequestBoundaryResult[T]{Failure: &failure}
	}
	if operation == nil {
		failure := requestFailure(
			ctx,
			normalized,
			RequestFailureException,
			errors.New("request boundary operation is nil"),
			nil,
			now,
		)
		reportRequestFailure(ctx, failure, options.Report)
		return RequestBoundaryResult[T]{Failure: &failure}
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			failure := requestFailure(
				ctx,
				normalized,
				RequestFailurePanic,
				nil,
				recovered,
				now,
			)
			reportRequestFailure(ctx, failure, options.Report)
			result = RequestBoundaryResult[T]{Failure: &failure}
		}
	}()

	value, err := operation(ctx)
	if err == nil {
		return RequestBoundaryResult[T]{Value: value}
	}
	kind := defaultFailureKind(err)
	if options.Classify != nil {
		func() {
			defer func() { _ = recover() }()
			candidate := options.Classify(err, normalized)
			if validFailureKind(candidate) {
				kind = candidate
			}
		}()
	}
	failure := requestFailure(ctx, normalized, kind, err, nil, now)
	reportRequestFailure(ctx, failure, options.Report)
	return RequestBoundaryResult[T]{Failure: &failure}
}
