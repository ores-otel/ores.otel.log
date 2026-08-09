// workerd entry point. Wrangler serves this as a Worker; CI hits `/` and the
// response body carries the conformance result.
//
// Deployed WITHOUT nodejs_als (see wrangler.conformance.toml) on purpose: it
// proves the package still loads and logs on a bare Worker. A static
// node:async_hooks import would kill the isolate at startup here, which is the
// regression the context-workerd build exists to prevent.
import { formatResult, runConformance } from './runtime-conformance.mjs';
import { createCloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';

export default {
  async fetch(request, env, ctx) {
    const result = await runConformance({
      runtime: 'workerd',
      // No nodejs_als flag → the single-frame fallback is the correct answer.
      expectAsyncContext: false,
    });

    if (result.detectedRuntime !== 'cloudflare') {
      result.failures.push(
        `root export resolved to "${result.detectedRuntime}", expected "cloudflare"`,
      );
    }

    // Exercise the Cloudflare logger's own request binding while we are here.
    const workerRecords = [];
    const log = createCloudflareWorkerLogger({
      console: false,
      transports: { write: (record) => void workerRecords.push(record) },
    }).forRequest(request, ctx, env);

    await log.info('worker conformance').send();
    if (workerRecords[0]?.fields?.requestUrl !== request.url) {
      result.failures.push('forRequest() did not attach requestUrl');
    }
    if (workerRecords[0]?.runtime !== 'cloudflare') {
      result.failures.push(`record runtime was "${workerRecords[0]?.runtime}"`);
    }

    return new Response(formatResult(result), {
      status: result.failures.length === 0 ? 200 : 500,
      headers: { 'content-type': 'text/plain' },
    });
  },
};
