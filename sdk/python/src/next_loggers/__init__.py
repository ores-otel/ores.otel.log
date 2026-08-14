"""Python implementation of the next-loggers/v1 contract."""

from __future__ import annotations

import json
import sys
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Protocol, Sequence

SCHEMA = "next-loggers/v1"


class LogLevel(str, Enum):
    TRACE = "TRACE"
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARN = "WARN"
    ERROR = "ERROR"
    FATAL = "FATAL"


LEVELS: Sequence[LogLevel] = tuple(LogLevel)
_LEVEL_INDEX = {level: index for index, level in enumerate(LEVELS)}
OTEL_SEVERITY_NUMBERS = {
    LogLevel.TRACE: 1,
    LogLevel.DEBUG: 5,
    LogLevel.INFO: 9,
    LogLevel.WARN: 13,
    LogLevel.ERROR: 17,
    LogLevel.FATAL: 21,
}


def _normalize_level(level: Any) -> LogLevel:
    value = str(getattr(level, "value", level) or "INFO").upper()
    try:
        return LogLevel(value)
    except ValueError:
        return LogLevel.INFO


def _default_clock() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, BaseException):
        return {"name": type(value).__name__, "message": str(value)}
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_value(item) for item in value]
    if hasattr(value, "__dict__"):
        return _json_value(vars(value))
    return str(value)


def _message_part(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, BaseException):
        return str(value)
    normalized = _json_value(value)
    if normalized is None:
        return "null"
    if normalized is True:
        return "true"
    if normalized is False:
        return "false"
    if isinstance(normalized, (dict, list)):
        return json.dumps(normalized, separators=(",", ":"), sort_keys=True)
    return str(normalized)


@dataclass(frozen=True)
class LogRecord:
    id: str
    timestamp: str
    level: LogLevel
    runtime: str
    app_name: str
    message: str
    values: List[Any]
    fields: Dict[str, Any]
    name: Optional[str] = None
    logged_in_user: Optional[Dict[str, Any]] = None
    users: List[Dict[str, Any]] = field(default_factory=list)
    trace_id: Optional[str] = None
    trace_ids: List[str] = field(default_factory=list)
    routine_id: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    context: List[Any] = field(default_factory=list)
    meta: List[Any] = field(default_factory=list)
    errors: List[Any] = field(default_factory=list)
    stack_trace: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        record: Dict[str, Any] = {
            "schema": SCHEMA,
            "id": self.id,
            "timestamp": self.timestamp,
            "level": self.level.value,
            "runtime": self.runtime,
            "appName": self.app_name,
            "message": self.message,
            "values": self.values,
            "fields": self.fields,
        }
        optional = (
            ("name", self.name),
            ("loggedInUser", self.logged_in_user),
            ("users", self.users),
            ("traceId", self.trace_id),
            ("traceIds", self.trace_ids),
            ("routineId", self.routine_id),
            ("tags", self.tags),
            ("context", self.context),
            ("meta", self.meta),
            ("errors", self.errors),
            ("stackTrace", self.stack_trace),
        )
        for key, value in optional:
            if value is not None and value != [] and value != {} and value != "":
                record[key] = value
        return record

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"), sort_keys=True)


class Transport(Protocol):
    def write(self, record: LogRecord) -> None:
        """Deliver one complete record."""


class MemoryTransport:
    name = "memory"

    def __init__(self) -> None:
        self.records: List[LogRecord] = []
        self.closed = False
        self.flush_count = 0
        self.exit_records: List[LogRecord] = []

    def write(self, record: LogRecord) -> None:
        if self.closed:
            raise RuntimeError("transport is closed")
        self.records.append(record)

    def flush(self) -> None:
        self.flush_count += 1

    def flush_on_exit(self, records: Sequence[LogRecord]) -> None:
        self.exit_records.extend(records)

    def close(self) -> None:
        self.closed = True


class OpenTelemetryTransport:
    """Dependency-free adapter for an application-owned OTEL log emitter."""

    name = "opentelemetry"
    is_open_telemetry = True

    def __init__(self, emit: Callable[[Dict[str, Any]], None]) -> None:
        if not callable(emit):
            raise TypeError("OpenTelemetryTransport requires a callable emitter")
        self.emit = emit

    def write(self, record: LogRecord) -> None:
        attributes: Dict[str, Any] = {
            "service.name": record.app_name,
            "next_logger.schema": SCHEMA,
            "next_logger.runtime": record.runtime,
            "log.record.uid": record.id,
        }
        if record.trace_id:
            attributes["trace.id"] = record.trace_id
        for key, value in record.fields.items():
            attributes[f"next_logger.field.{key}"] = value
        self.emit(
            {
                "body": record.message,
                "severityText": record.level.value,
                "severityNumber": OTEL_SEVERITY_NUMBERS[record.level],
                "timestamp": record.timestamp,
                "attributes": attributes,
            }
        )


