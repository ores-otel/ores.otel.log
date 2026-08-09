// Package nextloggers implements the language-neutral next-loggers/v1 contract.
package nextloggers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

const Schema = "next-loggers/v1"

type Level string

const (
	Trace Level = "TRACE"
	Debug Level = "DEBUG"
	Info  Level = "INFO"
	Warn  Level = "WARN"
	Error Level = "ERROR"
	Fatal Level = "FATAL"
)

var levelIndex = map[Level]int{
	Trace: 0,
	Debug: 1,
	Info:  2,
	Warn:  3,
	Error: 4,
	Fatal: 5,
}

// OTELSeverityNumber maps next-loggers levels onto OpenTelemetry severity
// numbers without importing or registering a global OpenTelemetry SDK.
func (level Level) OTELSeverityNumber() int {
	switch level {
	case Trace:
		return 1
	case Debug:
		return 5
	case Info:
		return 9
	case Warn:
		return 13
	case Error:
		return 17
	case Fatal:
		return 21
	default:
		return 0
	}
}

type LogRecord struct {
	Schema       string           `json:"schema"`
	ID           string           `json:"id"`
	Timestamp    string           `json:"timestamp"`
	Level        Level            `json:"level"`
	Runtime      string           `json:"runtime"`
	AppName      string           `json:"appName"`
	Name         string           `json:"name,omitempty"`
	Message      string           `json:"message"`
	Values       []any            `json:"values"`
	Fields       map[string]any   `json:"fields"`
	LoggedInUser map[string]any   `json:"loggedInUser,omitempty"`
	Users        []map[string]any `json:"users,omitempty"`
	TraceID      string           `json:"traceId,omitempty"`
	TraceIDs     []string         `json:"traceIds,omitempty"`
	RoutineID    string           `json:"routineId,omitempty"`
	Tags         []string         `json:"tags,omitempty"`
	Context      []any            `json:"context,omitempty"`
	Meta         []any            `json:"meta,omitempty"`
	Errors       []any            `json:"errors,omitempty"`
	StackTrace   []string         `json:"stackTrace,omitempty"`
}

func (record LogRecord) JSON() ([]byte, error) {
	return json.Marshal(record)
}

type Transport interface {
	Write(LogRecord) error
}

type openTelemetryTransport interface {
	IsOpenTelemetry() bool
}

type Flusher interface {
	Flush() error
}

type ExitFlusher interface {
	FlushOnExit([]LogRecord) error
}

type Closer interface {
	Close() error
}

type MemoryTransport struct {
	mu          sync.Mutex
	Records     []LogRecord
	ExitRecords []LogRecord
	FlushCount  int
	Closed      bool
}

func (transport *MemoryTransport) Write(record LogRecord) error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.Closed {
		return errors.New("transport is closed")
	}
	transport.Records = append(transport.Records, record)
	return nil
}

func (transport *MemoryTransport) Flush() error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.FlushCount++
	return nil
}

func (transport *MemoryTransport) FlushOnExit(records []LogRecord) error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.ExitRecords = append(transport.ExitRecords, records...)
	return nil
}

func (transport *MemoryTransport) Close() error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.Closed = true
	return nil
}

// OpenTelemetryLogRecord is the dependency-free boundary passed to an
// application-owned OpenTelemetry logger.
type OpenTelemetryLogRecord struct {
	Body           string         `json:"body"`
	SeverityText   string         `json:"severityText"`
	SeverityNumber int            `json:"severityNumber"`
	Timestamp      string         `json:"timestamp"`
	Attributes     map[string]any `json:"attributes"`
}

type OpenTelemetryEmitter func(OpenTelemetryLogRecord) error

// OpenTelemetryTransport adapts next-loggers records to an injected OTEL
// emitter. It never installs global providers or automatic instrumentation.
type OpenTelemetryTransport struct {
	Emit OpenTelemetryEmitter
}

func NewOpenTelemetryTransport(emit OpenTelemetryEmitter) *OpenTelemetryTransport {
	return &OpenTelemetryTransport{Emit: emit}
}

func (transport *OpenTelemetryTransport) Write(record LogRecord) error {
	if transport == nil || transport.Emit == nil {
		return errors.New("nextloggers: OpenTelemetry emitter is required")
	}
	attributes := map[string]any{
		"service.name":        record.AppName,
		"next_logger.schema":  record.Schema,
		"next_logger.runtime": record.Runtime,
		"log.record.uid":      record.ID,
	}
	if record.TraceID != "" {
		attributes["trace.id"] = record.TraceID
	}
	for key, value := range record.Fields {
		attributes["next_logger.field."+key] = value
	}
	return transport.Emit(OpenTelemetryLogRecord{
		Body:           record.Message,
		SeverityText:   string(record.Level),
		SeverityNumber: record.Level.OTELSeverityNumber(),
		Timestamp:      record.Timestamp,
		Attributes:     attributes,
	})
}

