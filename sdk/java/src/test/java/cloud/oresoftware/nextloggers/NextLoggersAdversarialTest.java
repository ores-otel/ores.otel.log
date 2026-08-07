package cloud.oresoftware.nextloggers;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Adversarial and concurrency coverage for the dependency-free Java SDK. */
public final class NextLoggersAdversarialTest {
  private NextLoggersAdversarialTest() {}

  public static void main(String[] args) throws Exception {
    nestedContextRestoresParent();
    callbackFailureRestoresContext();
    nullContextTemporarilyClearsParent();
    contextSnapshotsCallerCollections();
    oneHundredThreadsNeverCrossContaminateContext();
    fieldPrecedenceIsLoggerThenContextThenEvent();
    recordsWithoutContextOmitCorrelationOptionals();
    everyLevelMapsToTheExpectedOtelSeverity();
    otelTransportCopiesTraceAndStructuredFields();
    otelOutputIsImmutable();
    supabaseTransportReceivesTheImmutableWireRecord();
    transportsRunInConfiguredOrder();
    transportFailureIsPropagatedWithoutRecordMutation();
    recordAndNestedFieldsAreImmutable();
    jsonEscapesQuotesSlashesAndControlCharacters();
    invalidApplicationNamesAreRejected();
    generatedRecordIdsAreUnique();
    timestampsAreIso8601();
    explicitRuntimeAndLoggerNameArePreserved();
    contextTagsAreCopiedIntoTheWireRecord();
  }

  private static NextLoggers.Logger logger(List<NextLoggers.Transport> transports) {
    return new NextLoggers.Logger("java-adversarial", "audit", "java", Map.of(), transports);
  }

  private static void nestedContextRestoresParent() throws Exception {
    NextLoggers.Context parent = NextLoggers.Context.trace("parent", "span-parent");
    NextLoggers.Context child = NextLoggers.Context.trace("child", "span-child");
    check(NextLoggers.currentContext() == null, "context should start empty");
    NextLoggers.withContext(parent, () -> {
      check(NextLoggers.currentContext() == parent, "parent context missing");
      NextLoggers.withContext(child, () -> {
        check(NextLoggers.currentContext() == child, "child context missing");
        return null;
      });
      check(NextLoggers.currentContext() == parent, "parent context was not restored");
      return null;
    });
    check(NextLoggers.currentContext() == null, "context leaked after nested scope");
  }

  private static void callbackFailureRestoresContext() throws Exception {
    NextLoggers.Context parent = NextLoggers.Context.trace("parent", "span-parent");
    NextLoggers.Context child = NextLoggers.Context.trace("child", "span-child");
    NextLoggers.withContext(parent, () -> {
      IllegalStateException expected = new IllegalStateException("boom");
      IllegalStateException actual = expectThrows(
          IllegalStateException.class,
          () -> NextLoggers.withContext(child, () -> { throw expected; }));
      check(actual == expected, "callback exception identity changed");
      check(NextLoggers.currentContext() == parent, "parent was not restored after failure");
      return null;
    });
    check(NextLoggers.currentContext() == null, "failed context leaked");
  }

  private static void nullContextTemporarilyClearsParent() throws Exception {
    NextLoggers.Context parent = NextLoggers.Context.trace("parent", "span-parent");
    NextLoggers.withContext(parent, () -> {
      NextLoggers.withContext(null, () -> {
        check(NextLoggers.currentContext() == null, "null context did not clear the frame");
        return null;
      });
      check(NextLoggers.currentContext() == parent, "parent was not restored after null frame");
      return null;
    });
  }

  private static void contextSnapshotsCallerCollections() {
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("route", "/pay");
    List<String> tags = new ArrayList<>();
    tags.add("request");
    NextLoggers.Context context =
        new NextLoggers.Context("trace", "span", 1, "vendor=value", fields, tags);
    fields.put("route", "/mutated");
    tags.set(0, "mutated");
    check("/pay".equals(context.fields().get("route")), "context fields alias caller map");
    check(List.of("request").equals(context.tags()), "context tags alias caller list");
    expectThrows(UnsupportedOperationException.class, () -> context.fields().put("x", true));
    expectThrows(UnsupportedOperationException.class, () -> context.tags().add("x"));
  }

