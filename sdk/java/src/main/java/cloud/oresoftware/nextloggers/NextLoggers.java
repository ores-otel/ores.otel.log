package cloud.oresoftware.nextloggers;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.function.Consumer;

/** Dependency-free Java implementation of the next-loggers/v1 contract. */
public final class NextLoggers {
  public static final String SCHEMA = "next-loggers/v1";
  private static final ThreadLocal<Context> CONTEXT = new ThreadLocal<>();

  private NextLoggers() {}

  public enum Level {
    TRACE(1), DEBUG(5), INFO(9), WARN(13), ERROR(17), FATAL(21);

    private final int otelSeverityNumber;

    Level(int otelSeverityNumber) {
      this.otelSeverityNumber = otelSeverityNumber;
    }

    public int otelSeverityNumber() {
      return otelSeverityNumber;
    }
  }

  public record Context(
      String traceId,
      String spanId,
      int traceFlags,
      String traceState,
      Map<String, Object> fields,
      List<String> tags) {
    public Context {
      fields = immutableCopy(fields);
      tags = tags == null ? List.of() : List.copyOf(tags);
    }

    public static Context trace(String traceId, String spanId) {
      return new Context(traceId, spanId, 1, null, Map.of(), List.of("otel"));
    }
  }

  public static Context currentContext() {
    return CONTEXT.get();
  }

  /** Scoped ThreadLocal context; always restores the prior frame. */
  public static <T> T withContext(Context context, Callable<T> callback) throws Exception {
    Objects.requireNonNull(callback, "callback");
    Context previous = CONTEXT.get();
    if (context == null) {
      CONTEXT.remove();
    } else {
      CONTEXT.set(context);
    }
    try {
      return callback.call();
    } finally {
      if (previous == null) {
        CONTEXT.remove();
      } else {
        CONTEXT.set(previous);
      }
    }
  }

  @FunctionalInterface
  public interface Transport {
    void write(Map<String, Object> record) throws Exception;

    default boolean isOpenTelemetry() {
      return false;
    }
  }

  /** Application-owned OTEL sink. No global provider or instrumentation is installed. */
  public static final class OtelTransport implements Transport {
    private final Consumer<Map<String, Object>> sink;

    public OtelTransport(Consumer<Map<String, Object>> sink) {
      this.sink = Objects.requireNonNull(sink, "sink");
    }

    @Override
    public void write(Map<String, Object> record) {
      Level level = Level.valueOf(String.valueOf(record.get("level")));
      Map<String, Object> attributes = new LinkedHashMap<>();
      attributes.put("service.name", record.get("appName"));
      attributes.put("next_logger.schema", record.get("schema"));
      attributes.put("next_logger.runtime", record.get("runtime"));
      attributes.put("log.record.uid", record.get("id"));
      copyIfPresent(record, attributes, "traceId", "trace.id");
      Object fields = record.get("fields");
      if (fields instanceof Map<?, ?> map) {
        map.forEach((key, value) -> attributes.put("next_logger.field." + key, value));
      }
      Map<String, Object> otelRecord = new LinkedHashMap<>();
      otelRecord.put("body", record.get("message"));
      otelRecord.put("severityText", level.name());
      otelRecord.put("severityNumber", level.otelSeverityNumber());
      otelRecord.put("timestamp", record.get("timestamp"));
      otelRecord.put("attributes", Collections.unmodifiableMap(attributes));
      sink.accept(Collections.unmodifiableMap(otelRecord));
    }

    @Override
    public boolean isOpenTelemetry() {
      return true;
    }
  }

  /** Client-safe Supabase transport; the application supplies its authenticated sender. */
  public static final class SupabaseTransport implements Transport {
    private final Consumer<Map<String, Object>> sender;

    public SupabaseTransport(Consumer<Map<String, Object>> sender) {
      this.sender = Objects.requireNonNull(sender, "sender");
    }

    @Override
    public void write(Map<String, Object> record) {
      sender.accept(record);
    }
  }

  /** One unsent event whose OTEL decision may override its logger default. */
  public static final class LogEvent {
    private final Logger logger;
    private final Level level;
    private final String message;
    private final Map<String, Object> fields;
    private final Context context;
    private Boolean otelEnabled;

    private LogEvent(Logger logger, Level level, String message, Map<String, Object> fields) {
      this.logger = logger;
      this.level = Objects.requireNonNull(level, "level");
      this.message = message;
      this.fields = immutableCopy(fields);
      this.context = currentContext();
    }

    public LogEvent useOtel() { return withOtel(true); }

    public LogEvent notOtel() { return withOtel(false); }

    public LogEvent withOtel(boolean enabled) {
      this.otelEnabled = enabled;
      return this;
    }

