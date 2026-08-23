package cloud.oresoftware.nextloggers;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public final class NextLoggersTest {
  private NextLoggersTest() {}

  public static void main(String[] args) throws Exception {
    List<Map<String, Object>> otel = new ArrayList<>();
    List<Map<String, Object>> supabase = new ArrayList<>();
    NextLoggers.Logger logger =
        new NextLoggers.Logger(
            "payments",
            "audit",
            "java",
            Map.of("environment", "test"),
            List.of(
                new NextLoggers.OtelTransport(otel::add),
                new NextLoggers.SupabaseTransport(supabase::add)));

    Map<String, Object> record =
        NextLoggers.withContext(
            new NextLoggers.Context(
                "0123456789abcdef0123456789abcdef",
                "0123456789abcdef",
                1,
                "vendor=value",
                Map.of("requestId", "request-1"),
                List.of("otel", "checkout")),
            () -> logger.error("payment failed", Map.of("orderId", "order-42")));

    assert NextLoggers.SCHEMA.equals(record.get("schema"));
    assert "payments".equals(record.get("appName"));
    assert "ERROR".equals(record.get("level"));
    assert "0123456789abcdef0123456789abcdef".equals(record.get("traceId"));
    @SuppressWarnings("unchecked")
    Map<String, Object> fields = (Map<String, Object>) record.get("fields");
    assert "0123456789abcdef".equals(fields.get("otel.span_id"));
    assert "request-1".equals(fields.get("requestId"));
    assert "order-42".equals(fields.get("orderId"));
    assert otel.size() == 1;
    assert Integer.valueOf(17).equals(otel.get(0).get("severityNumber"));
    assert supabase.size() == 1;
    assert NextLoggers.toJson(record).contains("\"schema\":\"next-loggers/v1\"");
    assert NextLoggers.currentContext() == null : "context was not restored";

    int otelBefore = otel.size();
    int ordinaryBefore = supabase.size();
    logger.log(NextLoggers.Level.INFO, "ordinary only", Map.of(), false);
    assert otel.size() == otelBefore : "per-event OTEL opt-out was ignored";
    assert supabase.size() == ordinaryBefore + 1 : "ordinary transport was incorrectly skipped";

    final int[] statusCalls = {0};
    NextLoggers.OtelSpan sampledOut =
        new NextLoggers.OtelSpan() {
          @Override
          public NextLoggers.Context context() {
            return NextLoggers.Context.trace(
                "fedcba9876543210fedcba9876543210", "fedcba9876543210");
          }

          @Override
          public boolean isRecording() {
            return false;
          }

          @Override
          public void recordException(Throwable error) {
            throw new AssertionError("sampled-out span recorded an exception");
          }

          @Override
          public void setStatus(int code, String description) {
            statusCalls[0] += 1;
          }

          @Override
          public void end() {}
        };
    String correlated =
        NextLoggers.withSpan(
            logger,
            (name, attributes) -> sampledOut,
            "sampled-out",
            Map.of(),
            span -> String.valueOf(logger.info("inside sampled-out", Map.of()).get("traceId")));
    assert correlated.equals("fedcba9876543210fedcba9876543210");
    assert statusCalls[0] == 0 : "sampled-out span received recording-only mutations";

    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      List<Callable<String>> calls =
          List.of(
              () ->
                  NextLoggers.withContext(
                      NextLoggers.Context.trace("trace-a", "span-a"),
                      () -> String.valueOf(logger.info("a", Map.of()).get("traceId"))),
              () ->
                  NextLoggers.withContext(
                      NextLoggers.Context.trace("trace-b", "span-b"),
                      () -> String.valueOf(logger.info("b", Map.of()).get("traceId"))));
      List<Future<String>> futures = pool.invokeAll(calls);
      assert "trace-a".equals(futures.get(0).get());
      assert "trace-b".equals(futures.get(1).get());
    } finally {
      pool.shutdownNow();
      if (!pool.awaitTermination(5, TimeUnit.SECONDS)) {
        throw new AssertionError("executor did not terminate");
      }
    }

    List<Map<String, Object>> routedOtel = new ArrayList<>();
    List<Map<String, Object>> regular = new ArrayList<>();
    NextLoggers.Logger routedLogger =
        new NextLoggers.Logger(
            "routing",
            null,
            "java",
            Map.of(),
            List.of(
                new NextLoggers.OtelTransport(routedOtel::add),
                new NextLoggers.SupabaseTransport(regular::add)),
            false);
    NextLoggers.LogEvent defaultOff =
        routedLogger.event(NextLoggers.Level.INFO, "default-off", Map.of());
    assert !defaultOff.isOtelEnabled(routedLogger.isOtelEnabled());
    defaultOff.send();
    routedLogger.event(NextLoggers.Level.INFO, "forced-on", Map.of()).useOtel().send();
    routedLogger
        .event(NextLoggers.Level.INFO, "reset-off", Map.of())
        .useOtel()
        .resetOtel()
        .send();
    routedLogger.useOtel();
    routedLogger.event(NextLoggers.Level.WARN, "forced-off", Map.of()).notOtel().send();
    routedLogger.event(NextLoggers.Level.INFO, "logger-on", Map.of()).withOtel(true).send();
    assert routedOtel.stream().map(value -> value.get("body")).toList()
        .equals(List.of("forced-on", "logger-on"));
    assert regular.stream().map(value -> value.get("message")).toList()
        .equals(List.of("default-off", "forced-on", "reset-off", "forced-off", "logger-on"));

    System.out.println("Java next-loggers conformance passed");
  }
}
