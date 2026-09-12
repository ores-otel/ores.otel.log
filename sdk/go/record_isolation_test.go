package nextloggers

import (
	"errors"
	"testing"
)

type mutatingRecordTransport struct{}

func (mutatingRecordTransport) Write(record LogRecord) error {
	record.Fields["nested"].(map[string]any)["value"] = "mutated"
	record.Values[0].(map[string]any)["nested"].(map[string]any)["value"] = "mutated"
	record.LoggedInUser["profile"].(map[string]any)["name"] = "mutated"
	record.Users[0]["profile"].(map[string]any)["name"] = "mutated"
	record.Context[0].(map[string]any)["request"] = "mutated"
	record.Meta[0].(map[string]any)["source"] = "mutated"
	record.Errors[0].(map[string]any)["message"] = "mutated"
	record.TraceIDs[0] = "mutated"
	record.Tags[0] = "mutated"
	record.StackTrace[0] = "mutated"
	return nil
}

type recordingRecordTransport struct {
	record LogRecord
}

func (transport *recordingRecordTransport) Write(record LogRecord) error {
	transport.record = record
	return nil
}

type mutatingExitTransport struct{}

func (mutatingExitTransport) Write(LogRecord) error { return nil }

func (mutatingExitTransport) FlushOnExit(records []LogRecord) error {
	records[0].Fields["nested"].(map[string]any)["value"] = "mutated"
	records[0].Tags[0] = "mutated"
	return nil
}

type recordingExitTransport struct {
	records []LogRecord
}

func (transport *recordingExitTransport) Write(LogRecord) error { return nil }

func (transport *recordingExitTransport) FlushOnExit(records []LogRecord) error {
	transport.records = records
	return nil
}

func assertNestedRecordIsPristine(t *testing.T, record LogRecord) {
	t.Helper()
	if got := record.Fields["nested"].(map[string]any)["value"]; got != "original" {
		t.Fatalf("fields were contaminated: %#v", got)
	}
	if got := record.Values[0].(map[string]any)["nested"].(map[string]any)["value"]; got != "original" {
		t.Fatalf("values were contaminated: %#v", got)
	}
	if got := record.LoggedInUser["profile"].(map[string]any)["name"]; got != "owner" {
		t.Fatalf("logged-in user was contaminated: %#v", got)
	}
	if got := record.Users[0]["profile"].(map[string]any)["name"]; got != "affected" {
		t.Fatalf("affected user was contaminated: %#v", got)
	}
	if got := record.Context[0].(map[string]any)["request"]; got != "request-1" {
		t.Fatalf("context was contaminated: %#v", got)
	}
	if got := record.Meta[0].(map[string]any)["source"]; got != "test" {
		t.Fatalf("metadata was contaminated: %#v", got)
	}
	if got := record.Errors[0].(map[string]any)["message"]; got != "boom" {
		t.Fatalf("errors were contaminated: %#v", got)
	}
	if len(record.TraceIDs) != 1 || record.TraceIDs[0] != "trace-1" {
		t.Fatalf("trace IDs were contaminated: %#v", record.TraceIDs)
	}
	if len(record.Tags) != 1 || record.Tags[0] != "audit" {
		t.Fatalf("tags were contaminated: %#v", record.Tags)
	}
	if len(record.StackTrace) != 1 || record.StackTrace[0] != "frame-1" {
		t.Fatalf("stack trace was contaminated: %#v", record.StackTrace)
	}
}

func newIsolationEvent(logger *Logger) *Event {
	event := logger.Error(
		map[string]any{"nested": map[string]any{"value": "original"}},
		errors.New("boom"),
	).
		AddFields(map[string]any{"nested": map[string]any{"value": "original"}}).
		AddLoggedInUserInfo(map[string]any{
			"id":      "user-1",
			"profile": map[string]any{"name": "owner"},
		}).
		AddUserInfo(map[string]any{
			"id":      "user-2",
			"profile": map[string]any{"name": "affected"},
		}).
		AddTrace("trace-1").
		AddTags("audit").
		AddContext(map[string]any{"request": "request-1"}).
		AddMeta(map[string]any{"source": "test"})
	event.StackTrace = []string{"frame-1"}
	return event
}

