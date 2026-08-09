package com.oresoftware.nextloggers;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

public final class NextLoggersTest {
  public static void main(String[] args) throws Exception {
    contextFlowsIntoRecord();
    threadLocalContextIsIsolated();
    explicitSpanLifecycleIsWrapped();
    sampledOutSpanCorrelatesWithoutRecordingMutations();
    telemetryFailuresDoNotReplaceApplicationResult();
    jsonMatchesWireShape();
  }

  private static NextLoggers.Logger logger(NextLoggers.MemoryTransport transport) {
    return new NextLoggers.Logger(new NextLoggers.Options()
        .appName("payments")
        .minimumLevel(NextLoggers.Level.DEBUG)
        .console(false)
        .transport(transport)
        .idFactory(() -> "record-1")
        .clock(Clock.fixed(Instant.parse("2026-01-02T03:04:05Z"), ZoneOffset.UTC)));
  }

  private static void contextFlowsIntoRecord() {
    NextLoggers.MemoryTransport transport = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(transport);
    NextLoggers.TraceContext context = new NextLoggers.TraceContext(
        "trace-1", "span-1", 1, "vendor=value", Map.of("tenant", "acme"), Map.of("route", "/pay"), java.util.List.of("request"));
    NextLoggers.Scope scope = NextLoggers.withContext(context);
    try {
      logger.info("payment", 42).send();
    } finally {
      scope.close();
    }
    NextLoggers.LogRecord record = transport.records().get(0);
    assert record.traceId().equals("trace-1");
    assert record.fields().get("otel.span_id").equals("span-1");
    assert record.fields().get("route").equals("/pay");
    assert record.tags().contains("otel");
    assert NextLoggers.currentContext() == null;
  }

  private static void threadLocalContextIsIsolated() throws Exception {
    CountDownLatch ready = new CountDownLatch(2);
    CountDownLatch go = new CountDownLatch(1);
    AtomicReference<String> left = new AtomicReference<>();
    AtomicReference<String> right = new AtomicReference<>();
    Thread first = new Thread(() -> {
      NextLoggers.Scope scope = NextLoggers.withContext(new NextLoggers.TraceContext("left", "s1", 1));
      try {
        ready.countDown(); await(go); left.set(NextLoggers.currentContext().traceId());
      } finally {
        scope.close();
      }
    });
    Thread second = new Thread(() -> {
      NextLoggers.Scope scope = NextLoggers.withContext(new NextLoggers.TraceContext("right", "s2", 1));
      try {
        ready.countDown(); await(go); right.set(NextLoggers.currentContext().traceId());
      } finally {
        scope.close();
      }
    });
    first.start(); second.start();
    ready.await(); go.countDown(); first.join(); second.join();
    assert left.get().equals("left");
    assert right.get().equals("right");
  }

  private static void explicitSpanLifecycleIsWrapped() throws Exception {
    NextLoggers.MemoryTransport transport = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(transport);
    FakeSpan span = new FakeSpan();
    int value = NextLoggers.withSpan(logger, (name, attributes) -> span, "charge", Map.of("method", "card"), ignored -> 7);
    assert value == 7;
    assert span.status == 1;
    assert span.ended == 1;
    assert transport.records().size() == 2;
    Exception failure = new Exception("declined");
    try {
      NextLoggers.withSpan(logger, (name, attributes) -> span, "charge", Map.of(), ignored -> { throw failure; });
      throw new AssertionError("expected failure");
    } catch (Exception actual) {
      assert actual == failure;
    }
    assert span.status == 2;
    assert span.recorded == failure;
  }

  private static void telemetryFailuresDoNotReplaceApplicationResult() throws Exception {
    NextLoggers.MemoryTransport transport = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(transport);
    FakeSpan broken = new FakeSpan();
    broken.failLifecycle = true;
    int value = NextLoggers.withSpan(
        logger,
        (name, attributes) -> broken,
        "resilient",
        Map.of(),
        ignored -> 11);
    assert value == 11;
    assert transport.records().stream().anyMatch(record -> record.message().contains("set success status"));
    assert transport.records().stream().anyMatch(record -> record.message().contains("end span"));

    int fallback = NextLoggers.withSpan(
        logger,
        (name, attributes) -> { throw new IllegalStateException("sdk unavailable"); },
        "fallback",
        Map.of(),
        ignored -> 12);
    assert fallback == 12;
    assert transport.records().stream().anyMatch(record -> record.message().contains("start span"));
  }

  private static void sampledOutSpanCorrelatesWithoutRecordingMutations() throws Exception {
    NextLoggers.MemoryTransport ordinary = new NextLoggers.MemoryTransport();
    java.util.List<NextLoggers.LogRecord> exported = new java.util.ArrayList<>();
    NextLoggers.Logger logger = new NextLoggers.Logger(new NextLoggers.Options()
        .appName("payments")
        .minimumLevel(NextLoggers.Level.DEBUG)
        .console(false)
        .transports(java.util.List.of(ordinary, new NextLoggers.OtelTransport(exported::add))));
    FakeSpan sampledOut = new FakeSpan();
    sampledOut.recording = false;
    int result = NextLoggers.withSpan(
        logger, (name, attributes) -> sampledOut, "sampled-out", Map.of(), ignored -> {
          logger.info("inside").notOtel().send();
          return 17;
        });
    assert result == 17;
    assert sampledOut.status == 0;
    assert sampledOut.recorded == null;
    assert ordinary.records().stream().anyMatch(record -> record.traceId().equals("trace-span"));
    assert exported.stream().noneMatch(record -> record.message().equals("inside"));
  }

  private static void jsonMatchesWireShape() {
    NextLoggers.MemoryTransport transport = new NextLoggers.MemoryTransport();
    NextLoggers.Logger logger = logger(transport);
    String json = logger.warn("hello").addTrace("trace-1").send().toJson();
    assert json.contains("\"schema\":\"next-loggers/v1\"");
    assert json.contains("\"appName\":\"payments\"");
    assert json.contains("\"traceId\":\"trace-1\"");
  }

  private static void await(CountDownLatch latch) {
    try { latch.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new RuntimeException(error); }
  }

  private static final class FakeSpan implements NextLoggers.OtelSpan {
    int status;
    int ended;
    Throwable recorded;
    boolean failLifecycle;
    boolean recording = true;
    @Override public NextLoggers.TraceContext context() { return new NextLoggers.TraceContext("trace-span", "span-span", 1); }
    @Override public boolean isRecording() { return recording; }
    @Override public void recordException(Throwable error) {
      if (failLifecycle) throw new IllegalStateException("record unavailable");
      recorded = error;
    }
    @Override public void setStatus(int code, String description) {
      if (failLifecycle) throw new IllegalStateException("status unavailable");
      status = code;
    }
    @Override public void end() {
      if (failLifecycle) throw new IllegalStateException("end unavailable");
      ended += 1;
    }
  }
}
