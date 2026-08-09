package com.oresoftware.nextloggers;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;

/** Dependency-free next-loggers/v1 logger and explicit OpenTelemetry bridge. */
public final class NextLoggers {
  public static final String SCHEMA = "next-loggers/v1";

  private NextLoggers() {}

  public enum Level {
    TRACE, DEBUG, INFO, WARN, ERROR, FATAL
  }

  public record TraceContext(
      String traceId,
      String spanId,
      int traceFlags,
      String traceState,
      Map<String, String> baggage,
      Map<String, Object> fields,
      List<String> tags) {
    public TraceContext {
      traceId = text(traceId);
      spanId = text(spanId);
      traceState = text(traceState);
      baggage = immutableCopy(baggage);
      fields = immutableCopy(fields);
      tags = tags == null ? List.of() : List.copyOf(tags);
    }

    public TraceContext(String traceId, String spanId, int traceFlags) {
      this(traceId, spanId, traceFlags, "", Map.of(), Map.of(), List.of());
    }
  }

  private static final ThreadLocal<Deque<TraceContext>> CONTEXT =
      ThreadLocal.withInitial(ArrayDeque::new);

  public static Scope withContext(TraceContext context) {
    Objects.requireNonNull(context, "context");
    Deque<TraceContext> stack = CONTEXT.get();
    stack.push(context);
    return new Scope(Thread.currentThread().getId(), stack);
  }

  public static TraceContext currentContext() {
    Deque<TraceContext> stack = CONTEXT.get();
    return stack.isEmpty() ? null : stack.peek();
  }

  public static final class Scope implements AutoCloseable {
    private final long threadId;
    private final Deque<TraceContext> stack;
    private boolean closed;

    private Scope(long threadId, Deque<TraceContext> stack) {
      this.threadId = threadId;
      this.stack = stack;
    }

    @Override
    public void close() {
      if (closed) return;
      if (Thread.currentThread().getId() != threadId) {
        throw new IllegalStateException("next-loggers context scope closed on a different thread");
      }
      if (stack.isEmpty()) {
        throw new IllegalStateException("next-loggers context scope stack underflow");
      }
      stack.pop();
      closed = true;
      if (stack.isEmpty()) CONTEXT.remove();
    }
  }

  public interface Transport {
    void write(LogRecord record) throws Exception;
    default boolean isOpenTelemetry() { return false; }
    default void flush() throws Exception {}
    default void close() throws Exception {}
  }

  /** Explicit application-owned OTEL log adapter; it never installs a global provider. */
  public static final class OtelTransport implements Transport {
    private final java.util.function.Consumer<LogRecord> sink;

    public OtelTransport(java.util.function.Consumer<LogRecord> sink) {
      this.sink = Objects.requireNonNull(sink, "sink");
    }

    @Override
    public void write(LogRecord record) {
      sink.accept(record);
    }

    @Override
    public boolean isOpenTelemetry() {
      return true;
    }
  }

  public static final class MemoryTransport implements Transport {
    private final List<LogRecord> records = new CopyOnWriteArrayList<>();
    private volatile boolean closed;

    @Override
    public void write(LogRecord record) {
      if (closed) throw new IllegalStateException("transport is closed");
      records.add(record);
    }

    public List<LogRecord> records() {
      return List.copyOf(records);
    }

    @Override
    public void close() {
      closed = true;
    }
  }

