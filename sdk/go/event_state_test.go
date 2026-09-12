package nextloggers

import (
	"fmt"
	"sync"
	"testing"
)

func deterministicLogger(transports ...Transport) *Logger {
	return NewLogger(Options{
		AppName:    "state-test",
		Runtime:    "go",
		Console:    false,
		Transports: transports,
		IDFactory:  func() string { return "state-record" },
		Clock:      func() string { return "2026-09-11T00:00:00.000Z" },
	})
}

func TestBuilderMutationInvalidatesMaterializedRecord(t *testing.T) {
	logger := deterministicLogger()
	event := logger.Info("materialize")

	first := event.ToRecord()
	if len(first.Fields) != 0 {
		t.Fatalf("unexpected initial fields: %#v", first.Fields)
	}

	event.AddFields(map[string]any{
		"phase":  "after-first-read",
		"nested": map[string]any{"value": "owned"},
	}).AddTags("rebuilt")
	second := event.ToRecord()

	if second.Fields["phase"] != "after-first-read" {
		t.Fatalf("cached record was not invalidated: %#v", second.Fields)
	}
	if got := second.Fields["nested"].(map[string]any)["value"]; got != "owned" {
		t.Fatalf("nested rebuilt field mismatch: %#v", got)
	}
	if len(second.Tags) != 1 || second.Tags[0] != "rebuilt" {
		t.Fatalf("rebuilt tags mismatch: %#v", second.Tags)
	}
	if len(first.Fields) != 0 || len(first.Tags) != 0 {
		t.Fatalf("earlier public snapshot changed: %#v", first)
	}
}

func TestSentEventIsTerminalForBuilderMethods(t *testing.T) {
	transport := &MemoryTransport{}
	logger := deterministicLogger(transport)
	event := logger.Info("terminal").
		AddFields(map[string]any{"phase": "before"}).
		AddLoggedInUserID("user-before").
		AddTrace("trace-before").
		AddRoutineID("routine-before").
		AddTags("before").
		AddContext(map[string]any{"phase": "before"}).
		AddMeta(map[string]any{"phase": "before"}).
		UseOtel()

	if err := event.Send(); err != nil {
		t.Fatal(err)
	}

	event.AddFields(map[string]any{"phase": "after"}).
		AddLoggedInUserID("user-after").
		AddUserInfo(map[string]any{"id": "late-user"}).
		AddTrace("trace-after", true).
		AddRoutineID("routine-after").
		AddTags("after").
		AddContext(map[string]any{"phase": "after"}).
		AddMeta(map[string]any{"phase": "after"}).
		NotOtel().
		ResetOtel()

	record := event.ToRecord()
	if record.Fields["phase"] != "before" {
		t.Fatalf("late field mutation escaped terminal state: %#v", record.Fields)
	}
	if record.LoggedInUser["id"] != "user-before" || len(record.Users) != 0 {
		t.Fatalf("late user mutation escaped terminal state: %#v %#v", record.LoggedInUser, record.Users)
	}
	if record.TraceID != "trace-before" || len(record.TraceIDs) != 1 {
		t.Fatalf("late trace mutation escaped terminal state: %#v", record)
	}
	if record.RoutineID != "routine-before" {
		t.Fatalf("late routine mutation escaped terminal state: %q", record.RoutineID)
	}
	if len(record.Tags) != 1 || record.Tags[0] != "before" {
		t.Fatalf("late tag mutation escaped terminal state: %#v", record.Tags)
	}
	if got := record.Context[0].(map[string]any)["phase"]; got != "before" {
		t.Fatalf("late context mutation escaped terminal state: %#v", got)
	}
	if got := record.Meta[0].(map[string]any)["phase"]; got != "before" {
		t.Fatalf("late metadata mutation escaped terminal state: %#v", got)
	}
	if !event.IsOtelEnabled(false) {
		t.Fatal("late OTEL mutation escaped terminal state")
	}
}

