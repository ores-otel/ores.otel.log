# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = "oresoftware-next-loggers"
  # RubyGems tooling and the Zed preflight require a literal artifact version.
  # Keep this synchronized with lib/oresoftware/next_loggers/version.rb; the
  # package parity test rejects drift between the published gem and the SDK.
  spec.version = "0.1.0"
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