  private static void oneHundredThreadsNeverCrossContaminateContext() throws Exception {
    int count = 100;
    Map<String, String> tracesByMessage = new ConcurrentHashMap<>();
    Map<String, String> spansByMessage = new ConcurrentHashMap<>();
    AtomicReference<Throwable> failure = new AtomicReference<>();
    NextLoggers.Logger logger = logger(List.of(record -> {
      String message = String.valueOf(record.get("message"));
      tracesByMessage.put(message, String.valueOf(record.get("traceId")));
      @SuppressWarnings("unchecked")
      Map<String, Object> fields = (Map<String, Object>) record.get("fields");
      spansByMessage.put(message, String.valueOf(fields.get("otel.span_id")));
    }));
    CountDownLatch ready = new CountDownLatch(count);
    CountDownLatch start = new CountDownLatch(1);
    List<Thread> threads = new ArrayList<>();
    for (int index = 0; index < count; index += 1) {
      int current = index;
      Thread thread = new Thread(() -> {
        try {
          String suffix = String.format("%03d", current);
          ready.countDown();
          start.await();
          NextLoggers.withContext(
              NextLoggers.Context.trace("trace-" + suffix, "span-" + suffix),
              () -> {
                logger.info("message-" + suffix, Map.of());
                return null;
              });
          check(NextLoggers.currentContext() == null, "thread context leaked");
        } catch (Throwable error) {
          failure.compareAndSet(null, error);
        }
      }, "next-loggers-test-" + current);
      threads.add(thread);
      thread.start();
    }
    ready.await();
    start.countDown();
    for (Thread thread : threads) thread.join();
    if (failure.get() != null) throw new AssertionError("concurrent logging failed", failure.get());
    check(tracesByMessage.size() == count, "missing concurrent records");
    for (int index = 0; index < count; index += 1) {
      String suffix = String.format("%03d", index);
      String message = "message-" + suffix;
      check(("trace-" + suffix).equals(tracesByMessage.get(message)), "trace contamination");
      check(("span-" + suffix).equals(spansByMessage.get(message)), "span contamination");
    }
  }

  private static void fieldPrecedenceIsLoggerThenContextThenEvent() throws Exception {
    NextLoggers.Logger logger = new NextLoggers.Logger(
        "precedence",
        null,
        "java",
        Map.of("source", "logger", "loggerOnly", true),
        List.of());
    Map<String, Object> record = NextLoggers.withContext(
        new NextLoggers.Context(
            "trace", "span", 1, null,
            Map.of("source", "context", "contextOnly", true),
            List.of()),
        () -> logger.info("inside", Map.of("source", "event", "eventOnly", true)));
    Map<String, Object> fields = fields(record);
    check("event".equals(fields.get("source")), "event field did not win precedence");
    check(Boolean.TRUE.equals(fields.get("loggerOnly")), "logger field missing");
    check(Boolean.TRUE.equals(fields.get("contextOnly")), "context field missing");
    check(Boolean.TRUE.equals(fields.get("eventOnly")), "event field missing");
  }

  private static void recordsWithoutContextOmitCorrelationOptionals() throws Exception {
    Map<String, Object> record = logger(List.of()).info("plain", Map.of());
    check(!record.containsKey("traceId"), "traceId should be omitted");
    check(!record.containsKey("traceIds"), "traceIds should be omitted");
    check(!record.containsKey("tags"), "tags should be omitted");
    check(!fields(record).containsKey("otel.span_id"), "span ID should be omitted");
    check(Integer.valueOf(0).equals(fields(record).get("otel.trace_flags")) == false,
        "no-context record should not synthesize trace flags");
  }

