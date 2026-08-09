package com.oresoftware.nextloggers;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

public final class NextLoggersAdversarialTest {
  public static void main(String[] args) throws Exception {
    nestedScopesRestoreParents();
    scopeCannotCloseOnAnotherThread();
    contextSnapshotsAreImmutable();
    explicitTraceRemainsPrimary();
    minimumLevelFiltersBeforeTransports();
    sendIsIdempotent();
    transportFailuresAreAggregatedAfterFanout();
    jsonEscapesControlCharacters();
    parallelContextsNeverCrossContaminate();
    callbackErrorsAreReThrownUnchanged();
    tracerStartFailureUsesNoopSpan();
  }

  private static NextLoggers.Logger logger(
      NextLoggers.Level minimum,
      List<NextLoggers.Transport> transports) {
    return new NextLoggers.Logger(
        new NextLoggers.Options()
            .appName("java-adversarial")
            .minimumLevel(minimum)
            .console(false)
            .transports(transports)
            .idFactory(() -> "record-fixed")
            .clock(Clock.fixed(Instant.parse("2026-01-02T03:04:05Z"), ZoneOffset.UTC)));
  }

  @SuppressWarnings("try")
  private static void nestedScopesRestoreParents() {
    assert NextLoggers.currentContext() == null;
    NextLoggers.TraceContext parent = new NextLoggers.TraceContext("parent", "span-parent", 1);
    NextLoggers.TraceContext child = new NextLoggers.TraceContext("child", "span-child", 1);
    try (NextLoggers.Scope ignored = NextLoggers.withContext(parent)) {
      assert NextLoggers.currentContext().traceId().equals("parent");
      try (NextLoggers.Scope ignoredChild = NextLoggers.withContext(child)) {
        assert NextLoggers.currentContext().traceId().equals("child");
      }
      assert NextLoggers.currentContext().traceId().equals("parent");
    }
    assert NextLoggers.currentContext() == null;
  }

  private static void scopeCannotCloseOnAnotherThread() throws Exception {
    NextLoggers.Scope scope = NextLoggers.withContext(
        new NextLoggers.TraceContext("owner", "span", 1));
    AtomicReference<Throwable> failure = new AtomicReference<>();
    Thread thread = new Thread(() -> {
      try {
        scope.close();
      } catch (Throwable error) {
        failure.set(error);
      }
    });
    thread.start();
    thread.join();
    assert failure.get() instanceof IllegalStateException;
    assert failure.get().getMessage().contains("different thread");
    assert NextLoggers.currentContext().traceId().equals("owner");
    scope.close();
    assert NextLoggers.currentContext() == null;
  }

  private static void contextSnapshotsAreImmutable() {
    Map<String, String> baggage = new java.util.LinkedHashMap<>();
    baggage.put("tenant", "acme");
    Map<String, Object> fields = new java.util.LinkedHashMap<>();
    fields.put("route", "/pay");
    List<String> tags = new ArrayList<>();
    tags.add("request");
    NextLoggers.TraceContext context = new NextLoggers.TraceContext(
        "trace", "span", 1, "vendor=value", baggage, fields, tags);
    baggage.put("tenant", "mutated");
    fields.put("route", "/mutated");
    tags.set(0, "mutated");
    assert context.baggage().get("tenant").equals("acme");
    assert context.fields().get("route").equals("/pay");
    assert context.tags().get(0).equals("request");
    assertThrows(UnsupportedOperationException.class, () -> context.baggage().put("x", "y"));
    assertThrows(UnsupportedOperationException.class, () -> context.fields().put("x", true));
    assertThrows(UnsupportedOperationException.class, () -> context.tags().add("x"));
  }