  public record LogRecord(
      String schema,
      String id,
      String timestamp,
      Level level,
      String runtime,
      String appName,
      String name,
      String message,
      List<Object> values,
      Map<String, Object> fields,
      Map<String, Object> loggedInUser,
      List<Map<String, Object>> users,
      String traceId,
      List<String> traceIds,
      String routineId,
      List<String> tags,
      List<Object> context,
      List<Object> meta,
      List<Object> errors,
      List<String> stackTrace) {
    public LogRecord {
      schema = text(schema);
      id = text(id);
      timestamp = text(timestamp);
      runtime = text(runtime);
      appName = text(appName);
      name = text(name);
      message = text(message);
      values = values == null ? List.of() : List.copyOf(values);
      fields = immutableCopy(fields);
      loggedInUser = immutableCopy(loggedInUser);
      users = users == null ? List.of() : List.copyOf(users);
      traceId = text(traceId);
      traceIds = traceIds == null ? List.of() : List.copyOf(traceIds);
      routineId = text(routineId);
      tags = tags == null ? List.of() : List.copyOf(tags);
      context = context == null ? List.of() : List.copyOf(context);
      meta = meta == null ? List.of() : List.copyOf(meta);
      errors = errors == null ? List.of() : List.copyOf(errors);
      stackTrace = stackTrace == null ? List.of() : List.copyOf(stackTrace);
    }

    public String toJson() {
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("schema", schema);
      result.put("id", id);
      result.put("timestamp", timestamp);
      result.put("level", level.name());
      result.put("runtime", runtime);
      result.put("appName", appName);
      if (!name.isEmpty()) result.put("name", name);
      result.put("message", message);
      result.put("values", values);
      result.put("fields", fields);
      if (!loggedInUser.isEmpty()) result.put("loggedInUser", loggedInUser);
      if (!users.isEmpty()) result.put("users", users);
      if (!traceId.isEmpty()) result.put("traceId", traceId);
      if (!traceIds.isEmpty()) result.put("traceIds", traceIds);
      if (!routineId.isEmpty()) result.put("routineId", routineId);
      if (!tags.isEmpty()) result.put("tags", tags);
      if (!context.isEmpty()) result.put("context", context);
      if (!meta.isEmpty()) result.put("meta", meta);
      if (!errors.isEmpty()) result.put("errors", errors);
      if (!stackTrace.isEmpty()) result.put("stackTrace", stackTrace);
      return Json.encode(result);
    }
  }

  public static final class Options {
    public String appName = "app";
    public String name = "";
    public String runtime = "java";
    public Level minimumLevel = Level.INFO;
    public Map<String, Object> fields = Map.of();
    public Map<String, Object> loggedInUser = Map.of();
    public List<Transport> transports = List.of();
    public boolean console = true;
    public boolean otelEnabled = true;
    public Supplier<String> idFactory = () -> UUID.randomUUID().toString();
    public Clock clock = Clock.systemUTC();

    public Options appName(String value) { appName = value; return this; }
    public Options name(String value) { name = value; return this; }
    public Options runtime(String value) { runtime = value; return this; }
    public Options minimumLevel(Level value) { minimumLevel = value; return this; }
    public Options fields(Map<String, Object> value) { fields = value; return this; }
    public Options loggedInUser(Map<String, Object> value) { loggedInUser = value; return this; }
    public Options transports(List<Transport> value) { transports = value; return this; }
    public Options transport(Transport value) { transports = List.of(value); return this; }
    public Options console(boolean value) { console = value; return this; }
    public Options otelEnabled(boolean value) { otelEnabled = value; return this; }
    public Options idFactory(Supplier<String> value) { idFactory = value; return this; }
    public Options clock(Clock value) { clock = value; return this; }
  }

  public static final class Logger implements AutoCloseable {
    private final String appName;
    private final String name;
    private final String runtime;
    private final Level minimumLevel;
    private final boolean console;
    private final Supplier<String> idFactory;
    private final Clock clock;
    private final Map<String, Object> fields;
    private final Map<String, Object> currentUser;
    private final List<Transport> transports;
    private volatile boolean otelEnabled;
    private volatile boolean closed;

    public Logger(Options options) {
      Objects.requireNonNull(options, "options");
      appName = options.appName == null || options.appName.isBlank() ? "app" : options.appName;
      name = text(options.name);
      runtime = options.runtime == null || options.runtime.isBlank() ? "java" : options.runtime;
      minimumLevel = Objects.requireNonNullElse(options.minimumLevel, Level.INFO);
      console = options.console;
      idFactory = Objects.requireNonNull(options.idFactory, "idFactory");
      clock = Objects.requireNonNull(options.clock, "clock");
      fields = Collections.synchronizedMap(mutableCopy(options.fields));
      currentUser = Collections.synchronizedMap(mutableCopy(options.loggedInUser));
      transports = List.copyOf(options.transports == null ? List.of() : options.transports);
      otelEnabled = options.otelEnabled;
    }

    public Event trace(Object... values) { return event(Level.TRACE, values); }
    public Event debug(Object... values) { return event(Level.DEBUG, values); }
    public Event info(Object... values) { return event(Level.INFO, values); }
    public Event warn(Object... values) { return event(Level.WARN, values); }
    public Event error(Object... values) { return event(Level.ERROR, values); }
    public Event fatal(Object... values) { return event(Level.FATAL, values); }

    private Event event(Level level, Object[] values) {
      if (closed) throw new IllegalStateException("next-loggers logger is closed");
      return new Event(this, level, values == null ? List.of() : List.of(values));
    }

    public Logger addFields(Map<String, Object> values) {
      if (values != null) fields.putAll(values);
      return this;
    }

    public Logger setCurrentUser(Map<String, Object> values) {
      if (values != null) currentUser.putAll(values);
      return this;
    }

