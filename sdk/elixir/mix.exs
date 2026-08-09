defmodule ORESoftware.NextLoggers.MixProject do
  use Mix.Project

  @version "0.1.0"
  @source_url "https://github.com/ORESoftware/next-loggers.ts"

  def project do
    [
      app: :oresoftware_next_loggers_elixir,
      version: @version,
      elixir: ">= 1.14.0",
      description: "Elixir implementation of the next-loggers/v1 structured logging contract",
      source_url: @source_url,
      homepage_url: @source_url,
      package: package(),
      deps: []
    ]
  end

  def application do
    []
  end

  defp package do
    [
      name: "oresoftware_next_loggers_elixir",
      files: ["lib", "mix.exs", "README.md", "LICENSE", "CHANGELOG.md"],
      licenses: ["MIT"],
      links: %{
        "GitHub" => @source_url,
        "Changelog" => "#{@source_url}/blob/main/sdk/elixir/CHANGELOG.md"
      }
    ]
  end
end
