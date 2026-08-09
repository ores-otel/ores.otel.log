import { flagsInScope, type CommandSpec } from './spec.js';
import { readArray, readBool, readFlag } from './argv.js';

export interface CommandResult {
  exitCode: number;
}

/**
 * What a command handler is given: resolved flag values plus output sinks.
 * Handlers never touch process directly, which is what makes them testable.
 */
export class CommandContext {
  readonly command: CommandSpec | undefined;
  readonly positionals: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly packageRoot: string;
  readonly json: boolean;
  readonly color: boolean;

  private readonly parsed: Record<string, string>;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;

  constructor(options: {
    command: CommandSpec | undefined;
    parsed: Record<string, string>;
    positionals: readonly string[];
    env: Record<string, string | undefined>;
    packageRoot: string;
    out: (line: string) => void;
    err: (line: string) => void;
    colorCapable: boolean;
  }) {
    this.command = options.command;
    this.parsed = options.parsed;
    this.positionals = options.positionals;
    this.env = options.env;
    this.packageRoot = options.packageRoot;
    this.out = options.out;
    this.err = options.err;

    this.json = this.bool('json');
    const colorMode = this.flag('color') ?? 'auto';
    // NO_COLOR is honoured unconditionally: https://no-color.org
    this.color =
      options.env.NO_COLOR === undefined &&
      (colorMode === 'always' || (colorMode === 'auto' && options.colorCapable));
  }

  private spec(key: string) {
    return flagsInScope(this.command).find((flag) => flag.key === key);
  }

  flag(key: string): string | undefined {
    const spec = this.spec(key);
    return spec ? readFlag(spec, this.parsed, this.env) : undefined;
  }

  bool(key: string): boolean {
    const spec = this.spec(key);
    return spec ? readBool(spec, this.parsed, this.env) : false;
  }

  list(key: string): string[] {
    const spec = this.spec(key);
    return spec ? readArray(spec, this.parsed, this.env) : [];
  }

  print(line: string): void {
    this.out(line);
  }

  printErr(line: string): void {
    this.err(line);
  }
}
