package nextloggers

import (
	"context"
	"fmt"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

func TestRequestContextGettersUseCanonicalLogContext(t *testing.T) {
	value := RequestContext{
		RequestID:       "request-1",
		LoggedInUserID:  "user-1",
		TenantID:        "tenant-1",
		SessionID:       "session-1",
		CorrelationID:   "correlation-1",
		ParentRequestID: "request-0",
		TraceID:         "0123456789abcdef0123456789abcdef",
		SpanID:          "0123456789abcdef",
		Operation:       "GET /v1/profile",
		ServiceName:     "profile-api",
		Locale:          "en-US",
		StartedAtUnixMS: 1_000,
		DeadlineUnixMS:  2_000,
		Baggage:         map[string]string{"region": "east"},
	}
	ctx := WithRequestContext(context.Background(), value)

	assertRequestString(t, ctx, RequestIDFrom, "request-1")
	assertRequestString(t, ctx, LoggedInUserIDFrom, "user-1")
	assertRequestString(t, ctx, TenantIDFrom, "tenant-1")
	assertRequestString(t, ctx, SessionIDFrom, "session-1")
	assertRequestString(t, ctx, CorrelationIDFrom, "correlation-1")

	captured, ok := CaptureRequestContext(ctx)
	if !ok {
		t.Fatal("expected request context")
	}
	if !reflect.DeepEqual(captured, value) {
		t.Fatalf("captured context mismatch:\nwant %#v\n got %#v", value, captured)
	}

	logContext, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("expected log context")
	}
	if got := logContext.Fields["request.context.schema"]; got != RequestContextSchema {
		t.Fatalf("schema field = %#v", got)
	}
	if got := logContext.Fields["request.id"]; got != "request-1" {
		t.Fatalf("request.id = %#v", got)
	}
	if got := logContext.Fields["user.id"]; got != "user-1" {
		t.Fatalf("user.id = %#v", got)
	}
	if got := logContext.LoggedInUser["id"]; got != "user-1" {
		t.Fatalf("logged in user id = %#v", got)
	}
}

func TestRequestContextLegacyUserIDAlias(t *testing.T) {
	ctx := WithRequestContext(context.Background(), RequestContext{
		RequestID: "request-legacy",
		UserID:    "user-legacy",
	})
	assertRequestString(t, ctx, LoggedInUserIDFrom, "user-legacy")
	captured, ok := RequestContextFrom(ctx)
	if !ok || captured.LoggedInUserID != "user-legacy" || captured.UserID != "user-legacy" {
		t.Fatalf("legacy user alias was not normalized: %#v, %v", captured, ok)
	}
}

func TestRequestContextConcurrentGoroutinesRequireExplicitContext(t *testing.T) {
	const count = 64
	var wait sync.WaitGroup
	errors := make(chan error, count)
	for index := 0; index < count; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			requestID := fmt.Sprintf("request-%d", index)
			userID := fmt.Sprintf("user-%d", index)
			ctx := WithRequestContext(context.Background(), RequestContext{
				RequestID:      requestID,
				LoggedInUserID: userID,
			})
			gotRequestID, _ := RequestIDFrom(ctx)
			gotUserID, _ := LoggedInUserIDFrom(ctx)
			if gotRequestID != requestID || gotUserID != userID {
				errors <- fmt.Errorf("request %d observed %q/%q", index, gotRequestID, gotUserID)
			}
		}()
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}

func TestHTTPRequestWithRequestContextClonesRequest(t *testing.T) {
	original := httptest.NewRequest("GET", "https://example.test/profile", nil)
	cloned := HTTPRequestWithRequestContext(original, RequestContext{
		RequestID:      "request-http",
		LoggedInUserID: "user-http",
	})
	if cloned == original {
		t.Fatal("expected a shallow request clone")
	}
	assertRequestString(t, cloned.Context(), RequestIDFrom, "request-http")
	assertRequestString(t, cloned.Context(), LoggedInUserIDFrom, "user-http")
	if _, ok := RequestIDFrom(original.Context()); ok {
		t.Fatal("original request was mutated")
	}
}

func assertRequestString(
	t *testing.T,
	ctx context.Context,
	getter func(context.Context) (string, bool),
	want string,
) {
	t.Helper()
	got, ok := getter(ctx)
	if !ok || got != want {
		t.Fatalf("got %q, %v; want %q, true", got, ok, want)
	}
}
