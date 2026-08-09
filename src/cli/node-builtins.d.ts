// Minimal ambient declarations for the Node built-ins the CLI touches.
// Mirrors the precedent set by src/async-hooks.d.ts: this package does not
// depend on @types/node, so consumers with skipLibCheck:false still typecheck.

declare module 'node:fs/promises' {
  export function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  export function access(path: string | URL): Promise<void>;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:readline' {
  export interface AsyncLineReader extends AsyncIterable<string> {
    close(): void;
  }
  export function createInterface(options: {
    input: unknown;
    crlfDelay?: number;
  }): AsyncLineReader;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  cwd(): string;
  version: string;
  platform: string;
  stdin: unknown & { isTTY?: boolean };
  stdout: { write(chunk: string): boolean; isTTY?: boolean; columns?: number };
  stderr: { write(chunk: string): boolean; isTTY?: boolean };
  hrtime: { bigint(): bigint };
};
