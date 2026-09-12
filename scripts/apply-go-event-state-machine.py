#!/usr/bin/env python3
"""Apply the reviewed Go event/logger state-machine hardening exactly once."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one source fragment, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "sdk/go/logger.go",
    """type Logger struct {
\tAppName       string
\tName          string
\tRuntime       string
\tMaxLevel      Level
\tFields        map[string]any
\tCurrentUser   map[string]any
\tTransports    []Transport
\tConsole       bool
\tOtelEnabled   bool
\tOutput        io.Writer
\tIDFactory     func() string
\tClock         func() string
\tRuntimeFields func() map[string]any

\tmu        sync.Mutex
\tunsent    map[*Event]struct{}
\tclosed    bool
\tcloseOnce sync.Once
\tcloseErr  error
}
""",
    """type Logger struct {
\tAppName       string
\tName          string
\tRuntime       string
\tMaxLevel      Level
\tFields        map[string]any
\tCurrentUser   map[string]any
\tTransports    []Transport
\tConsole       bool
\tOtelEnabled   bool
\tOutput        io.Writer
\tIDFactory     func() string
\tClock         func() string
\tRuntimeFields func() map[string]any

\tmu        sync.Mutex
\tunsent    map[*Event]struct{}
\tclosed    bool
\tcloseOnce sync.Once
\tcloseErr  error
}

type loggerSnapshot struct {
\tappName       string
\tname          string
\truntime       string
\tmaxLevel      Level
\tfields        map[string]any
\tcurrentUser   map[string]any
\ttransports    []Transport
\tconsole       bool
\totelEnabled   bool
\toutput        io.Writer
\tidFactory     func() string
\tclock         func() string
\truntimeFields func() map[string]any
}

func (logger *Logger) snapshot() loggerSnapshot {
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\treturn loggerSnapshot{
\t\tappName:       logger.AppName,
\t\tname:          logger.Name,
\t\truntime:       logger.Runtime,
\t\tmaxLevel:      logger.MaxLevel,
\t\tfields:        cloneContextMap(logger.Fields),
\t\tcurrentUser:   cloneContextMap(logger.CurrentUser),
\t\ttransports:    append([]Transport(nil), logger.Transports...),
\t\tconsole:       logger.Console,
\t\totelEnabled:   logger.OtelEnabled,
\t\toutput:        logger.Output,
\t\tidFactory:     logger.IDFactory,
\t\tclock:         logger.Clock,
\t\truntimeFields: logger.RuntimeFields,
\t}
}

func (logger *Logger) transportSnapshot() []Transport {
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\treturn append([]Transport(nil), logger.Transports...)
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """\t\tFields:        cloneMap(options.Fields),
\t\tCurrentUser:   cloneMap(options.LoggedInUser),
""",
    """\t\tFields:        cloneContextMap(options.Fields),
\t\tCurrentUser:   cloneContextMap(options.LoggedInUser),
""",
)