    public LogEvent resetOtel() {
      this.otelEnabled = null;
      return this;
    }

    public boolean isOtelEnabled(boolean fallback) {
      return otelEnabled == null ? fallback : otelEnabled;
    }

    public Map<String, Object> send() throws Exception {
      return logger.emitEvent(this);
    }
  }

  public static final class Logger {
    private final String appName;
    private final String name;
    private final String runtime;
    private final Map<String, Object> fields;
    private final List<Transport> transports;
    private volatile boolean otelEnabled = true;

    public Logger(
        String appName,
        String name,
        String runtime,
        Map<String, Object> fields,
        List<Transport> transports) {
      this(appName, name, runtime, fields, transports, true);
    }

    public Logger(
        String appName,
        String name,
        String runtime,
        Map<String, Object> fields,
        List<Transport> transports,
        boolean otelEnabled) {
      this.appName = requireText(appName, "appName");
      this.name = name;
      this.runtime = runtime == null || runtime.isBlank() ? "java" : runtime;
      this.fields = immutableCopy(fields);
      this.transports = transports == null ? List.of() : List.copyOf(transports);
      this.otelEnabled = otelEnabled;
    }

    public Logger(String appName, List<Transport> transports) {
      this(appName, null, "java", Map.of(), transports);
    }

    public Map<String, Object> log(Level level, String message, Map<String, Object> eventFields)
        throws Exception {
      return event(level, message, eventFields).send();
    }

    /** Compatibility overload for callers that choose OTEL routing inline. */
    public Map<String, Object> log(
        Level level, String message, Map<String, Object> eventFields, boolean useOtel)
        throws Exception {
      return event(level, message, eventFields).withOtel(useOtel).send();
    }

    public LogEvent event(Level level, String message, Map<String, Object> eventFields) {
      return new LogEvent(this, level, message, eventFields);
    }

    private Map<String, Object> emitEvent(LogEvent event) throws Exception {
      Level level = event.level;
      String message = event.message;
      Map<String, Object> eventFields = event.fields;
      Context context = event.context;
      Map<String, Object> mergedFields = new LinkedHashMap<>(fields);
      if (context != null) {
        mergedFields.putAll(context.fields());
        putIfText(mergedFields, "otel.span_id", context.spanId());
        mergedFields.put("otel.trace_flags", context.traceFlags());
        putIfText(mergedFields, "otel.trace_state", context.traceState());
      }
      if (eventFields != null) {
        mergedFields.putAll(eventFields);
      }

      Map<String, Object> record = new LinkedHashMap<>();
      record.put("schema", SCHEMA);
      record.put("id", UUID.randomUUID().toString());
      record.put("timestamp", Instant.now().toString());
      record.put("level", level.name());
      record.put("runtime", runtime);
      record.put("appName", appName);
      if (name != null && !name.isBlank()) {
        record.put("name", name);
      }
      record.put("message", message == null ? "" : message);
      record.put("values", List.of(message == null ? "" : message));
      record.put("fields", Collections.unmodifiableMap(mergedFields));
      if (context != null && context.traceId() != null && !context.traceId().isBlank()) {
        record.put("traceId", context.traceId());
        record.put("traceIds", List.of(context.traceId()));
      }
      if (context != null && !context.tags().isEmpty()) {
        record.put("tags", context.tags());
      }
      Map<String, Object> immutable = Collections.unmodifiableMap(record);
      for (Transport transport : transports) {
        if (transport.isOpenTelemetry() && !event.isOtelEnabled(otelEnabled)) continue;
        transport.write(immutable);
      }
      return immutable;
    }

    public Map<String, Object> info(String message, Map<String, Object> fields) throws Exception {
      return log(Level.INFO, message, fields);
    }

    public Map<String, Object> error(String message, Map<String, Object> fields) throws Exception {
      return log(Level.ERROR, message, fields);
    }

    public boolean isOtelEnabled() {
      return otelEnabled;
    }

    public Logger setOtelEnabled(boolean enabled) {
      otelEnabled = enabled;
      return this;
    }

    public Logger useOtel() {
      return setOtelEnabled(true);
    }

    public Logger notOtel() {
      return setOtelEnabled(false);
    }
  }

  /** Structural bridge to an application-owned OpenTelemetry span. */
  public interface OtelSpan {
    Context context();

    default boolean isRecording() {
      return true;
    }

    void recordException(Throwable error);

    void setStatus(int code, String description);

    void end();
  }

  @FunctionalInterface
  public interface OtelTracer {
    OtelSpan startSpan(String name, Map<String, Object> attributes);
  }

  @FunctionalInterface
  public interface SpanFunction<T> {
    T apply(OtelSpan span) throws Exception;
  }

