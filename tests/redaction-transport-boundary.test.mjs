import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';

test('redaction completes before custom and HTTP transport fan-out', async () => {
  const customRecords = [];
  const httpRecords = [];
  const rawSecrets = [
    'pw-secret',
    'tok-secret',
    'nested-email@example.test',
    'field-secret',
  ];

  const logger = createLogger({
    console: false,
    loggedInUser: { id: 'u-1', email: 'identity@example.test' },
    transports: {
      name: 'transport-boundary-spy',
      write(record) {
        customRecords.push(record);
      },
    },
    http: {
      endpoint: 'https://collector.example.test/logs',
      fetch: async (_url, init) => {
        httpRecords.push(JSON.parse(String(init?.body ?? 'null')));
        return new Response(null, { status: 204 });
      },
    },
  });

  await logger
    .error('authentication failed', {
      password: rawSecrets[0],
      nested: {
        apiToken: rawSecrets[1],
        profile: { email: rawSecrets[2] },
      },
    })
    .addFields({ sessionSecret: rawSecrets[3], requestId: 'request-1' })
    .send();
  await logger.flush({ throwOnError: true });

  assert.equal(customRecords.length, 1);
  assert.equal(httpRecords.length, 1);
  assert.deepEqual(httpRecords[0], customRecords[0]);

  for (const boundaryRecord of [customRecords[0], httpRecords[0]]) {
    const serialized = JSON.stringify(boundaryRecord);
    for (const secret of rawSecrets) {
      assert.equal(serialized.includes(secret), false, `transport boundary leaked ${secret}`);
    }
    assert.equal(boundaryRecord.values[1].password, '[REDACTED]');
    assert.equal(boundaryRecord.values[1].nested.apiToken, '[REDACTED]');
    assert.equal(boundaryRecord.values[1].nested.profile.email, '[REDACTED]');
    assert.equal(boundaryRecord.fields.sessionSecret, '[REDACTED]');
    assert.equal(boundaryRecord.fields.requestId, 'request-1');

    // Identity correlation is an explicitly documented exception to key redaction.
    assert.equal(boundaryRecord.loggedInUser.email, 'identity@example.test');
  }

  await logger.close({ throwOnError: true });
});
