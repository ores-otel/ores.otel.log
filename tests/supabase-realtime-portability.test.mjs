import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  byteLength,
  jwtExpiryMillis,
  realtimeUrl,
  SupabaseRealtimeAckTransport,
} from '@oresoftware/next-loggers/supabase-realtime';

const jwt = (claims) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const record = (id = 'r1', message = 'hello') => ({
  schema: 'next-loggers/v1',
  id,
  timestamp: 'now',
  level: 'INFO',
  runtime: 'base',
  appName: 'app',
  message,
  values: [],
  fields: {},
});

/**
 * The service-role guard used to decode via globalThis.atob and return
 * undefined when it was absent, so it failed OPEN in any runtime without it.
 * A guard that silently passes somewhere is worse than no guard.
 */
test('a service-role JWT is refused without relying on atob', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'atob');
  // eslint-disable-next-line no-undef
  delete globalThis.atob;
  try {
    assert.throws(
      () =>
        new SupabaseRealtimeAckTransport({
          url: 'https://project.supabase.co',
          publishableKey: jwt({ role: 'service_role' }),
        }),
      /publishable or user-scoped/,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, 'atob', original);
  }
});

test('jwt expiry decodes without atob', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'atob');
  // eslint-disable-next-line no-undef
  delete globalThis.atob;
  try {
    assert.equal(jwtExpiryMillis(jwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
    assert.equal(jwtExpiryMillis('not-a-jwt'), undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, 'atob', original);
  }
});

test('the socket url refuses credentials and drops query strings', () => {
  assert.throws(
    () => realtimeUrl('https://user:pw@project.supabase.co'),
    /embedded credentials/,
  );
  // A caller-supplied query would otherwise ride along into proxy logs.
  assert.equal(
    realtimeUrl('https://project.supabase.co/?token=leaky#frag'),
    'wss://project.supabase.co/realtime/v1/websocket',
  );
});

test('a record over the frame limit is dropped, not retried forever', async () => {
  const drops = [];
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'anon-key',
    allowUnauthenticated: true,
    maxRecordBytes: 512,
    reconnect: false,
    onDrop: (drop) => drops.push(drop),
    onError: () => undefined,
    webSocketFactory: () => {
      throw new Error('should never connect for an oversized record');
    },
  });

  await transport.write(record('big', 'x'.repeat(4_000)));

  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, 'record-too-large');
  assert.equal(transport.snapshot().queued, 0);
});

test('byteLength counts utf-8 bytes, not utf-16 code units', () => {
  assert.equal(byteLength('abc'), 3);
  assert.equal(byteLength('€'), 3);
  assert.equal(byteLength('🙂'), 4);
});
