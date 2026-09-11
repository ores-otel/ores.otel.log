package nextloggers

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func TestLogContextRecursivelySnapshotsNestedCallerValues(t *testing.T) {
	source := LogContext{
		LoggedInUser: map[string]any{
			"id": "user-1",
			"profile": map[string]any{
				"roles": []any{"reader"},
				"preferences": map[string]any{"locale": "en"},
			},
		},
		TraceID: "trace-1",
		Fields: map[string]any{
			"tenant": map[string]any{
				"id":      "tenant-1",
				"regions": []any{"west"},
			},
			"request": map[string]any{
				"id":    "request-1",
				"retry": map[string]any{"attempt": float64(1)},
			},
		},
		Context: []any{map[string]any{"transaction": map[string]any{"id": "txn-1"}}},
		Meta:    []any{map[string]any{"policy": map[string]any{"id": "policy-1"}}},
		Tags:    []string{"outer"},
	}

	ctx := WithLogContext(context.Background(), source)

	source.LoggedInUser["profile"].(map[string]any)["roles"].([]any)[0] = "attacker"
	source.LoggedInUser["profile"].(map[string]any)["preferences"].(map[string]any)["locale"] = "attacker"
	source.Fields["tenant"].(map[string]any)["id"] = "attacker"
	source.Fields["tenant"].(map[string]any)["regions"].([]any)[0] = "attacker"
	source.Fields["request"].(map[string]any)["retry"].(map[string]any)["attempt"] = float64(99)
	source.Context[0].(map[string]any)["transaction"].(map[string]any)["id"] = "attacker"
	source.Meta[0].(map[string]any)["policy"].(map[string]any)["id"] = "attacker"
	source.Tags[0] = "attacker"

	observed, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("expected stored log context")
	}
	profile := observed.LoggedInUser["profile"].(map[string]any)
	if got := profile["roles"].([]any)[0]; got != "reader" {
		t.Fatalf("nested role alias leaked: %v", got)
	}
	if got := profile["preferences"].(map[string]any)["locale"]; got != "en" {
		t.Fatalf("nested preference alias leaked: %v", got)
	}
	tenant := observed.Fields["tenant"].(map[string]any)
	if got := tenant["id"]; got != "tenant-1" {
		t.Fatalf("tenant alias leaked: %v", got)
	}
	if got := tenant["regions"].([]any)[0]; got != "west" {
		t.Fatalf("nested region alias leaked: %v", got)
	}
	request := observed.Fields["request"].(map[string]any)
	if got := request["retry"].(map[string]any)["attempt"]; got != float64(1) {
		t.Fatalf("nested retry alias leaked: %v", got)
	}
	if got := observed.Context[0].(map[string]any)["transaction"].(map[string]any)["id"]; got != "txn-1" {
		t.Fatalf("context alias leaked: %v", got)
	}
	if got := observed.Meta[0].(map[string]any)["policy"].(map[string]any)["id"]; got != "policy-1" {
		t.Fatalf("meta alias leaked: %v", got)
	}
	if got := observed.Tags[0]; got != "outer" {
		t.Fatalf("tag alias leaked: %v", got)
	}
}

func TestLogContextRetrievalDoesNotExposeStoredNestedAliases(t *testing.T) {
	ctx := WithLogContext(context.Background(), LogContext{
		TraceID: "trace-stored",
		Fields: map[string]any{
			"tenant": map[string]any{"id": "tenant-stored"},
			"items":  []any{map[string]any{"id": "item-stored"}},
		},
	})

	first, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("expected first context")
	}
	first.Fields["tenant"].(map[string]any)["id"] = "attacker"
	first.Fields["items"].([]any)[0].(map[string]any)["id"] = "attacker"

	second, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("expected second context")
	}
	if got := second.Fields["tenant"].(map[string]any)["id"]; got != "tenant-stored" {
		t.Fatalf("retrieval exposed stored tenant alias: %v", got)
	}
	if got := second.Fields["items"].([]any)[0].(map[string]any)["id"]; got != "item-stored" {
		t.Fatalf("retrieval exposed stored item alias: %v", got)
	}
}

func TestLogContextNestedValuesRemainRaceFreeAcrossWorkers(t *testing.T) {
	const workers = 256
	var wg sync.WaitGroup
	errors := make(chan error, workers)

	for index := 0; index < workers; index++ {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			tenant := fmt.Sprintf("tenant-%d", index)
			request := fmt.Sprintf("request-%d", index)
			source := LogContext{
				TraceID: fmt.Sprintf("trace-%d", index),
				LoggedInUser: map[string]any{
					"id": fmt.Sprintf("user-%d", index),
					"claims": map[string]any{"tenant": tenant},
				},
				Fields: map[string]any{
					"tenant":  map[string]any{"id": tenant},
					"request": map[string]any{"id": request},
				},
			}
			ctx := WithLogContext(context.Background(), source)
			source.LoggedInUser["claims"].(map[string]any)["tenant"] = "attacker"
			source.Fields["tenant"].(map[string]any)["id"] = "attacker"
			source.Fields["request"].(map[string]any)["id"] = "attacker"
			observed, ok := LogContextFrom(ctx)
			if !ok {
				errors <- fmt.Errorf("worker %d lost context", index)
				return
			}
			if got := observed.LoggedInUser["claims"].(map[string]any)["tenant"]; got != tenant {
				errors <- fmt.Errorf("worker %d claim=%v want=%s", index, got, tenant)
			}
			if got := observed.Fields["tenant"].(map[string]any)["id"]; got != tenant {
				errors <- fmt.Errorf("worker %d tenant=%v want=%s", index, got, tenant)
			}
			if got := observed.Fields["request"].(map[string]any)["id"]; got != request {
				errors <- fmt.Errorf("worker %d request=%v want=%s", index, got, request)
			}
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}