func (transport *OpenTelemetryTransport) IsOpenTelemetry() bool { return true }

type SupabaseSender func(LogRecord) error

// SupabaseTransport delegates delivery to an application-owned authenticated
// Supabase sender, which may use Realtime, HTTP ingestion, or another client.
type SupabaseTransport struct {
	Send SupabaseSender
}

func NewSupabaseTransport(send SupabaseSender) *SupabaseTransport {
	return &SupabaseTransport{Send: send}
}

func (transport *SupabaseTransport) Write(record LogRecord) error {
	if transport == nil || transport.Send == nil {
		return errors.New("nextloggers: Supabase sender is required")
	}
	return transport.Send(record)
}

type Options struct {
	AppName      string
	Name         string
	Runtime      string
	MaxLevel     Level
	Fields       map[string]any
	LoggedInUser map[string]any
	Transports   []Transport
	Console      bool
	// OtelEnabled controls the default OTEL route. Nil means enabled.
	OtelEnabled *bool
	Output      io.Writer
	IDFactory   func() string
	Clock       func() string
}

type Logger struct {
	AppName       string
	Name          string
	Runtime       string
	MaxLevel      Level
	Fields        map[string]any
	CurrentUser   map[string]any
	Transports    []Transport
	Console       bool
	OtelEnabled   bool
	Output        io.Writer
	IDFactory     func() string
	Clock         func() string
	RuntimeFields func() map[string]any

	mu     sync.Mutex
	unsent map[*Event]struct{}
	closed bool
}

func NewLogger(options Options) *Logger {
	if options.AppName == "" {
		options.AppName = "app"
	}
	if options.Runtime == "" {
		options.Runtime = "go"
	}
	if _, ok := levelIndex[options.MaxLevel]; !ok {
		options.MaxLevel = Info
	}
	if options.Output == nil {
		options.Output = os.Stdout
	}
	if options.IDFactory == nil {
		options.IDFactory = randomID
	}
	if options.Clock == nil {
		options.Clock = func() string {
			return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
		}
	}
	otelEnabled := true
	if options.OtelEnabled != nil {
		otelEnabled = *options.OtelEnabled
	}
	return &Logger{
		AppName:       options.AppName,
		Name:          options.Name,
		Runtime:       options.Runtime,
		MaxLevel:      options.MaxLevel,
		Fields:        cloneMap(options.Fields),
		CurrentUser:   cloneMap(options.LoggedInUser),
		Transports:    append([]Transport(nil), options.Transports...),
		Console:       options.Console,
		OtelEnabled:   otelEnabled,
		Output:        options.Output,
		IDFactory:     options.IDFactory,
		Clock:         options.Clock,
		RuntimeFields: func() map[string]any { return nil },
		unsent:        make(map[*Event]struct{}),
	}
}

func randomID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value)
}