OtelTransport = OpenTelemetryTransport


class SupabaseTransport:
    """Adapter for an application-owned authenticated Supabase sender."""

    name = "supabase"

    def __init__(self, send: Callable[[Dict[str, Any]], None]) -> None:
        if not callable(send):
            raise TypeError("SupabaseTransport requires a callable sender")
        self.send_record = send

    def write(self, record: LogRecord) -> None:
        self.send_record(record.to_dict())


class LogEvent:
    """Extensible chainable event. ``send`` is idempotent."""

    def __init__(self, logger: "Logger", level: LogLevel, values: Sequence[Any]) -> None:
        self.logger = logger
        self.level = level
        self.values = list(values)
        self.fields: Dict[str, Any] = {}
        self.logged_in_user: Dict[str, Any] = {}
        self.users: List[Dict[str, Any]] = []
        self.trace_id = ""
        self.trace_ids: List[str] = []
        self.routine_id = ""
        self.tags: List[str] = []
        self.context: List[Any] = []
        self.meta: List[Any] = []
        self.stack_trace: List[str] = []
        self._record: Optional[LogRecord] = None
        self._sent = False
        self._otel_enabled: Optional[bool] = None

    def add_fields(self, fields: Mapping[str, Any]) -> "LogEvent":
        self.fields.update(fields)
        return self

    def use_otel(self) -> "LogEvent":
        return self.with_otel(True)

    def not_otel(self) -> "LogEvent":
        return self.with_otel(False)

    def with_otel(self, enabled: bool) -> "LogEvent":
        self._otel_enabled = bool(enabled)
        return self

    def reset_otel(self) -> "LogEvent":
        self._otel_enabled = None
        return self

    def is_otel_enabled(self, fallback: bool = True) -> bool:
        return fallback if self._otel_enabled is None else self._otel_enabled

    def add_trace(self, trace_id: str, make_first: bool = False) -> "LogEvent":
        value = str(trace_id or "").strip()
        if not value:
            return self
        if not self.trace_id or make_first:
            self.trace_id = value
        if value not in self.trace_ids:
            self.trace_ids.append(value)
        return self

    def add_trace_id(self, trace_id: str, make_first: bool = False) -> "LogEvent":
        return self.add_trace(trace_id, make_first)

    def add_routine_id(self, routine_id: str) -> "LogEvent":
        self.routine_id = str(routine_id or "")
        return self

    def add_tags(self, *tags: str) -> "LogEvent":
        for tag in tags:
            value = str(tag or "").strip()
            if value and value not in self.tags:
                self.tags.append(value)
        return self

    def add_context(self, value: Any) -> "LogEvent":
        self.context.append(value)
        return self

    def add_meta(self, value: Any) -> "LogEvent":
        self.meta.append(value)
        return self

    def add_logged_in_user_info(self, user: Mapping[str, Any]) -> "LogEvent":
        self.logged_in_user.update(user)
        return self

    def add_logged_in_user_id(self, user_id: str) -> "LogEvent":
        self.logged_in_user["id"] = user_id
        return self

    def add_user_info(self, user: Mapping[str, Any]) -> "LogEvent":
        self.users.append(dict(user))
        return self

    def capture_stack_trace(self) -> "LogEvent":
        self.stack_trace.extend(
            line.rstrip("\n") for line in traceback.format_stack()[:-1]
        )
        return self

    def to_record(self) -> LogRecord:
        if self._record is not None:
            return self._record
        current_user = dict(self.logger.current_user)
        current_user.update(self.logged_in_user)
        errors = [_json_value(value) for value in self.values if isinstance(value, BaseException)]
        fields = dict(self.logger.fields)
        fields.update(self.fields)
        self._record = LogRecord(
            id=self.logger.id_factory(),
            timestamp=self.logger.clock(),
            level=self.level,
            runtime=self.logger.runtime,
            app_name=self.logger.app_name,
            name=self.logger.name,
            message=" ".join(_message_part(value) for value in self.values),
            values=[_json_value(value) for value in self.values],
            fields=_json_value(fields),
            logged_in_user=_json_value(current_user) if current_user else None,
            users=[_json_value(user) for user in self.users],
            trace_id=self.trace_id or None,
            trace_ids=list(self.trace_ids),
            routine_id=self.routine_id or None,
            tags=list(self.tags),
            context=[_json_value(value) for value in self.context],
            meta=[_json_value(value) for value in self.meta],
            errors=errors,
            stack_trace=list(self.stack_trace),
        )
        return self._record

    def send(self, store: bool = True) -> Optional[LogRecord]:
        if self._sent:
            return self._record
        self._sent = True
        return self.logger._emit(self, store)


