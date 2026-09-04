# frozen_string_literal: true

# The version lives in exactly one place. A literal here is a second source of
# truth that drifts silently, because nothing installs the gem during CI.
require_relative "lib/oresoftware/next_loggers/version"

Gem::Specification.new do |spec|
  spec.name = "oresoftware-next-loggers"
  spec.version = ORESoftware::NextLoggers::VERSION
  spec.authors = ["ORESoftware"]
  spec.email = ["opensource@oresoftware.com"]

  spec.summary = "Ruby implementation of the next-loggers/v1 structured logging contract"
  spec.description = "Dependency-free structured logging with scoped thread context and application-owned OTEL and Supabase transports."
  spec.homepage = "https://github.com/ores-otel/ores.otel.log"
  spec.license = "MIT"
  spec.required_ruby_version = Gem::Requirement.new(">= 3.1")

  spec.metadata["allowed_push_host"] = "https://rubygems.org"
  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/ores-otel/ores.otel.log/tree/main/sdk/ruby"
  spec.metadata["bug_tracker_uri"] = "https://github.com/ores-otel/ores.otel.log/issues"
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir.glob("lib/**/*.rb") + ["README.md", "LICENSE"]
  spec.require_paths = ["lib"]
end
