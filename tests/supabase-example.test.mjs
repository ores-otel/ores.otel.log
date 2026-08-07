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
  path.join(root, 'examples/supabase/migrations/202608020001_next_loggers_ingest.sql'),
  'utf8',
);
const functionConfig = await readFile(
  path.join(root, 'examples/supabase/config.toml'),
  'utf8',
);

test('Supabase function requires a verified user and never embeds an elevated client key', () => {
  assert.match(functionSource, /npm:@supabase\/server@\^1/u);
  assert.match(functionSource, /withSupabase\(\{ auth: 'user' \}/u);
  assert.match(functionSource, /context\.supabase\.rpc\('ingest_next_logger_batch'/u);
  assert.equal(/service[_-]?role/iu.test(functionSource), false);
  assert.equal(/sb_secret_/u.test(functionSource), false);
  assert.match(functionConfig, /\[functions\.telemetry-ingest\]/u);
  assert.match(functionConfig, /verify_jwt\s*=\s*true/u);
  assert.match(functionSource, /Never trust loggedInUser, user_id, tenant_id, or role/u);
});

test('Supabase migration derives ownership from auth, forces RLS, rate-limits, and deduplicates', () => {
  assert.match(migration, /security definer/iu);
  assert.match(migration, /set search_path = public, pg_temp/iu);
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/u);
  assert.match(migration, /force row level security/iu);
  assert.match(migration, /revoke all on public\.next_logger_records from anon, authenticated/iu);
  assert.match(migration, /if v_total > 1000/iu);
  assert.match(migration, /on conflict \(user_id, record_id\) do nothing/iu);
  assert.equal(migration.includes("~ '^0{32}$'"), true);
  assert.match(migration, /grant execute .* to authenticated/iu);
});