  private static final OtelSpan NOOP_SPAN =
      new OtelSpan() {
        @Override
        public Context context() {
          return null;
        }

        @Override
        public boolean isRecording() {
          return false;
        }

        @Override
        public void recordException(Throwable error) {}

        @Override
        public void setStatus(int code, String description) {}

        @Override
        public void end() {}
      };

  /**
   * Wrap application work in an application-owned span while emitting ordinary lifecycle logs.
   * Sampled-out spans still correlate logs, but receive no recording-only mutations.
   */
  public static <T> T withSpan(
      Logger logger,
      OtelTracer tracer,
      String name,
      Map<String, Object> attributes,
      SpanFunction<T> callback)
      throws Exception {
    Objects.requireNonNull(logger, "logger");
    Objects.requireNonNull(tracer, "tracer");
    Objects.requireNonNull(callback, "callback");

    OtelSpan span;
    try {
      span = Objects.requireNonNull(tracer.startSpan(name, immutableCopy(attributes)), "span");
    } catch (Throwable error) {
      safeLifecycleLog(logger, Level.WARN, name, "start", error);
      return callback.apply(NOOP_SPAN);
    }

    Context context;
    try {
      context = span.context();
    } catch (Throwable error) {
      safeLifecycleLog(logger, Level.WARN, name, "context", error);
      context = null;
    }

    Context previous = CONTEXT.get();
    if (context == null) CONTEXT.remove(); else CONTEXT.set(context);
    safeLifecycleLog(logger, Level.DEBUG, name, "start", null);
    try {
      T result = callback.apply(span);
      if (isRecordingSafely(logger, span, name)) {
        invokeSpanSafely(logger, span, name, "status", () -> span.setStatus(1, ""));
      }
      safeLifecycleLog(logger, Level.DEBUG, name, "end", null);
      return result;
    } catch (Exception error) {
      if (isRecordingSafely(logger, span, name)) {
        invokeSpanSafely(logger, span, name, "exception", () -> span.recordException(error));
        invokeSpanSafely(
            logger,
            span,
            name,
            "status",
            () -> span.setStatus(2, error.getMessage() == null ? "" : error.getMessage()));
      }
      safeLifecycleLog(logger, Level.ERROR, name, "error", error);
      throw error;
    } finally {
      invokeSpanSafely(logger, span, name, "end", span::end);
      if (previous == null) CONTEXT.remove(); else CONTEXT.set(previous);
    }
  }

  private static boolean isRecordingSafely(Logger logger, OtelSpan span, String name) {
    try {
      return span.isRecording();
    } catch (Throwable error) {
      safeLifecycleLog(logger, Level.WARN, name, "recording", error);
      return false;
    }
  }

  private static void invokeSpanSafely(
      Logger logger, OtelSpan span, String name, String operation, Runnable action) {
    try {
      action.run();
    } catch (Throwable error) {
      safeLifecycleLog(logger, Level.WARN, name, operation, error);
    }
  }

  private static void safeLifecycleLog(
      Logger logger, Level level, String name, String phase, Throwable error) {
    try {
      Map<String, Object> fields = new LinkedHashMap<>();
      fields.put("otel.span_name", name);
      fields.put("otel.span_phase", phase);
      if (error != null) fields.put("error.message", String.valueOf(error.getMessage()));
      logger.log(level, "OpenTelemetry span " + phase + ": " + name, fields);
    } catch (Throwable ignored) {
      // Telemetry and lifecycle logging must not replace the application result.
    }
  }

  public static String toJson(Object value) {
    if (value == null) return "null";
    if (value instanceof String text) return '"' + escape(text) + '"';
    if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
    if (value instanceof Map<?, ?> map) {
      List<String> entries = new ArrayList<>();
      map.forEach((key, item) -> entries.add(toJson(String.valueOf(key)) + ':' + toJson(item)));
      return "{" + String.join(",", entries) + "}";
    }
    if (value instanceof Iterable<?> values) {
      List<String> items = new ArrayList<>();
      values.forEach(item -> items.add(toJson(item)));
      return "[" + String.join(",", items) + "]";
    }
    return toJson(String.valueOf(value));
  }

  private static String escape(String value) {
    return value
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t");
  }

  private static Map<String, Object> immutableCopy(Map<String, Object> source) {
    return source == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(source));
  }

  private static String requireText(String value, String name) {
    if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
    return value;
  }

  private static void putIfText(Map<String, Object> target, String key, String value) {
    if (value != null && !value.isBlank()) target.put(key, value);
  }

  private static void copyIfPresent(
      Map<String, Object> source, Map<String, Object> target, String sourceKey, String targetKey) {
    if (source.containsKey(sourceKey)) target.put(targetKey, source.get(sourceKey));
  }
}