  private static void everyLevelMapsToTheExpectedOtelSeverity() throws Exception {
    Map<NextLoggers.Level, Integer> expected = Map.of(
        NextLoggers.Level.TRACE, 1,
        NextLoggers.Level.DEBUG, 5,
        NextLoggers.Level.INFO, 9,
        NextLoggers.Level.WARN, 13,
        NextLoggers.Level.ERROR, 17,
        NextLoggers.Level.FATAL, 21);
    List<Map<String, Object>> emitted = Collections.synchronizedList(new ArrayList<>());
    NextLoggers.Logger logger = logger(List.of(new NextLoggers.OtelTransport(emitted::add)));
    for (NextLoggers.Level level : NextLoggers.Level.values()) {
      logger.log(level, level.name().toLowerCase(), Map.of());
    }
    check(emitted.size() == expected.size(), "OTEL level records missing");
    for (Map<String, Object> value : emitted) {
      NextLoggers.Level level = NextLoggers.Level.valueOf(String.valueOf(value.get("severityText")));
      check(expected.get(level).equals(value.get("severityNumber")), "wrong OTEL severity mapping");
    }
  }

  private static void otelTransportCopiesTraceAndStructuredFields() throws Exception {
    AtomicReference<Map<String, Object>> captured = new AtomicReference<>();
    NextLoggers.Logger logger = logger(List.of(new NextLoggers.OtelTransport(captured::set)));
    NextLoggers.withContext(
        new NextLoggers.Context(
            "trace-otel", "span-otel", 1, "vendor=value",
            Map.of("requestId", "request-1"), List.of("otel")),
        () -> {
          logger.error("failed", Map.of("orderId", "order-42"));
          return null;
        });
    Map<String, Object> emitted = captured.get();
    check("failed".equals(emitted.get("body")), "OTEL body missing");
    check(Integer.valueOf(17).equals(emitted.get("severityNumber")), "OTEL severity missing");
    Map<String, Object> attributes = map(emitted.get("attributes"));
    check("trace-otel".equals(attributes.get("trace.id")), "OTEL trace missing");
    check("span-otel".equals(attributes.get("next_logger.field.otel.span_id")), "OTEL span missing");
    check("order-42".equals(attributes.get("next_logger.field.orderId")), "OTEL field missing");
  }

  private static void otelOutputIsImmutable() throws Exception {
    AtomicReference<Map<String, Object>> captured = new AtomicReference<>();
    logger(List.of(new NextLoggers.OtelTransport(captured::set))).info("immutable", Map.of());
    Map<String, Object> emitted = captured.get();
    expectThrows(UnsupportedOperationException.class, () -> emitted.put("body", "mutated"));
    Map<String, Object> attributes = map(emitted.get("attributes"));
    expectThrows(UnsupportedOperationException.class, () -> attributes.put("x", true));
  }

  private static void supabaseTransportReceivesTheImmutableWireRecord() throws Exception {
    AtomicReference<Map<String, Object>> captured = new AtomicReference<>();
    Map<String, Object> returned =
        logger(List.of(new NextLoggers.SupabaseTransport(captured::set)))
            .info("client", Map.of("safe", true));
    check(captured.get() == returned, "Supabase transport did not receive canonical record");
    expectThrows(UnsupportedOperationException.class, () -> captured.get().put("x", true));
    expectThrows(UnsupportedOperationException.class, () -> fields(captured.get()).put("x", true));
  }

  private static void transportsRunInConfiguredOrder() throws Exception {
    List<Integer> order = new ArrayList<>();
    NextLoggers.Logger logger = logger(List.of(
        record -> order.add(1),
        record -> order.add(2),
        record -> order.add(3)));
    logger.info("ordered", Map.of());
    check(List.of(1, 2, 3).equals(order), "transport order changed");
  }