    public boolean isOtelEnabled() { return otelEnabled; }
    public Logger useOtel() { otelEnabled = true; return this; }
    public Logger notOtel() { otelEnabled = false; return this; }

    private boolean enabled(Level level) {
      return level.ordinal() >= minimumLevel.ordinal();
    }

    private void emit(LogRecord record, boolean eventOtelEnabled) {
      if (!enabled(record.level())) return;
      if (console) {
        System.out.printf("[%s] [%s] [%s] %s%n", record.timestamp(), record.level(), appName, record.message());
      }
      RuntimeException failure = null;
      for (Transport transport : transports) {
        if (transport.isOpenTelemetry() && !eventOtelEnabled) continue;
        try {
          transport.write(record);
        } catch (Exception error) {
          if (failure == null) failure = new RuntimeException("next-loggers transport failure");
          failure.addSuppressed(error);
        }
      }
      if (failure != null) throw failure;
    }

    public void flush() {
      RuntimeException failure = null;
      for (Transport transport : transports) {
        try {
          transport.flush();
        } catch (Exception error) {
          if (failure == null) failure = new RuntimeException("next-loggers flush failure");
          failure.addSuppressed(error);
        }
      }
      if (failure != null) throw failure;
    }

    @Override
    public void close() {
      if (closed) return;
      flush();
      RuntimeException failure = null;
      for (Transport transport : transports) {
        try {
          transport.close();
        } catch (Exception error) {
          if (failure == null) failure = new RuntimeException("next-loggers close failure");
          failure.addSuppressed(error);
        }
      }
      closed = true;
      if (failure != null) throw failure;
    }
  }

  public static final class Event {
    private final Logger logger;
    private final Level level;
    private final List<Object> values;
    private final Map<String, Object> fields = new LinkedHashMap<>();
    private final Map<String, Object> loggedInUser = new LinkedHashMap<>();
    private final List<Map<String, Object>> users = new ArrayList<>();
    private final Set<String> traceIds = new LinkedHashSet<>();
    private final Set<String> tags = new LinkedHashSet<>();
    private final List<Object> context = new ArrayList<>();
    private final List<Object> meta = new ArrayList<>();
    private final List<Object> errors = new ArrayList<>();
    private final List<String> stackTrace = new ArrayList<>();
    private String traceId = "";
    private String routineId = "";
    private LogRecord record;
    private boolean sent;
    private Boolean otelEnabled;

    private Event(Logger logger, Level level, List<Object> values) {
      this.logger = logger;
      this.level = level;
      this.values = List.copyOf(values);
    }

    public Event addFields(Map<String, Object> values) { if (values != null) fields.putAll(values); return this; }
    public Event addTrace(String value) {
      String normalized = text(value);
      if (!normalized.isEmpty()) {
        if (traceId.isEmpty()) traceId = normalized;
        traceIds.add(normalized);
      }
      return this;
    }
    public Event addTags(String... values) {
      if (values != null) for (String value : values) if (!text(value).isEmpty()) tags.add(value);
      return this;
    }
    public Event addRoutineId(String value) { routineId = text(value); return this; }
    public Event addContext(Object value) { context.add(value); return this; }
    public Event addMeta(Object value) { meta.add(value); return this; }
    public Event addUser(Map<String, Object> value) { users.add(immutableCopy(value)); return this; }
    public Event setLoggedInUser(Map<String, Object> value) { if (value != null) loggedInUser.putAll(value); return this; }
    public Event useOtel() { otelEnabled = true; return this; }
    public Event notOtel() { otelEnabled = false; return this; }
    public Event withOtel(boolean value) { otelEnabled = value; return this; }
    public Event resetOtel() { otelEnabled = null; return this; }
    public boolean isOtelEnabled() {
      return otelEnabled == null ? logger.isOtelEnabled() : otelEnabled;
    }