func cloneMap(source map[string]any) map[string]any {
	target := make(map[string]any, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func normalizeValue(value any) any {
	if value == nil {
		return nil
	}
	if err, ok := value.(error); ok {
		return map[string]any{"name": fmt.Sprintf("%T", err), "message": err.Error()}
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	var normalized any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return fmt.Sprint(value)
	}
	return normalized
}

func normalizeObject(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	normalized, ok := normalizeValue(value).(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return normalized
}

func messagePart(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if err, ok := value.(error); ok {
		return err.Error()
	}
	encoded, err := json.Marshal(normalizeValue(value))
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

type Event struct {
	Logger       *Logger
	Level        Level
	Values       []any
	Fields       map[string]any
	LoggedInUser map[string]any
	Users        []map[string]any
	TraceID      string
	TraceIDs     []string
	RoutineID    string
	Tags         []string
	Context      []any
	Meta         []any
	StackTrace   []string
	OtelEnabled  *bool

	mu     sync.Mutex
	sent   bool
	record *LogRecord
}

func (logger *Logger) newEvent(level Level, values []any) *Event {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	if logger.closed {
		panic("nextloggers: logger is closed")
	}
	event := &Event{
		Logger:       logger,
		Level:        level,
		Values:       append([]any(nil), values...),
		Fields:       map[string]any{},
		LoggedInUser: map[string]any{},
	}
	logger.unsent[event] = struct{}{}
	return event
}

func (logger *Logger) Trace(values ...any) *Event { return logger.newEvent(Trace, values) }
func (logger *Logger) Debug(values ...any) *Event { return logger.newEvent(Debug, values) }
func (logger *Logger) Info(values ...any) *Event  { return logger.newEvent(Info, values) }
func (logger *Logger) Log(values ...any) *Event   { return logger.Info(values...) }
func (logger *Logger) Warn(values ...any) *Event  { return logger.newEvent(Warn, values) }
func (logger *Logger) Error(values ...any) *Event { return logger.newEvent(Error, values) }
func (logger *Logger) Fatal(values ...any) *Event { return logger.newEvent(Fatal, values) }

func (logger *Logger) AddFields(fields map[string]any) *Logger {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	for key, value := range fields {
		logger.Fields[key] = value
	}
	return logger
}

func (logger *Logger) SetCurrentUser(user map[string]any) *Logger {
	logger.mu.Lock()
	defer logger.mu.Unlock()
	for key, value := range user {
		logger.CurrentUser[key] = value
	}
	return logger
}

func (event *Event) AddFields(fields map[string]any) *Event {
	for key, value := range fields {
		event.Fields[key] = value
	}
	return event
}

func (event *Event) WithOtel(enabled bool) *Event {
	event.OtelEnabled = &enabled
	return event
}

func (event *Event) WithOTel(enabled bool) *Event { return event.WithOtel(enabled) }
func (event *Event) UseOtel() *Event              { return event.WithOtel(true) }
func (event *Event) UseOTel() *Event              { return event.UseOtel() }
func (event *Event) NotOtel() *Event              { return event.WithOtel(false) }
func (event *Event) NotOTel() *Event              { return event.NotOtel() }

func (event *Event) ResetOtel() *Event {
	event.OtelEnabled = nil
	return event
}

func (event *Event) ResetOTel() *Event { return event.ResetOtel() }

func (event *Event) IsOtelEnabled(fallback bool) bool {
	if event.OtelEnabled == nil {
		return fallback
	}
	return *event.OtelEnabled
}

func (event *Event) IsOTelEnabled(fallback bool) bool { return event.IsOtelEnabled(fallback) }

func (logger *Logger) UseOtel() *Logger {
	logger.OtelEnabled = true
	return logger
}

func (logger *Logger) UseOTel() *Logger { return logger.UseOtel() }

func (logger *Logger) NotOtel() *Logger {
	logger.OtelEnabled = false
	return logger
}

func (logger *Logger) NotOTel() *Logger { return logger.NotOtel() }

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func (event *Event) AddTrace(traceID string, makeFirst ...bool) *Event {
	value := strings.TrimSpace(traceID)
	if value == "" {
		return event
	}
	if event.TraceID == "" || (len(makeFirst) > 0 && makeFirst[0]) {
		event.TraceID = value
	}
	event.TraceIDs = appendUnique(event.TraceIDs, value)
	return event
}

func (event *Event) AddTraceID(traceID string, makeFirst ...bool) *Event {
	return event.AddTrace(traceID, makeFirst...)
}

func (event *Event) AddRoutineID(routineID string) *Event {
	event.RoutineID = routineID
	return event
}

func (event *Event) AddTags(tags ...string) *Event {
	for _, tag := range tags {
		if value := strings.TrimSpace(tag); value != "" {
			event.Tags = appendUnique(event.Tags, value)
		}
	}
	return event
}

func (event *Event) AddContext(value any) *Event {
	event.Context = append(event.Context, value)
	return event
}

func (event *Event) AddMeta(value any) *Event {
	event.Meta = append(event.Meta, value)
	return event
}

func (event *Event) AddLoggedInUserInfo(user map[string]any) *Event {
	for key, value := range user {
		event.LoggedInUser[key] = value
	}
	return event
}

func (event *Event) AddLoggedInUserID(id string) *Event {
	event.LoggedInUser["id"] = id
	return event
}

func (event *Event) AddUserInfo(user map[string]any) *Event {
	event.Users = append(event.Users, cloneMap(user))
	return event
}

func (event *Event) ToRecord() LogRecord {
	event.mu.Lock()
	defer event.mu.Unlock()
	if event.record != nil {
		return *event.record
	}
	fields := cloneMap(event.Logger.Fields)
	for key, value := range event.Fields {
		fields[key] = value
	}
	if event.Logger.RuntimeFields != nil {
		for key, value := range event.Logger.RuntimeFields() {
			fields[key] = value
		}
	}
	user := cloneMap(event.Logger.CurrentUser)
	for key, value := range event.LoggedInUser {
		user[key] = value
	}
	values := make([]any, 0, len(event.Values))
	errorsFound := make([]any, 0)
	parts := make([]string, 0, len(event.Values))
	for _, value := range event.Values {
		values = append(values, normalizeValue(value))
		parts = append(parts, messagePart(value))
		if _, ok := value.(error); ok {
			errorsFound = append(errorsFound, normalizeValue(value))
		}
	}
	record := LogRecord{
		Schema:       Schema,
		ID:           event.Logger.IDFactory(),
		Timestamp:    event.Logger.Clock(),
		Level:        event.Level,
		Runtime:      event.Logger.Runtime,
		AppName:      event.Logger.AppName,
		Name:         event.Logger.Name,
		Message:      strings.Join(parts, " "),
		Values:       values,
		Fields:       normalizeObject(fields),
		LoggedInUser: normalizeObject(user),
		Users:        make([]map[string]any, 0, len(event.Users)),
		TraceID:      event.TraceID,
		TraceIDs:     append([]string(nil), event.TraceIDs...),
		RoutineID:    event.RoutineID,
		Tags:         append([]string(nil), event.Tags...),
		Context:      make([]any, 0, len(event.Context)),
		Meta:         make([]any, 0, len(event.Meta)),
		Errors:       errorsFound,
		StackTrace:   append([]string(nil), event.StackTrace...),
	}
	if len(record.LoggedInUser) == 0 {
		record.LoggedInUser = nil
	}
	for _, value := range event.Users {
		record.Users = append(record.Users, normalizeObject(value))
	}
	for _, value := range event.Context {
		record.Context = append(record.Context, normalizeValue(value))
	}
	for _, value := range event.Meta {
		record.Meta = append(record.Meta, normalizeValue(value))
	}
	event.record = &record
	return record
}

func (event *Event) Send() error {
	return event.SendWithStore(true)
}

func (event *Event) SendWithStore(store bool) error {
	event.mu.Lock()
	if event.sent {
		event.mu.Unlock()
		return nil
	}
	event.sent = true
	event.mu.Unlock()
	return event.Logger.emit(event, store)
}

func (logger *Logger) emit(event *Event, store bool) error {
	logger.mu.Lock()
	delete(logger.unsent, event)
	logger.mu.Unlock()
	if levelIndex[event.Level] < levelIndex[logger.MaxLevel] {
		return nil
	}
	record := event.ToRecord()
	if logger.Console {
		fmt.Fprintf(logger.Output, "[%s] [%s] [%s] %s\n",
			record.Timestamp, record.Level, record.AppName, record.Message)
	}
	if !store {
		return nil
	}
	var failures []error
	for _, transport := range logger.Transports {
		if marker, ok := transport.(openTelemetryTransport); ok && marker.IsOpenTelemetry() && !event.IsOtelEnabled(logger.OtelEnabled) {
			continue
		}
		if err := transport.Write(record); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (logger *Logger) Flush(sendUnsent bool) error {
	var failures []error
	if sendUnsent {
		logger.mu.Lock()
		events := make([]*Event, 0, len(logger.unsent))
		for event := range logger.unsent {
			events = append(events, event)
		}
		logger.mu.Unlock()
		for _, event := range events {
			if err := event.Send(); err != nil {
				failures = append(failures, err)
			}
		}
	}
	for _, transport := range logger.Transports {
		if flusher, ok := transport.(Flusher); ok {
			if err := flusher.Flush(); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

func (logger *Logger) FlushOnExit() error {
	logger.mu.Lock()
	events := make([]*Event, 0, len(logger.unsent))
	for event := range logger.unsent {
		events = append(events, event)
	}
	logger.mu.Unlock()
	recovered := make([]LogRecord, 0, len(events))
	var failures []error
	for _, event := range events {
		if err := event.Send(); err != nil {
			failures = append(failures, err)
		}
		recovered = append(recovered, event.ToRecord())
	}
	for _, transport := range logger.Transports {
		if flusher, ok := transport.(ExitFlusher); ok {
			if err := flusher.FlushOnExit(recovered); err != nil {
				failures = append(failures, err)
			}
		}
	}
	if err := logger.Flush(false); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

func (logger *Logger) Close() error {
	logger.mu.Lock()
	if logger.closed {
		logger.mu.Unlock()
		return nil
	}
	logger.mu.Unlock()
	var failures []error
	if err := logger.FlushOnExit(); err != nil {
		failures = append(failures, err)
	}
	for _, transport := range logger.Transports {
		if closer, ok := transport.(Closer); ok {
			if err := closer.Close(); err != nil {
				failures = append(failures, err)
			}
		}
	}
	logger.mu.Lock()
	logger.closed = true
	logger.mu.Unlock()
	return errors.Join(failures...)
}