func TestEachTransportReceivesAnIsolatedRecord(t *testing.T) {
	capture := &recordingRecordTransport{}
	logger := NewLogger(Options{
		Console: false,
		Transports: []Transport{
			mutatingRecordTransport{},
			capture,
		},
		IDFactory: func() string { return "record-1" },
		Clock:     func() string { return "2026-09-11T00:00:00.000Z" },
	})

	if err := newIsolationEvent(logger).Send(); err != nil {
		t.Fatal(err)
	}
	assertNestedRecordIsPristine(t, capture.record)
}

func TestToRecordReturnsDefensiveSnapshots(t *testing.T) {
	logger := NewLogger(Options{
		Console:   false,
		IDFactory: func() string { return "record-1" },
		Clock:     func() string { return "2026-09-11T00:00:00.000Z" },
	})
	event := newIsolationEvent(logger)

	first := event.ToRecord()
	mutatingRecordTransport{}.Write(first)
	second := event.ToRecord()

	assertNestedRecordIsPristine(t, second)
}

func TestMemoryTransportOwnsStoredRecords(t *testing.T) {
	transport := &MemoryTransport{}
	record := LogRecord{
		Fields: map[string]any{
			"nested": map[string]any{"value": "original"},
		},
		Values: []any{
			map[string]any{"nested": map[string]any{"value": "original"}},
		},
		Tags: []string{"audit"},
	}

	if err := transport.Write(record); err != nil {
		t.Fatal(err)
	}
	record.Fields["nested"].(map[string]any)["value"] = "mutated"
	record.Values[0].(map[string]any)["nested"].(map[string]any)["value"] = "mutated"
	record.Tags[0] = "mutated"

	stored := transport.Records[0]
	if got := stored.Fields["nested"].(map[string]any)["value"]; got != "original" {
		t.Fatalf("stored fields retained caller aliases: %#v", got)
	}
	if got := stored.Values[0].(map[string]any)["nested"].(map[string]any)["value"]; got != "original" {
		t.Fatalf("stored values retained caller aliases: %#v", got)
	}
	if stored.Tags[0] != "audit" {
		t.Fatalf("stored tags retained caller aliases: %#v", stored.Tags)
	}
}

func TestExitFlushersReceiveIndependentRecoveredRecords(t *testing.T) {
	capture := &recordingExitTransport{}
	logger := NewLogger(Options{
		Console: false,
		Transports: []Transport{
			mutatingExitTransport{},
			capture,
		},
		IDFactory: func() string { return "record-1" },
		Clock:     func() string { return "2026-09-11T00:00:00.000Z" },
	})
	logger.Warn("pending").
		AddFields(map[string]any{"nested": map[string]any{"value": "original"}}).
		AddTags("audit")

	if err := logger.FlushOnExit(); err != nil {
		t.Fatal(err)
	}
	if len(capture.records) != 1 {
		t.Fatalf("expected one recovered record, got %d", len(capture.records))
	}
	if got := capture.records[0].Fields["nested"].(map[string]any)["value"]; got != "original" {
		t.Fatalf("exit fields were contaminated: %#v", got)
	}
	if got := capture.records[0].Tags[0]; got != "audit" {
		t.Fatalf("exit tags were contaminated: %#v", got)
	}
}

func TestRecordClonePreservesNilOptionalContainers(t *testing.T) {
	cloned := cloneLogRecord(LogRecord{})
	if cloned.Values != nil || cloned.Fields != nil || cloned.LoggedInUser != nil || cloned.Users != nil {
		t.Fatalf("nil record containers changed shape: %#v", cloned)
	}
	if cloned.TraceIDs != nil || cloned.Tags != nil || cloned.Context != nil || cloned.Meta != nil {
		t.Fatalf("nil correlation containers changed shape: %#v", cloned)
	}
	if cloned.Errors != nil || cloned.StackTrace != nil {
		t.Fatalf("nil diagnostic containers changed shape: %#v", cloned)
	}
}