func TestBuilderInputsAreOwnedAtAdmission(t *testing.T) {
	loggerFields := map[string]any{
		"logger": map[string]any{"value": "logger-original"},
	}
	loggerUser := map[string]any{
		"id":      "logger-user",
		"profile": map[string]any{"name": "logger-original"},
	}
	transport := &MemoryTransport{}
	logger := NewLogger(Options{
		AppName:      "state-test",
		Runtime:      "go",
		Fields:       loggerFields,
		LoggedInUser: loggerUser,
		Console:      false,
		Transports:   []Transport{transport},
		IDFactory:    func() string { return "state-record" },
		Clock:        func() string { return "2026-09-11T00:00:00.000Z" },
	})

	value := map[string]any{"nested": map[string]any{"value": "value-original"}}
	fields := map[string]any{"event": map[string]any{"value": "event-original"}}
	user := map[string]any{"profile": map[string]any{"name": "event-original"}}
	affected := map[string]any{"profile": map[string]any{"name": "affected-original"}}
	contextValue := map[string]any{"nested": map[string]any{"value": "context-original"}}
	metaValue := map[string]any{"nested": map[string]any{"value": "meta-original"}}

	event := logger.Info(value).
		AddFields(fields).
		AddLoggedInUserInfo(user).
		AddUserInfo(affected).
		AddContext(contextValue).
		AddMeta(metaValue)

	loggerFields["logger"].(map[string]any)["value"] = "logger-attacker"
	loggerUser["profile"].(map[string]any)["name"] = "logger-attacker"
	value["nested"].(map[string]any)["value"] = "value-attacker"
	fields["event"].(map[string]any)["value"] = "event-attacker"
	user["profile"].(map[string]any)["name"] = "event-attacker"
	affected["profile"].(map[string]any)["name"] = "affected-attacker"
	contextValue["nested"].(map[string]any)["value"] = "context-attacker"
	metaValue["nested"].(map[string]any)["value"] = "meta-attacker"

	if err := event.Send(); err != nil {
		t.Fatal(err)
	}
	record := transport.Records[0]
	if got := record.Fields["logger"].(map[string]any)["value"]; got != "logger-original" {
		t.Fatalf("logger fields retained caller alias: %#v", got)
	}
	if got := record.Fields["event"].(map[string]any)["value"]; got != "event-original" {
		t.Fatalf("event fields retained caller alias: %#v", got)
	}
	if got := record.Values[0].(map[string]any)["nested"].(map[string]any)["value"]; got != "value-original" {
		t.Fatalf("event values retained caller alias: %#v", got)
	}
	if got := record.LoggedInUser["profile"].(map[string]any)["name"]; got != "event-original" {
		t.Fatalf("event user merge retained caller alias: %#v", got)
	}
	if got := record.Users[0]["profile"].(map[string]any)["name"]; got != "affected-original" {
		t.Fatalf("affected user retained caller alias: %#v", got)
	}
	if got := record.Context[0].(map[string]any)["nested"].(map[string]any)["value"]; got != "context-original" {
		t.Fatalf("context retained caller alias: %#v", got)
	}
	if got := record.Meta[0].(map[string]any)["nested"].(map[string]any)["value"]; got != "meta-original" {
		t.Fatalf("metadata retained caller alias: %#v", got)
	}
}

func TestConcurrentBuilderAndSendAreRaceFree(t *testing.T) {
	logger := deterministicLogger()
	const iterations = 256
	for iteration := 0; iteration < iterations; iteration++ {
		event := logger.Info("concurrent", iteration)
		start := make(chan struct{})
		errorsFound := make(chan error, 1)
		var group sync.WaitGroup
		group.Add(2)
		go func(value int) {
			defer group.Done()
			<-start
			event.AddFields(map[string]any{
				"iteration": value,
				"nested":    map[string]any{"value": value},
			}).AddTags(fmt.Sprintf("iteration-%d", value))
		}(iteration)
		go func() {
			defer group.Done()
			<-start
			if err := event.Send(); err != nil {
				errorsFound <- err
			}
		}()
		close(start)
		group.Wait()
		select {
		case err := <-errorsFound:
			t.Fatal(err)
		default:
		}

		record := event.ToRecord()
		if record.Message == "" || record.Level != Info {
			t.Fatalf("invalid terminal record at iteration %d: %#v", iteration, record)
		}
		if value, ok := record.Fields["iteration"]; ok && value != float64(iteration) {
			t.Fatalf("torn field at iteration %d: %#v", iteration, value)
		}
	}
}

func TestConcurrentLoggerDefaultsAndEmissionAreRaceFree(t *testing.T) {
	transport := &MemoryTransport{}
	logger := deterministicLogger(transport)
	const iterations = 256
	start := make(chan struct{})
	errorsFound := make(chan error, iterations)
	var group sync.WaitGroup
	group.Add(2)

	go func() {
		defer group.Done()
		<-start
		for iteration := 0; iteration < iterations; iteration++ {
			logger.AddFields(map[string]any{
				"generation": iteration,
				"nested":     map[string]any{"generation": iteration},
			})
			logger.SetCurrentUser(map[string]any{
				"id":      fmt.Sprintf("user-%d", iteration),
				"profile": map[string]any{"generation": iteration},
			})
			if iteration%2 == 0 {
				logger.UseOtel()
			} else {
				logger.NotOtel()
			}
		}
	}()

	go func() {
		defer group.Done()
		<-start
		for iteration := 0; iteration < iterations; iteration++ {
			if err := logger.Info("emit", iteration).Send(); err != nil {
				errorsFound <- err
			}
		}
	}()

	close(start)
	group.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Fatal(err)
	}
	if len(transport.Records) != iterations {
		t.Fatalf("expected %d records, got %d", iterations, len(transport.Records))
	}
}