class Logger:
    """Base logger shared by native Python subclasses and transports."""

    def __init__(
        self,
        *,
        app_name: str = "app",
        name: Optional[str] = None,
        runtime: str = "python",
        max_level: Any = LogLevel.INFO,
        fields: Optional[Mapping[str, Any]] = None,
        logged_in_user: Optional[Mapping[str, Any]] = None,
        transports: Optional[Iterable[Transport]] = None,
        console: bool = True,
        otel: bool = True,
        id_factory: Callable[[], str] = lambda: str(uuid.uuid4()),
        clock: Callable[[], str] = _default_clock,
    ) -> None:
        self.app_name = app_name
        self.name = name
        self.runtime = runtime
        self.max_level = _normalize_level(max_level)
        self.fields = dict(fields or {})
        self.current_user = dict(logged_in_user or {})
        self.transports = list(transports or [])
        self.console = console
        self.otel_enabled = bool(otel)
        self.id_factory = id_factory
        self.clock = clock
        self._unsent: set[LogEvent] = set()
        self._closed = False
        self._lock = threading.RLock()

    def create_event(self, level: LogLevel, values: Sequence[Any]) -> LogEvent:
        return LogEvent(self, level, values)

    def _event(self, level: LogLevel, values: Sequence[Any]) -> LogEvent:
        with self._lock:
            if self._closed:
                raise RuntimeError("logger is closed")
            event = self.create_event(level, values)
            self._unsent.add(event)
            return event

    def trace(self, *values: Any) -> LogEvent:
        return self._event(LogLevel.TRACE, values)

    def debug(self, *values: Any) -> LogEvent:
        return self._event(LogLevel.DEBUG, values)

    def info(self, *values: Any) -> LogEvent:
        return self._event(LogLevel.INFO, values)

    def log(self, *values: Any) -> LogEvent:
        return self.info(*values)

    def warn(self, *values: Any) -> LogEvent:
        return self._event(LogLevel.WARN, values)

    def error(self, *values: Any) -> LogEvent:
        return self._event(LogLevel.ERROR, values)

    def fatal(self, *values: Any) -> LogEvent:
        return self._event(LogLevel.FATAL, values)

    def add_fields(self, fields: Mapping[str, Any]) -> "Logger":
        with self._lock:
            self.fields.update(fields)
        return self

    def set_current_user(self, user: Mapping[str, Any]) -> "Logger":
        with self._lock:
            self.current_user.update(user)
        return self

    def use_otel(self) -> "Logger":
        return self.set_otel_enabled(True)

    def not_otel(self) -> "Logger":
        return self.set_otel_enabled(False)

    def set_otel_enabled(self, enabled: bool) -> "Logger":
        self.otel_enabled = bool(enabled)
        return self

    def is_otel_enabled(self) -> bool:
        return self.otel_enabled

    def _enabled(self, level: LogLevel) -> bool:
        return _LEVEL_INDEX[level] >= _LEVEL_INDEX[self.max_level]

    def _emit(self, event: LogEvent, store: bool) -> Optional[LogRecord]:
        with self._lock:
            self._unsent.discard(event)
        if not self._enabled(event.level):
            return None
        record = event.to_record()
        if self.console:
            print(
                "[{0}] [{1}] [{2}] {3}".format(
                    record.timestamp, record.level.value, record.app_name, record.message
                ),
                file=sys.stderr if record.level in (LogLevel.ERROR, LogLevel.FATAL) else sys.stdout,
            )
        if store:
            for transport in self.transports:
                if (
                    getattr(transport, "is_open_telemetry", False)
                    and not event.is_otel_enabled(self.otel_enabled)
                ):
                    continue
                transport.write(record)
        return record

    def flush(self, send_unsent: bool = False) -> None:
        if send_unsent:
            for event in list(self._unsent):
                event.send()
        for transport in self.transports:
            flush = getattr(transport, "flush", None)
            if callable(flush):
                flush()

    def flush_on_exit(self) -> None:
        recovered: List[LogRecord] = []
        for event in list(self._unsent):
            record = event.send()
            if record is not None:
                recovered.append(record)
        for transport in self.transports:
            flush_on_exit = getattr(transport, "flush_on_exit", None)
            if callable(flush_on_exit):
                flush_on_exit(tuple(recovered))
        self.flush()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
        self.flush_on_exit()
        for transport in self.transports:
            close = getattr(transport, "close", None)
            if callable(close):
                close()
        with self._lock:
            self._closed = True

    def __enter__(self) -> "Logger":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def create_logger(**options: Any) -> Logger:
    return Logger(**options)


__all__ = [
    "LEVELS",
    "OTEL_SEVERITY_NUMBERS",
    "SCHEMA",
    "LogEvent",
    "LogLevel",
    "LogRecord",
    "Logger",
    "MemoryTransport",
    "OpenTelemetryTransport",
    "OtelTransport",
    "SupabaseTransport",
    "Transport",
    "create_logger",
]
