# frozen_string_literal: true

module ORESoftware
  module NextLoggers
    # Raised when one or more transports fail during a flush or close.
    #
    # It carries every failure rather than the first, because shutdown is
    # exactly when a single broken destination must not be allowed to hide the
    # state of the others.
    class ShutdownError < RuntimeError
      attr_reader :errors

      def initialize(operation, errors)
        @errors = errors.freeze
        details = errors.map { |error| "#{error.class}: #{error.message}" }.join("; ")
        super("#{operation} failed on #{errors.length} transport(s): #{details}")
      end
    end

    DEFAULT_SHUTDOWN_TIMEOUT = 5.0

    module_function

    # Monotonic deadline, immune to wall-clock steps during a slow shutdown.
    def shutdown_deadline(timeout)
      return nil if timeout.nil?

      Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout.to_f
    end

    def shutdown_remaining(deadline)
      return nil if deadline.nil?

      [deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0.0].max
    end

    # Invokes one lifecycle hook on one transport, passing the remaining budget
    # only to transports that accept it. A transport with a fixed arity keeps
    # working unchanged; one that opts in gets to honour the deadline.
    def call_transport_hook(transport, hook, remaining, *args)
      return :absent unless transport.respond_to?(hook)

      method = transport.method(hook)
      accepts_timeout =
        method.parameters.any? { |kind, name| name == :timeout && %i[key keyreq].include?(kind) }

      if accepts_timeout
        method.call(*args, timeout: remaining)
      else
        method.call(*args)
      end
    end

    # Chains SIGTERM/SIGINT and at_exit to a logger's close.
    #
    # Nothing is installed by requiring this file: a host that embeds the SDK
    # owns its own lifecycle. The previous trap is chained after the drain
    # rather than replaced, and a second signal arriving mid-drain restores the
    # default disposition and re-raises, so a wedged transport can never make
    # the process unkillable.
    class ProcessHooks
      attr_reader :hooks, :reason

      def initialize(hooks, reason, uninstall)
        @hooks = hooks.freeze
        @reason = reason
        @uninstall = uninstall
      end

      def call
        @uninstall.call
      end
      alias uninstall call
    end

    def install_process_hooks!(logger, timeout: DEFAULT_SHUTDOWN_TIMEOUT, force_on_second_signal: true)
      # Deliberately plain flags rather than a Mutex: Ruby raises ThreadError
      # for Mutex#synchronize inside a trap context, and under the GVL a boolean
      # assignment is already indivisible with respect to a trap handler.
      state = { draining: false, active: true }
      previous_traps = {}

      drain = lambda do
        begin
          logger.close(timeout: timeout)
        rescue StandardError => error
          warn("next-loggers shutdown drain failed: #{error.message}")
        end
      end

      # at_exit blocks cannot be unregistered in Ruby, so uninstall flips a flag
      # the block reads. The block outlives uninstall; its effect does not.
      at_exit do
        drain.call if state[:active]
      end

      hooks = ["at-exit"]
      reason = ""

      %w[TERM INT].each do |name|
        signal_hook = name == "TERM" ? "signal-sigterm" : "signal-sigint"
        begin
          previous_traps[name] = Signal.trap(name) do
            if state[:draining] && force_on_second_signal
              # The operator is done waiting. Trapping the signal overrode the
              # kernel default, so returning here would leave the process
              # unkillable for as long as a wedged transport takes to give up.
              Signal.trap(name, "DEFAULT")
              Process.kill(name, Process.pid)
              next
            end
            state[:draining] = true

            # A trap handler may not block on a Mutex, and the drain does. A
            # thread started from trap context may, so the work happens there.
            Thread.new do
              drain.call
              state[:active] = false
              previous = previous_traps[name]
              if previous.respond_to?(:call)
                previous.call
              else
                # Nothing else claimed the signal. Trapping it suppressed the
                # kernel default, so the process would otherwise survive a
                # SIGTERM it was supposed to die from.
                Signal.trap(name, "DEFAULT")
                Process.kill(name, Process.pid)
              end
            end
          end
          hooks << signal_hook
        rescue ArgumentError, Errno::EINVAL => error
          reason = "#{name} trap rejected by the runtime: #{error.message}"
        end
      end

      uninstall = lambda do
        state[:active] = false
        previous_traps.each do |name, previous|
          begin
            Signal.trap(name, previous.nil? ? "DEFAULT" : previous)
          rescue ArgumentError, Errno::EINVAL
            # The platform withdrew the signal; nothing left to restore.
          end
        end
        previous_traps.clear
      end

      ProcessHooks.new(hooks, reason, uninstall)
    end
  end
end
