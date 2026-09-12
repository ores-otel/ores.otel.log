# Preserved Java context handoff work

`apply-java-context-handoff.yml.txt` preserves the exact workflow bytes from
commit `f348b5dcc2e658bff267256fe07c81bbbe85656c`. Its inline Python contains
unindented multiline-string delimiters, so GitHub cannot parse it as YAML.
The post-merge run at `8a1b0b21534c0339268785d891b2f06001b458f8` failed
before creating any jobs:

<https://github.com/ores-otel/ores.otel.log/actions/runs/34708981086>

The file is retained as source material outside `.github/workflows`; it is
not an executable workflow, validated Java patch, or completed handoff feature.
The original commit and branch history remain intact.

The unfinished work proposes bounded deep collection snapshots, explicit
executor and virtual-thread context handoff, tenant isolation on reused pools,
and cycle refusal. Recover those changes by reviewing the current Java SDK,
porting the implementation and tests into normal source files, and validating
the exact resulting head. Do not execute the archived source-replacement and
commit script against a current checkout without that semantic reconciliation.