    public synchronized LogRecord toRecord() {
      if (record != null) return record;
      Map<String, Object> mergedFields;
      Map<String, Object> mergedUser;
      synchronized (logger.fields) { mergedFields = mutableCopy(logger.fields); }
      synchronized (logger.currentUser) { mergedUser = mutableCopy(logger.currentUser); }
      TraceContext ambient = currentContext();
      if (ambient != null) {
        mergedFields.putAll(ambient.fields());
        if (!ambient.spanId().isEmpty()) mergedFields.put("otel.span_id", ambient.spanId());
        mergedFields.put("otel.trace_flags", ambient.traceFlags());
        if (!ambient.traceState().isEmpty()) mergedFields.put("otel.trace_state", ambient.traceState());
        if (!ambient.baggage().isEmpty()) mergedFields.put("otel.baggage", ambient.baggage());
        if (traceId.isEmpty() && !ambient.traceId().isEmpty()) traceId = ambient.traceId();
        if (!ambient.traceId().isEmpty()) traceIds.add(ambient.traceId());
        tags.add("otel");
        tags.addAll(ambient.tags());
      }
      mergedFields.putAll(fields);
      mergedUser.putAll(loggedInUser);
      List<Object> normalizedValues = values.stream().map(NextLoggers::normalize).toList();
      List<Object> foundErrors = new ArrayList<>(errors);
      for (Object value : values) if (value instanceof Throwable error) foundErrors.add(normalize(error));
      String message = values.stream().map(NextLoggers::messagePart).reduce((a, b) -> a + " " + b).orElse("");
      record = new LogRecord(
          SCHEMA,
          logger.idFactory.get(),
          Instant.now(logger.clock).toString(),
          level,
          logger.runtime,
          logger.appName,
          logger.name,
          message,
          normalizedValues,
          mergedFields,
          mergedUser,
          users,
          traceId,
          List.copyOf(traceIds),
          routineId,
          List.copyOf(tags),
          context.stream().map(NextLoggers::normalize).toList(),
          meta.stream().map(NextLoggers::normalize).toList(),
          foundErrors.stream().map(NextLoggers::normalize).toList(),
          stackTrace);
      return record;
    }

    public synchronized LogRecord send() {
      if (sent) return toRecord();
      sent = true;
      LogRecord value = toRecord();
      logger.emit(value, isOtelEnabled());
      return value;
    }
  }

  public interface OtelSpan {
    TraceContext context();
    default boolean isRecording() { return true; }
    void recordException(Throwable error);
    void setStatus(int code, String description);
    void end();
  }

  public interface OtelTracer {
    OtelSpan startSpan(String name, Map<String, Object> attributes);
  }

  @FunctionalInterface
  public interface SpanFunction<T> {
    T apply(OtelSpan span) throws Exception;
  }

  private static final OtelSpan NOOP_SPAN = new OtelSpan() {
    private final TraceContext context = new TraceContext("", "", 0);
    @Override public TraceContext context() { return context; }
    @Override public boolean isRecording() { return false; }
    @Override public void recordException(Throwable error) {}
    @Override public void setStatus(int code, String description) {}
    @Override public void end() {}
  };

  public static <T> T withSpan(
      Logger logger,
      OtelTracer tracer,
      String name,
      Map<String, Object> attributes,
      SpanFunction<T> callback) throws Exception {
    Objects.requireNonNull(logger, "logger");
    Objects.requireNonNull(tracer, "tracer");
    Objects.requireNonNull(callback, "callback");

    OtelSpan span;
    try {
      span = Objects.requireNonNull(tracer.startSpan(name, immutableCopy(attributes)), "span");
    } catch (Throwable error) {
      logBridgeFailure(logger, "start span", name, error);
      return callback.apply(NOOP_SPAN);
    }

    TraceContext context;
    try {
      context = Objects.requireNonNullElse(span.context(), new TraceContext("", "", 0));
    } catch (Throwable error) {
      logBridgeFailure(logger, "read span context", name, error);
      context = new TraceContext("", "", 0);
    }

    long started = System.nanoTime();
    Scope scope = withContext(context);
    try {
      sendSafely(logger.debug("span started:", name)
          .addFields(Map.of("otel.span_name", name, "otel.span_phase", "start"))
          .addTags("otel-span"));
      try {
        T result = callback.apply(span);
        if (spanRecordingSafely(logger, span, name)) {
          invokeSpanSafely(logger, span, name, "set success status", () -> span.setStatus(1, ""));
        }
        sendSafely(logger.debug("span completed:", name)
            .addFields(Map.of(
                "otel.span_name", name,
                "otel.span_phase", "end",
                "otel.duration_ms", (System.nanoTime() - started) / 1_000_000.0))
            .addTags("otel-span"));
        return result;
      } catch (Throwable error) {
        if (spanRecordingSafely(logger, span, name)) {
          invokeSpanSafely(logger, span, name, "record exception", () -> span.recordException(error));
          invokeSpanSafely(
              logger,
              span,
              name,
              "set error status",
              () -> span.setStatus(2, error.getMessage() == null ? "" : error.getMessage()));
        }
        sendSafely(logger.error("span failed:", name, error)
            .addFields(Map.of(
                "otel.span_name", name,
                "otel.span_phase", "error",
                "otel.duration_ms", (System.nanoTime() - started) / 1_000_000.0))
            .addTags("otel-span"));
        if (error instanceof Exception exception) throw exception;
        if (error instanceof Error fatal) throw fatal;
        throw new RuntimeException(error);
      } finally {
        invokeSpanSafely(logger, span, name, "end span", span::end);
      }
    } finally {
      scope.close();
    }
  }

