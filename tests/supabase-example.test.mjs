import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionSource = await readFile(
  path.join(root, 'examples/supabase/functions/telemetry-ingest/index.ts'),
  'utf8',
);
const migration = await readFile(
  path.join(root, 'examples/supabase/migrations/0001_next_logger_ingest.sql'),
  'utf8',
);
const functionConfig = await readFile(
  path.join(root, 'examples/supabase/config.toml'),
  'utf8',
);

test('Supabase function requires a verified user and never embeds an elevated client key', () => {
  assert.match(functionSource, /createSupabaseContext\(request, \{ auth: 'user' \}\)/u);
  assert.match(functionSource, /ctx\.userClaims\?\.id/u);
  assert.match(functionSource, /ctx\.supabaseAdmin\.rpc\('ingest_next_logger_records'/u);
  assert.match(functionSource, /p_user_id: userId/u);
  assert.equal(/service[_-]?role/iu.test(functionSource), false);
  assert.equal(/sb_secret_/u.test(functionSource), false);
  assert.match(functionConfig, /\[functions\.telemetry-ingest\]/u);
  assert.match(functionConfig, /verify_jwt\s*=\s*true/u);
  assert.match(functionSource, /Never include the batch, bearer token, or raw Postgres error details/u);
});

test('Supabase migration derives ownership from auth, forces RLS, rate-limits, and deduplicates', () => {
  assert.match(migration, /security definer/iu);
  assert.match(migration, /set search_path = pg_catalog, telemetry_private/iu);
  assert.match(migration, /p_user_id uuid/iu);
  assert.match(migration, /force row level security/iu);
  assert.match(migration, /revoke all on telemetry_private\.next_logger_events from public, anon, authenticated, service_role/iu);
  assert.match(migration, /if v_window_count > p_max_records_per_minute/iu);
  assert.match(migration, /on conflict \(user_id, app_name, record_id\) do nothing/iu);
  assert.match(migration, /trace_id ~ '\^\[0-9a-f\]\{32\}\$'/iu);
  assert.match(migration, /grant execute .* to service_role/isu);
});
