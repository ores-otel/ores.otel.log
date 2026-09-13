// Minimal ambient declarations for the Node built-ins src/apm.ts touches.
// Same precedent as src/async-hooks.d.ts and src/cli/node-builtins.d.ts: the
// package does not depend on @types/node. Ambient module declarations merge.

declare module 'node:fs/promises' {
  export interface StatFs {
    type: number;
    bsize: number;
    blocks: number;
    bfree: number;
    bavail: number;
    files: number;
    ffree: number;
  }
  export function statfs(path: string | URL): Promise<StatFs>;
}

declare module 'node:perf_hooks' {
  export interface IntervalHistogram {
    enable(): boolean;
    disable(): boolean;
    percentile(percentile: number): number;
    readonly max: number;
    readonly count: number;
  }
  export function monitorEventLoopDelay(options?: { resolution?: number }): IntervalHistogram;
  export interface EventLoopUtilization {
    idle: number;
    active: number;
    utilization: number;
  }
  export const performance: {
    now(): number;
    eventLoopUtilization(current?: EventLoopUtilization, previous?: EventLoopUtilization): EventLoopUtilization;
  };
}