  private static void transportFailureIsPropagatedWithoutRecordMutation() throws Exception {
    AtomicReference<Map<String, Object>> seen = new AtomicReference<>();
    IllegalStateException expected = new IllegalStateException("sink unavailable");
    NextLoggers.Logger logger = logger(List.of(
        record -> {
          seen.set(record);
          throw expected;
        },
        record -> { throw new AssertionError("later transport should not run after failure"); }));
    IllegalStateException actual = expectThrows(
        IllegalStateException.class,
        () -> logger.error("failed", Map.of("attempt", 1)));
    check(actual == expected, "transport exception identity changed");
    check("failed".equals(seen.get().get("message")), "record mutated before failure");
    check(Integer.valueOf(1).equals(fields(seen.get()).get("attempt")), "fields mutated before failure");
  }

  private static void recordAndNestedFieldsAreImmutable() throws Exception {
    Map<String, Object> record = logger(List.of()).info("immutable", Map.of("value", 1));
    expectThrows(UnsupportedOperationException.class, () -> record.put("message", "mutated"));
    expectThrows(UnsupportedOperationException.class, () -> fields(record).put("value", 2));
  }

  private static void jsonEscapesQuotesSlashesAndControlCharacters() {
    String json = NextLoggers.toJson(Map.of("value", "quote\" slash\\ newline\n return\r tab\t"));
    check(json.contains("quote\\\""), "quote was not escaped");
    check(json.contains("slash\\\\"), "backslash was not escaped");
    check(json.contains("newline\\n"), "newline was not escaped");
    check(json.contains("return\\r"), "carriage return was not escaped");
    check(json.contains("tab\\t"), "tab was not escaped");
  }

  private static void invalidApplicationNamesAreRejected() {
    expectThrows(
        IllegalArgumentException.class,
        () -> new NextLoggers.Logger(" ", List.of()));
    expectThrows(
        IllegalArgumentException.class,
        () -> new NextLoggers.Logger(null, List.of()));
  }

  private static void generatedRecordIdsAreUnique() throws Exception {
    NextLoggers.Logger logger = logger(List.of());
    Set<String> ids = ConcurrentHashMap.newKeySet();
    for (int index = 0; index < 500; index += 1) {
      ids.add(String.valueOf(logger.info("id-" + index, Map.of()).get("id")));
    }
    check(ids.size() == 500, "generated record IDs collided");
  }

  private static void timestampsAreIso8601() throws Exception {
    String timestamp = String.valueOf(logger(List.of()).info("time", Map.of()).get("timestamp"));
    Instant.parse(timestamp);
  }

  private static void explicitRuntimeAndLoggerNameArePreserved() throws Exception {
    NextLoggers.Logger logger = new NextLoggers.Logger(
        "named", "audit", "java-virtual-thread", Map.of(), List.of());
    Map<String, Object> record = logger.info("named", Map.of());
    check("audit".equals(record.get("name")), "logger name missing");
    check("java-virtual-thread".equals(record.get("runtime")), "runtime missing");
  }

  private static void contextTagsAreCopiedIntoTheWireRecord() throws Exception {
    Map<String, Object> record = NextLoggers.withContext(
        new NextLoggers.Context("trace", "span", 1, null, Map.of(), List.of("otel", "request")),
        () -> logger(List.of()).info("tagged", Map.of()));
    check(List.of("otel", "request").equals(record.get("tags")), "context tags missing");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> fields(Map<String, Object> record) {
    return (Map<String, Object>) record.get("fields");
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object value) {
    return (Map<String, Object>) value;
  }

  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static <T extends Throwable> T expectThrows(Class<T> type, ThrowingRunnable runnable) {
    try {
      runnable.run();
    } catch (Throwable error) {
      if (type.isInstance(error)) return type.cast(error);
      throw new AssertionError("unexpected exception type: " + error, error);
    }
    throw new AssertionError("expected " + type.getName());
  }

  @FunctionalInterface
  private interface ThrowingRunnable {
    void run() throws Exception;
  }
}