  @SuppressWarnings("try")
  private static void explicitTraceRemainsPrimary() {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.TRACE, List.of(memory));
    try (NextLoggers.Scope ignored = NextLoggers.withContext(
        new NextLoggers.TraceContext("ambient", "ambient-span", 1))) {
      logger.info("inside").addTrace("explicit").send();
    }
    NextLoggers.LogRecord record = memory.records().get(0);
    assert record.traceId().equals("explicit");
    assert record.traceIds().equals(List.of("explicit", "ambient"));
    assert record.fields().get("otel.span_id").equals("ambient-span");
  }

  private static void minimumLevelFiltersBeforeTransports() {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.WARN, List.of(memory));
    logger.trace("trace").send();
    logger.debug("debug").send();
    logger.info("info").send();
    logger.warn("warn").send();
    logger.error("error").send();
    logger.fatal("fatal").send();
    assert memory.records().stream().map(NextLoggers.LogRecord::level).toList()
        .equals(List.of(NextLoggers.Level.WARN, NextLoggers.Level.ERROR, NextLoggers.Level.FATAL));
  }

  private static void sendIsIdempotent() {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.TRACE, List.of(memory));
    NextLoggers.Event event = logger.info("once");
    NextLoggers.LogRecord first = event.send();
    NextLoggers.LogRecord second = event.send();
    assert first == second;
    assert memory.records().size() == 1;
  }

  private static void transportFailuresAreAggregatedAfterFanout() {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Transport first = record -> { throw new IllegalStateException("first"); };
    NextLoggers.Transport second = record -> { throw new IllegalArgumentException("second"); };
    NextLoggers.Logger logger = logger(
        NextLoggers.Level.TRACE,
        List.of(first, memory, second));
    RuntimeException error = assertThrows(RuntimeException.class, () -> logger.error("fanout").send());
    assert error.getSuppressed().length == 2;
    assert memory.records().size() == 1;
    assert memory.records().get(0).message().equals("fanout");
  }

  private static void jsonEscapesControlCharacters() {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.TRACE, List.of(memory));
    String json = logger.info("quote\" slash\\ newline\n tab\t").send().toJson();
    assert json.contains("quote\\\"");
    assert json.contains("slash\\\\");
    assert json.contains("newline\\n");
    assert json.contains("tab\\t");
    assert !json.contains("newline\n tab");
  }

  @SuppressWarnings("try")
  private static void parallelContextsNeverCrossContaminate() throws Exception {
    final int count = 50;
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.TRACE, List.of(memory));
    CountDownLatch ready = new CountDownLatch(count);
    CountDownLatch start = new CountDownLatch(1);
    List<Thread> threads = new ArrayList<>();
    for (int index = 0; index < count; index++) {
      final int value = index;
      Thread thread = new Thread(() -> {
        String trace = "trace-" + value;
        try (NextLoggers.Scope ignored = NextLoggers.withContext(
            new NextLoggers.TraceContext(trace, "span-" + value, 1))) {
          ready.countDown();
          await(start);
          logger.info("message-" + value).send();
        }
      });
      thread.start();
      threads.add(thread);
    }
    ready.await();
    start.countDown();
    for (Thread thread : threads) thread.join();
    assert memory.records().size() == count;
    for (NextLoggers.LogRecord record : memory.records()) {
      String suffix = record.message().substring("message-".length());
      assert record.traceId().equals("trace-" + suffix);
      assert record.fields().get("otel.span_id").equals("span-" + suffix);
    }
  }

  private static void callbackErrorsAreReThrownUnchanged() {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.TRACE, List.of(memory));
    AssertionError expected = new AssertionError("identity");
    AssertionError actual = assertThrows(AssertionError.class, () ->
        NextLoggers.withSpan(
            logger,
            (name, attributes) -> new StableSpan(),
            "panic",
            Map.of(),
            span -> { throw expected; }));
    assert actual == expected;
  }

  private static void tracerStartFailureUsesNoopSpan() throws Exception {
    NextLoggers.MemoryTransport memory = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(NextLoggers.Level.TRACE, List.of(memory));
    int value = NextLoggers.withSpan(
        logger,
        (name, attributes) -> { throw new IllegalStateException("sdk unavailable"); },
        "fallback",
        Map.of(),
        span -> {
          assert span.context().traceId().isEmpty();
          span.recordException(new Exception("ignored"));
          span.setStatus(2, "ignored");
          span.end();
          return 73;
        });
    assert value == 73;
    assert memory.records().stream()
        .anyMatch(record -> record.message().contains("start span"));
  }

  private static void await(CountDownLatch latch) {
    try {
      latch.await();
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new RuntimeException(error);
    }
  }

  private static <T extends Throwable> T assertThrows(Class<T> type, ThrowingRunnable action) {
    try {
      action.run();
    } catch (Throwable error) {
      if (type.isInstance(error)) return type.cast(error);
      throw new AssertionError("unexpected exception type", error);
    }
    throw new AssertionError("expected " + type.getName());
  }

  @FunctionalInterface
  private interface ThrowingRunnable {
    void run() throws Exception;
  }

  private static final class StableSpan implements NextLoggers.OtelSpan {
    @Override public NextLoggers.TraceContext context() {
      return new NextLoggers.TraceContext("trace", "span", 1);
    }
    @Override public void recordException(Throwable error) {}
    @Override public void setStatus(int code, String description) {}
    @Override public void end() {}
  }
}
