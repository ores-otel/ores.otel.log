# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/oresoftware/next_loggers"

# Records every lifecycle call so a test can assert that one broken transport
# did not stop the others from being drained.
class CountingTransport
  attr_reader :records, :flushes, :exits, :closes, :timeouts

  def initialize(fail_on: nil)
    @records = []
    @flushes = 0
    @exits = 0
    @closes = 0
    @timeouts = []
    @fail_on = fail_on
  end

  def write(record)
    @records << record
  end

  def flush(timeout: nil)
    @timeouts << timeout
    @flushes += 1
    raise "flush exploded" if @fail_on == :flush
  end

  def flush_on_exit(records = [], timeout: nil)
    @timeouts << timeout
    @exits += 1
    @records.concat(records)
    raise "exit flush exploded" if @fail_on == :flush_on_exit
  end

  def close(timeout: nil)
    @timeouts << timeout
    @closes += 1
    raise "close exploded" if @fail_on == :close
  end
end

class ShutdownTest < Minitest::Test
  def logger_with(*transports)
    ORESoftware::NextLoggers::Logger.new(app_name: "shutdown", transports: transports)
  end

  def test_close_is_idempotent_and_runs_the_lifecycle_once
    transport = CountingTransport.new
    logger = logger_with(transport)
    logger.info("before close")

    refute_predicate(logger, :closed?)
    logger.close
    logger.close
    logger.close

    assert_predicate(logger, :closed?)
    assert_equal(1, transport.exits)
    assert_equal(1, transport.closes)
  end

  def test_every_transport_is_drained_even_after_one_fails
    broken = CountingTransport.new(fail_on: :close)
    healthy = CountingTransport.new
    logger = logger_with(broken, healthy)

    error = assert_raises(ORESoftware::NextLoggers::ShutdownError) { logger.close }

    assert_equal(1, error.errors.length)
    assert_equal(1, healthy.closes, "a failing transport must not skip the next one")
  end

  def test_flush_reports_every_failure_rather_than_the_first
    first = CountingTransport.new(fail_on: :flush)
    second = CountingTransport.new(fail_on: :flush)
    logger = logger_with(first, second)

    error = assert_raises(ORESoftware::NextLoggers::ShutdownError) { logger.flush }

    assert_equal(2, error.errors.length)
    assert_equal(1, first.flushes)
    assert_equal(1, second.flushes)
  end

  def test_flush_on_exit_writes_the_records_the_caller_still_holds
    transport = CountingTransport.new
    logger = logger_with(transport)

    logger.flush_on_exit([{ "message" => "tail" }])

    assert_equal(1, transport.exits)
    assert_equal(["tail"], transport.records.map { |record| record.fetch("message") })
  end

  def test_a_transport_without_lifecycle_methods_is_skipped_not_fatal
    plain = ->(record) { record }
    logger = logger_with(plain)

    logger.flush
    logger.close

    assert_predicate(logger, :closed?)
  end

  def test_the_remaining_budget_shrinks_across_transports
    first = CountingTransport.new
    second = CountingTransport.new
    logger = logger_with(first, second)

    logger.flush(timeout: 2.0)

    assert_operator(first.timeouts.first, :<=, 2.0)
    assert_operator(second.timeouts.first, :<=, first.timeouts.first)
    assert_operator(second.timeouts.first, :>, 0.0)
  end

  def test_install_reports_its_hooks_and_uninstall_restores_the_traps
    logger = logger_with(CountingTransport.new)
    previous_term = Signal.trap("TERM", "DEFAULT")
    previous_int = Signal.trap("INT", "DEFAULT")

    begin
      hooks = ORESoftware::NextLoggers.install_process_hooks!(logger)

      assert_equal(%w[at-exit signal-sigterm signal-sigint], hooks.hooks)
      assert_equal("", hooks.reason)

      hooks.uninstall

      # Signal.trap returns the handler it replaced, so reading it back this way
      # both asserts the restore and leaves the disposition untouched.
      assert_equal("DEFAULT", Signal.trap("TERM", "DEFAULT"))
      assert_equal("DEFAULT", Signal.trap("INT", "DEFAULT"))
    ensure
      Signal.trap("TERM", previous_term)
      Signal.trap("INT", previous_int)
    end
  end

  def test_a_single_signal_drains_then_lets_the_process_die
    script = <<~RUBY
      $LOAD_PATH.unshift(#{File.expand_path("../lib", __dir__).inspect})
      require "oresoftware/next_loggers"

      class Recorder
        def write(record) = nil
        def close(timeout: nil)
          $stdout.puts("DRAINED")
          $stdout.flush
        end
      end

      logger = ORESoftware::NextLoggers::Logger.new(app_name: "probe", transports: [Recorder.new])
      ORESoftware::NextLoggers.install_process_hooks!(logger)
      $stdout.puts("READY")
      $stdout.flush
      sleep(60)
    RUBY

    IO.popen([RbConfig.ruby, "-e", script], "r") do |io|
      assert_equal("READY", io.gets&.chomp)
      Process.kill("TERM", io.pid)
      assert_equal("DRAINED", io.gets&.chomp)

      # Trapping SIGTERM suppresses the kernel default. A logger that drains and
      # then keeps running has made the service unstoppable by ordinary means.
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      exited = false
      until Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        if Process.waitpid(io.pid, Process::WNOHANG)
          exited = true
          break
        end
        sleep(0.05)
      end
      Process.kill("KILL", io.pid) unless exited
      assert(exited, "the process survived a SIGTERM it should have died from")
    end
  end

  def test_a_signal_drains_the_logger_and_a_second_one_is_not_swallowed
    script = <<~RUBY
      $LOAD_PATH.unshift(#{File.expand_path("../lib", __dir__).inspect})
      require "oresoftware/next_loggers"

      class Wedged
        def write(record) = nil
        def close(timeout: nil)
          $stdout.puts("DRAINING")
          $stdout.flush
          sleep(30)
        end
      end

      logger = ORESoftware::NextLoggers::Logger.new(app_name: "probe", transports: [Wedged.new])
      ORESoftware::NextLoggers.install_process_hooks!(logger, timeout: 30)
      $stdout.puts("READY")
      $stdout.flush
      sleep(60)
    RUBY

    IO.popen([RbConfig.ruby, "-e", script], "r") do |io|
      assert_equal("READY", io.gets&.chomp)
      Process.kill("TERM", io.pid)
      assert_equal("DRAINING", io.gets&.chomp)

      # The first TERM is now parked inside a transport that will never return.
      # Trapping the signal overrode the kernel default, so without the escalation
      # this process would be unkillable by ordinary means for a full 30 seconds.
      Process.kill("TERM", io.pid)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      exited = false
      until Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        if Process.waitpid(io.pid, Process::WNOHANG)
          exited = true
          break
        end
        sleep(0.05)
      end
      Process.kill("KILL", io.pid) unless exited
      assert(exited, "the second SIGTERM did not take effect")
    end
  end
end