replace_once(
    "sdk/go/logger.go",
    """\t\tValues:       append([]any(nil), values...),
""",
    """\t\tValues:       cloneContextSlice(values),
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (logger *Logger) AddFields(fields map[string]any) *Logger {
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\tfor key, value := range fields {
\t\tlogger.Fields[key] = value
\t}
\treturn logger
}

func (logger *Logger) SetCurrentUser(user map[string]any) *Logger {
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\tfor key, value := range user {
\t\tlogger.CurrentUser[key] = value
\t}
\treturn logger
}

func (event *Event) AddFields(fields map[string]any) *Event {
\tfor key, value := range fields {
\t\tevent.Fields[key] = value
\t}
\treturn event
}

func (event *Event) WithOtel(enabled bool) *Event {
\tevent.OtelEnabled = &enabled
\treturn event
}
""",
    """func (logger *Logger) AddFields(fields map[string]any) *Logger {
\tsnapshot := cloneContextMap(fields)
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\tif logger.Fields == nil {
\t\tlogger.Fields = make(map[string]any, len(snapshot))
\t}
\tfor key, value := range snapshot {
\t\tlogger.Fields[key] = value
\t}
\treturn logger
}

func (logger *Logger) SetCurrentUser(user map[string]any) *Logger {
\tsnapshot := cloneContextMap(user)
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\tif logger.CurrentUser == nil {
\t\tlogger.CurrentUser = make(map[string]any, len(snapshot))
\t}
\tfor key, value := range snapshot {
\t\tlogger.CurrentUser[key] = value
\t}
\treturn logger
}

// mutate serializes builder methods, invalidates a pre-send materialization,
// and makes Send the terminal state. Late builder calls remain source-compatible
// no-ops instead of racing an in-flight or already-delivered record.
func (event *Event) mutate(update func()) *Event {
\tevent.mu.Lock()
\tdefer event.mu.Unlock()
\tif event.sent {
\t\treturn event
\t}
\tupdate()
\tevent.record = nil
\treturn event
}

func (event *Event) AddFields(fields map[string]any) *Event {
\treturn event.mutate(func() {
\t\tsnapshot := cloneContextMap(fields)
\t\tif event.Fields == nil {
\t\t\tevent.Fields = make(map[string]any, len(snapshot))
\t\t}
\t\tfor key, value := range snapshot {
\t\t\tevent.Fields[key] = value
\t\t}
\t})
}

func (event *Event) WithOtel(enabled bool) *Event {
\treturn event.mutate(func() {
\t\tvalue := enabled
\t\tevent.OtelEnabled = &value
\t})
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (event *Event) ResetOtel() *Event {
\tevent.OtelEnabled = nil
\treturn event
}

func (event *Event) ResetOTel() *Event { return event.ResetOtel() }

func (event *Event) IsOtelEnabled(fallback bool) bool {
\tif event.OtelEnabled == nil {
\t\treturn fallback
\t}
\treturn *event.OtelEnabled
}
""",
    """func (event *Event) ResetOtel() *Event {
\treturn event.mutate(func() {
\t\tevent.OtelEnabled = nil
\t})
}

func (event *Event) ResetOTel() *Event { return event.ResetOtel() }

func (event *Event) IsOtelEnabled(fallback bool) bool {
\tevent.mu.Lock()
\tdefer event.mu.Unlock()
\tif event.OtelEnabled == nil {
\t\treturn fallback
\t}
\treturn *event.OtelEnabled
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (logger *Logger) UseOtel() *Logger {
\tlogger.OtelEnabled = true
\treturn logger
}
""",
    """func (logger *Logger) UseOtel() *Logger {
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\tlogger.OtelEnabled = true
\treturn logger
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (logger *Logger) NotOtel() *Logger {
\tlogger.OtelEnabled = false
\treturn logger
}
""",
    """func (logger *Logger) NotOtel() *Logger {
\tlogger.mu.Lock()
\tdefer logger.mu.Unlock()
\tlogger.OtelEnabled = false
\treturn logger
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (event *Event) AddTrace(traceID string, makeFirst ...bool) *Event {
\tvalue := strings.TrimSpace(traceID)
\tif value == "" {
\t\treturn event
\t}
\tif event.TraceID == "" || (len(makeFirst) > 0 && makeFirst[0]) {
\t\tevent.TraceID = value
\t}
\tevent.TraceIDs = appendUnique(event.TraceIDs, value)
\treturn event
}
""",
    """func (event *Event) AddTrace(traceID string, makeFirst ...bool) *Event {
\tvalue := strings.TrimSpace(traceID)
\tif value == "" {
\t\treturn event
\t}
\tprimary := len(makeFirst) > 0 && makeFirst[0]
\treturn event.mutate(func() {
\t\tif event.TraceID == "" || primary {
\t\t\tevent.TraceID = value
\t\t}
\t\tevent.TraceIDs = appendUnique(event.TraceIDs, value)
\t})
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (event *Event) AddRoutineID(routineID string) *Event {
\tevent.RoutineID = routineID
\treturn event
}

func (event *Event) AddTags(tags ...string) *Event {
\tfor _, tag := range tags {
\t\tif value := strings.TrimSpace(tag); value != "" {
\t\t\tevent.Tags = appendUnique(event.Tags, value)
\t\t}
\t}
\treturn event
}

func (event *Event) AddContext(value any) *Event {
\tevent.Context = append(event.Context, value)
\treturn event
}

func (event *Event) AddMeta(value any) *Event {
\tevent.Meta = append(event.Meta, value)
\treturn event
}

func (event *Event) AddLoggedInUserInfo(user map[string]any) *Event {
\tfor key, value := range user {
\t\tevent.LoggedInUser[key] = value
\t}
\treturn event
}

func (event *Event) AddLoggedInUserID(id string) *Event {
\tevent.LoggedInUser["id"] = id
\treturn event
}

func (event *Event) AddUserInfo(user map[string]any) *Event {
\tevent.Users = append(event.Users, cloneMap(user))
\treturn event
}
""",
    """func (event *Event) AddRoutineID(routineID string) *Event {
\treturn event.mutate(func() {
\t\tevent.RoutineID = routineID
\t})
}

func (event *Event) AddTags(tags ...string) *Event {
\tvalues := make([]string, 0, len(tags))
\tfor _, tag := range tags {
\t\tif value := strings.TrimSpace(tag); value != "" {
\t\t\tvalues = append(values, value)
\t\t}
\t}
\treturn event.mutate(func() {
\t\tfor _, value := range values {
\t\t\tevent.Tags = appendUnique(event.Tags, value)
\t\t}
\t})
}

func (event *Event) AddContext(value any) *Event {
\treturn event.mutate(func() {
\t\tevent.Context = append(event.Context, cloneContextAny(value))
\t})
}

func (event *Event) AddMeta(value any) *Event {
\treturn event.mutate(func() {
\t\tevent.Meta = append(event.Meta, cloneContextAny(value))
\t})
}

func (event *Event) AddLoggedInUserInfo(user map[string]any) *Event {
\treturn event.mutate(func() {
\t\tsnapshot := cloneContextMap(user)
\t\tif event.LoggedInUser == nil {
\t\t\tevent.LoggedInUser = make(map[string]any, len(snapshot))
\t\t}
\t\tfor key, value := range snapshot {
\t\t\tevent.LoggedInUser[key] = value
\t\t}
\t})
}

func (event *Event) AddLoggedInUserID(id string) *Event {
\treturn event.mutate(func() {
\t\tif event.LoggedInUser == nil {
\t\t\tevent.LoggedInUser = make(map[string]any, 1)
\t\t}
\t\tevent.LoggedInUser["id"] = id
\t})
}

func (event *Event) AddUserInfo(user map[string]any) *Event {
\treturn event.mutate(func() {
\t\tevent.Users = append(event.Users, cloneContextMap(user))
\t})
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """\tfields := cloneMap(event.Logger.Fields)
\tfor key, value := range event.Fields {
\t\tfields[key] = value
\t}
\tif event.Logger.RuntimeFields != nil {
\t\tfor key, value := range event.Logger.RuntimeFields() {
\t\t\tfields[key] = value
\t\t}
\t}
\tuser := cloneMap(event.Logger.CurrentUser)
""",
    """\tlogger := event.Logger.snapshot()
\tfields := logger.fields
\tfor key, value := range event.Fields {
\t\tfields[key] = value
\t}
\tif logger.runtimeFields != nil {
\t\tfor key, value := range cloneContextMap(logger.runtimeFields()) {
\t\t\tfields[key] = value
\t\t}
\t}
\tuser := logger.currentUser
""",
)

replace_once(
    "sdk/go/logger.go",
    """\t\tID:           event.Logger.IDFactory(),
\t\tTimestamp:    event.Logger.Clock(),
\t\tLevel:        event.Level,
\t\tRuntime:      event.Logger.Runtime,
\t\tAppName:      event.Logger.AppName,
\t\tName:         event.Logger.Name,
""",
    """\t\tID:           logger.idFactory(),
\t\tTimestamp:    logger.clock(),
\t\tLevel:        event.Level,
\t\tRuntime:      logger.runtime,
\t\tAppName:      logger.appName,
\t\tName:         logger.name,
""",
)

replace_once(
    "sdk/go/logger.go",
    """func (logger *Logger) emit(event *Event, store bool) error {
\tlogger.mu.Lock()
\tdelete(logger.unsent, event)
\tlogger.mu.Unlock()
\tif levelIndex[event.Level] < levelIndex[logger.MaxLevel] {
\t\treturn nil
\t}
\trecord := event.ToRecord()
\tif logger.Console {
\t\tfmt.Fprintf(logger.Output, "[%s] [%s] [%s] %s\\n",
\t\t\trecord.Timestamp, record.Level, record.AppName, record.Message)
\t}
\tif !store {
\t\treturn nil
\t}
\tvar failures []error
\tfor _, transport := range logger.Transports {
\t\tif marker, ok := transport.(openTelemetryTransport); ok && marker.IsOpenTelemetry() && !event.IsOtelEnabled(logger.OtelEnabled) {
\t\t\tcontinue
\t\t}
\t\tif err := transport.Write(cloneLogRecord(record)); err != nil {
\t\t\tfailures = append(failures, err)
\t\t}
\t}
\treturn errors.Join(failures...)
}
""",
    """func (logger *Logger) emit(event *Event, store bool) error {
\tlogger.mu.Lock()
\tdelete(logger.unsent, event)
\tlogger.mu.Unlock()
\tstate := logger.snapshot()
\tif levelIndex[event.Level] < levelIndex[state.maxLevel] {
\t\treturn nil
\t}
\trecord := event.ToRecord()
\tif state.console {
\t\tfmt.Fprintf(state.output, "[%s] [%s] [%s] %s\\n",
\t\t\trecord.Timestamp, record.Level, record.AppName, record.Message)
\t}
\tif !store {
\t\treturn nil
\t}
\tvar failures []error
\tfor _, transport := range state.transports {
\t\tif marker, ok := transport.(openTelemetryTransport); ok && marker.IsOpenTelemetry() && !event.IsOtelEnabled(state.otelEnabled) {
\t\t\tcontinue
\t\t}
\t\tif err := transport.Write(cloneLogRecord(record)); err != nil {
\t\t\tfailures = append(failures, err)
\t\t}
\t}
\treturn errors.Join(failures...)
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """\tfor _, transport := range logger.Transports {
\t\tif err := flushTransport(ctx, transport); err != nil {
""",
    """\tfor _, transport := range logger.transportSnapshot() {
\t\tif err := flushTransport(ctx, transport); err != nil {
""",
)

replace_once(
    "sdk/go/logger.go",
    """\tfor _, transport := range logger.Transports {
\t\tif err := flushTransportOnExit(ctx, transport, recovered); err != nil {
""",
    """\tfor _, transport := range logger.transportSnapshot() {
\t\tif err := flushTransportOnExit(ctx, transport, recovered); err != nil {
""",
)

replace_once(
    "sdk/go/logger.go",
    """\t\tfor _, transport := range logger.Transports {
\t\t\tif err := closeTransport(ctx, transport); err != nil {
""",
    """\t\tfor _, transport := range logger.transportSnapshot() {
\t\t\tif err := closeTransport(ctx, transport); err != nil {
""",
)

print("Go event/logger state machine applied")