  private static void invokeSpanSafely(
      Logger logger, OtelSpan span, String name, String operation, Runnable action) {
    try {
      action.run();
    } catch (Throwable error) {
      logBridgeFailure(logger, operation, name, error);
    }
  }

  private static boolean spanRecordingSafely(Logger logger, OtelSpan span, String name) {
    try {
      return span.isRecording();
    } catch (Throwable error) {
      logBridgeFailure(logger, "read recording state", name, error);
      return false;
    }
  }

  private static void logBridgeFailure(
      Logger logger, String operation, String name, Throwable error) {
    sendSafely(logger.warn("OpenTelemetry", operation, "failed:", error)
        .addFields(Map.of(
            "otel.bridge_operation", operation,
            "otel.span_name", name))
        .addTags("otel-span", "otel-bridge-error"));
  }

  private static void sendSafely(Event event) {
    try {
      event.send();
    } catch (Throwable ignored) {
      // Telemetry failure cannot replace the application result.
    }
  }

  private static String text(String value) { return value == null ? "" : value; }

  private static <K, V> Map<K, V> immutableCopy(Map<K, V> value) {
    return value == null || value.isEmpty() ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(value));
  }

  private static <K, V> Map<K, V> mutableCopy(Map<K, V> value) {
    return value == null ? new LinkedHashMap<>() : new LinkedHashMap<>(value);
  }

  private static String messagePart(Object value) {
    if (value instanceof String string) return string;
    if (value instanceof Throwable error) return text(error.getMessage());
    return Json.encode(normalize(value));
  }

  private static Object normalize(Object value) {
    if (value == null || value instanceof String || value instanceof Number || value instanceof Boolean) return value;
    if (value instanceof Throwable error) {
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("name", error.getClass().getName());
      result.put("message", text(error.getMessage()));
      return result;
    }
    if (value instanceof Map<?, ?> map) {
      Map<String, Object> result = new LinkedHashMap<>();
      for (Map.Entry<?, ?> entry : map.entrySet()) result.put(String.valueOf(entry.getKey()), normalize(entry.getValue()));
      return result;
    }
    if (value instanceof Collection<?> collection) return collection.stream().map(NextLoggers::normalize).toList();
    if (value.getClass().isArray()) {
      int length = java.lang.reflect.Array.getLength(value);
      List<Object> result = new ArrayList<>(length);
      for (int index = 0; index < length; index++) result.add(normalize(java.lang.reflect.Array.get(value, index)));
      return result;
    }
    return String.valueOf(value);
  }

  private static final class Json {
    static String encode(Object value) {
      StringBuilder builder = new StringBuilder();
      append(builder, value);
      return builder.toString();
    }

    private static void append(StringBuilder builder, Object value) {
      if (value == null) { builder.append("null"); return; }
      if (value instanceof String string) { quote(builder, string); return; }
      if (value instanceof Boolean || value instanceof Number) { builder.append(value); return; }
      if (value instanceof Map<?, ?> map) {
        builder.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
          if (!first) builder.append(',');
          first = false;
          quote(builder, String.valueOf(entry.getKey()));
          builder.append(':');
          append(builder, entry.getValue());
        }
        builder.append('}');
        return;
      }
      if (value instanceof Iterable<?> iterable) {
        builder.append('[');
        boolean first = true;
        for (Object entry : iterable) {
          if (!first) builder.append(',');
          first = false;
          append(builder, entry);
        }
        builder.append(']');
        return;
      }
      quote(builder, String.valueOf(value));
    }

    private static void quote(StringBuilder builder, String value) {
      builder.append('"');
      for (int index = 0; index < value.length(); index++) {
        char character = value.charAt(index);
        switch (character) {
          case '"' -> builder.append("\\\"");
          case '\\' -> builder.append("\\\\");
          case '\b' -> builder.append("\\b");
          case '\f' -> builder.append("\\f");
          case '\n' -> builder.append("\\n");
          case '\r' -> builder.append("\\r");
          case '\t' -> builder.append("\\t");
          default -> {
            if (character < 0x20) builder.append(String.format("\\u%04x", (int) character));
            else builder.append(character);
          }
        }
      }
      builder.append('"');
    }
  }
}
