// R09: backup and restore check against a separate test PostgreSQL 18 (SHOP_TEST_ADMIN_CONNECTION).
// Needs pg_dump, pg_restore and psql 18 on PATH or in PG_BIN. Creates and drops only its own databases.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const admin = process.env.SHOP_TEST_ADMIN_CONNECTION;
if (!admin) throw new Error('Set SHOP_TEST_ADMIN_CONNECTION to a separate test PostgreSQL with the right to create databases.');
const script = path.resolve(__dirname, '../../scripts/database-backup.cjs');
const pgBin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '');
const bin = pgBin ? path.join(pgBin, 'psql') : 'psql';
const field = name => admin.split(';').map(part => part.split('=')).find(([key]) => key.trim().toLowerCase() === name)?.[1];
const password = field('password');
const source = `shop_backup_src_${crypto.randomBytes(4).toString('hex')}`;
const withDatabase = database => admin.split(';').filter(part => !/^\s*database\s*=/i.test(part)).concat(`Database=${database}`).join(';');
const libpq = database => ({PGHOST: field('host'), PGPORT: field('port') ?? '5432', PGUSER: field('username'), PGPASSWORD: password, PGDATABASE: database});

function sql(database, text) {
  const result = spawnSync(bin, ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', text], {env: {...process.env, ...libpq(database)}, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'barberbot-backup-'));
function tool(command, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [script, command, '--out', out, ...extra],
    {env: {...process.env, SHOP_BACKUP_CONNECTION: withDatabase(source), SHOP_RESTORE_CONNECTION: admin, ...env}, encoding: 'utf8'});
  return {code: result.status, text: result.stdout + result.stderr};
}
const dumps = () => fs.readdirSync(out).filter(name => name.endsWith('.dump')).sort();
const status = () => JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
const tick = () => { const until = Date.now() + 1100; while (Date.now() < until); }; // copies are named by the second

try {
  sql('postgres', `CREATE DATABASE ${source} TEMPLATE template0`);
  sql(source, `CREATE TABLE brands (id bigint generated always as identity primary key, name text not null unique);
    CREATE TABLE product_variants (id bigint generated always as identity primary key, brand_id bigint references brands, price numeric(12,2), note text);
    CREATE TABLE users (telegram_id bigint primary key, role text not null);
    CREATE TABLE "__EFMigrationsHistory" ("MigrationId" text primary key, "ProductVersion" text);
    INSERT INTO "__EFMigrationsHistory" VALUES ('20261001000000_InitialCatalog', '10.0'), ('20261022113732_SaveOperations', '10.0');
    INSERT INTO brands (name) SELECT 'Бренд ' || i FROM generate_series(1, 50) i;
    INSERT INTO product_variants (brand_id, price, note) SELECT 1 + i % 50, i * 1.25, E'строка\\n«кавычки» ' || i FROM generate_series(1, 2000) i;
    INSERT INTO users VALUES (1382311287, 'Admin'), (9000000001, 'Customer');`);

  // 1. Copy and restore check: same rows and contents, metadata without the password.
  let result = tool('backup');
  assert.equal(result.code, 0, result.text);
  assert.equal(dumps().length, 1);
  const metadataText = fs.readFileSync(path.join(out, `${dumps()[0]}.json`), 'utf8');
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.migration, '20261022113732_SaveOperations');
  assert.equal(metadata.tables.product_variants.rows, 2000);
  assert.match(metadata.serverVersion, /^18/);
  result = tool('verify');
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /OK restore .*4 tables, 2054 rows match/);
  assert.equal(status().verifyOk, true);
  assert.ok(status().restoreSeconds >= 0);

  // 2. Writes during the copy: the fingerprint belongs to the same snapshot as the dump.
  tick();
  const writer = require('node:child_process').spawn(bin, ['-X', '-q', '-c',
    "DO $$ BEGIN FOR i IN 1..400 LOOP INSERT INTO product_variants (brand_id, price) VALUES (1, i); PERFORM pg_sleep(0.005); COMMIT; END LOOP; END $$;"],
    {env: {...process.env, ...libpq(source)}});
  result = tool('backup');
  assert.equal(result.code, 0, result.text);
  result = tool('verify');
  assert.equal(result.code, 0, `consistent under concurrent writes: ${result.text}`);
  spawnSync(process.platform === 'win32' ? 'timeout' : 'sleep', ['3']);
  writer.kill();

  // 3. Retention: with --keep 2 only the two newest copies remain, each with its metadata.
  tick(); assert.equal(tool('backup', ['--keep', '2']).code, 0);
  assert.equal(dumps().length, 2);
  assert.equal(fs.readdirSync(out).filter(name => name.endsWith('.dump.json')).length, 2);

  // 4. A damaged copy fails before any comparison; the restore database is dropped.
  const newest = path.join(out, dumps().at(-1));
  const original = fs.readFileSync(newest);
  const damaged = Buffer.from(original); damaged[damaged.length >> 1] ^= 0xff;
  fs.writeFileSync(newest, damaged);
  result = tool('verify');
  assert.equal(result.code, 1); assert.match(result.text, /FAIL .*damaged: SHA-256 differs/);
  fs.writeFileSync(newest, original);
  assert.equal(sql('postgres', "SELECT count(*) FROM pg_database WHERE datname LIKE 'shop_restore_check_%'"), '0');

  // 5. Database unavailable: failure, no partial file, earlier copies kept, status says why; no password printed.
  const before = dumps();
  tick();
  result = tool('backup', [], {SHOP_BACKUP_CONNECTION: withDatabase(source).replace(/Port=\d+/i, 'Port=1')});
  assert.equal(result.code, 1); assert.match(result.text, /FAIL /);
  assert.deepEqual(dumps(), before);
  assert.equal(fs.readdirSync(out).some(name => name.endsWith('.partial')), false);
  assert.equal(status().ok, false);
  assert.ok(status().lastSuccess, 'the last success stays recorded');
  for (const text of [result.text, metadataText, fs.readFileSync(path.join(out, 'status.json'), 'utf8')])
    assert.ok(!password || !text.includes(password), 'password never printed or stored');

  // 6. A second backup while one runs is refused.
  fs.writeFileSync(path.join(out, 'backup.lock'), '1');
  result = tool('backup');
  assert.equal(result.code, 1); assert.match(result.text, /Another backup is running/);
  fs.rmSync(path.join(out, 'backup.lock'));

  // 7. A copy older than the limit restores, but is reported as a failure: the daily backup stopped.
  result = tool('verify', ['--max-age-hours', '0']);
  assert.equal(result.code, 1); assert.match(result.text, /OK restore[\s\S]*FAIL The newest copy is .* old/);
  assert.equal(status().verifyOk, false);

  // 8. Different data after restore is detected (metadata no longer matches the archive's contents).
  const meta = path.join(out, `${dumps().at(-1)}.json`);
  const changed = JSON.parse(fs.readFileSync(meta, 'utf8')); changed.tables.users.rows = 3;
  fs.writeFileSync(meta, JSON.stringify(changed));
  result = tool('verify');
  assert.equal(result.code, 1); assert.match(result.text, /differs from the source snapshot: users/);

  // The source database was only read: same rows as written above plus the concurrent writer.
  assert.equal(sql(source, 'SELECT count(*) FROM users'), '2');
  console.log('PASS: backup + restore check, snapshot consistency under writes, retention, damaged copy, unavailable database, lock, stale copy, content mismatch, no password in output.');
} finally {
  try { sql('postgres', `DROP DATABASE IF EXISTS ${source} WITH (FORCE)`); } catch (error) { console.error(error.message); }
  fs.rmSync(out, {recursive: true, force: true});
}
