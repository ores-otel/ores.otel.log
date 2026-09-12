# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/oresoftware/next_loggers"

class ContextFiberIsolationTest < Minitest::Test
  NL = ORESoftware::NextLoggers

  def test_nested_values_are_owned_and_frozen
    source = {
      trace_id: "trace-a",
      fields: {
        tenant: { id: "tenant-a", regions: ["west"] },
        request: { id: "request-a", retry: { attempt: 1 } }
      },
      tags: ["request"]
    }

    NL.with_context(source) do
      source[:fields][:tenant][:id] = "attacker"
      source[:fields][:tenant][:regions] << "east"
      source[:fields][:request][:retry][:attempt] = 99
      source[:tags] << "attacker"

      context = NL.current_context
      assert_equal "tenant-a", context.fields.fetch("tenant").fetch(:id)
      assert_equal ["west"], context.fields.fetch("tenant").fetch(:regions)
      assert_equal 1, context.fields.fetch("request").fetch(:retry).fetch(:attempt)
      assert_equal ["request"], context.tags
      assert_raises(FrozenError) { context.fields.fetch("tenant")[:id] = "mutated" }
    end
    assert_nil NL.current_context
  end

  def test_same_thread_fibers_do_not_share_context
    first = Fiber.new do
      NL.with_context(trace_id: "fiber-a", fields: { tenant: { id: "a" } }) do
        Fiber.yield [NL.current_context.trace_id, NL.current_context.fields.fetch("tenant").fetch(:id)]
        Fiber.yield [NL.current_context.trace_id, NL.current_context.fields.fetch("tenant").fetch(:id)]
      end
      NL.current_context
    end
    second = Fiber.new do
      NL.with_context(trace_id: "fiber-b", fields: { tenant: { id: "b" } }) do
        Fiber.yield [NL.current_context.trace_id, NL.current_context.fields.fetch("tenant").fetch(:id)]
        Fiber.yield [NL.current_context.trace_id, NL.current_context.fields.fetch("tenant").fetch(:id)]
      end
      NL.current_context
    end

    assert_equal ["fiber-a", "a"], first.resume
    assert_equal ["fiber-b", "b"], second.resume
    assert_equal ["fiber-a", "a"], first.resume
    assert_equal ["fiber-b", "b"], second.resume
    assert_nil first.resume
    assert_nil second.resume
    assert_nil NL.current_context
  end

  def test_failure_restores_parent_fiber_frame
    NL.with_context(trace_id: "parent") do
      error = assert_raises(RuntimeError) do
        NL.with_context(trace_id: "child") { raise "expected" }
      end
      assert_equal "expected", error.message
      assert_equal "parent", NL.current_context.trace_id
    end
    assert_nil NL.current_context
  end

  def test_child_thread_requires_explicit_capture
    NL.with_context(trace_id: "captured", fields: { tenant: { id: "tenant-c" } }) do
      captured = NL.capture_context
      observed = Queue.new
      Thread.new do
        observed << NL.current_context
        NL.with_captured_context(captured) do
          observed << [NL.current_context.trace_id, NL.current_context.fields.fetch("tenant").fetch(:id)]
        end
        observed << NL.current_context
      end.join

      assert_nil observed.pop
      assert_equal ["captured", "tenant-c"], observed.pop
      assert_nil observed.pop
      assert_equal "captured", NL.current_context.trace_id
    end
    assert_nil NL.current_context
  end

  def test_cyclic_hash_is_snapshotted_without_pointing_to_caller
    cyclic = { id: "original" }
    cyclic[:self] = cyclic
    NL.with_context(fields: { cyclic: cyclic }) do
      cyclic[:id] = "attacker"
      observed = NL.current_context.fields.fetch("cyclic")
      assert_equal "original", observed.fetch(:id)
      assert_same observed, observed.fetch(:self)
    end
  end
end
