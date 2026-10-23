// R09: a daily copy of the shop database and a restore check into a separate database.
//   node scripts/database-backup.cjs backup [--out DIR] [--keep 14]
//   node scripts/database-backup.cjs verify [--out DIR] [--file shop-....dump] [--max-age-hours 36]
// Connection (Npgsql format, as in appsettings): SHOP_BACKUP_CONNECTION, else ConnectionStrings:Shop from
// backend/CosmeticsShop.Api/appsettings.Local.json. The restore check may use another server with the right to
// create databases: SHOP_RESTORE_CONNECTION. PostgreSQL 18 tools: --pg-bin DIR or PG_BIN, else PATH
// (on Windows C:\Program Files\PostgreSQL\18\bin). Passwords go to the tools through PGPASSWORD only and are
// never printed or written next to the copies. The source database is only read.
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

function options(argv) {
  const result = {command: argv[0]};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--')) throw new Error(`Unexpected argument ${argv[index]}.`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

/** Npgsql "Host=...;Port=...;Database=...;Username=...;Password=..." → libpq environment. */
function connectionEnv(text, database) {
  const values = {};
  for (const part of text.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) values[part.slice(0, separator).trim().toLowerCase().replaceAll(' ', '')] = part.slice(separator + 1).trim();
  }
  const env = {PGHOST: values.host ?? values.server ?? 'localhost', PGPORT: values.port ?? '5432',
    PGDATABASE: database ?? values.database ?? 'postgres', PGUSER: values.username ?? values.userid ?? values.user ?? '',
    PGCONNECT_TIMEOUT: values.timeout ?? '10', PGAPPNAME: 'barberbot-backup'};
  if (values.password) env.PGPASSWORD = values.password;
  return env;
}

function sourceConnection() {
  if (process.env.SHOP_BACKUP_CONNECTION) return process.env.SHOP_BACKUP_CONNECTION;
  const file = path.join(root, 'backend/CosmeticsShop.Api/appsettings.Local.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).ConnectionStrings?.Shop;
    if (value) return value;
  } catch { /* reported below */ }
  throw new Error('No connection: set SHOP_BACKUP_CONNECTION or ConnectionStrings:Shop in appsettings.Local.json.');
}

function tool(name, settings) {
  const directory = settings['pg-bin'] ?? process.env.PG_BIN ?? (isWindows ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '');
  return directory ? path.join(directory, name + (isWindows ? '.exe' : '')) : name;
}

/** Runs a PostgreSQL tool; the error names the tool and its message, never the environment. */
function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {env: {...process.env, ...env}, windowsHide: true});
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => reject(new Error(`${path.basename(file)}: ${error.code === 'ENOENT' ? 'not found, set --pg-bin' : error.message}`)));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(file)} failed: ${errors.trim().split('\n').at(-1) ?? code}`)));
  });
}

/**
 * One psql session kept open, so the dump and the fingerprint read the same snapshot.
 * Each query ends with a marker line, which separates the answers.
 */
function session(settings, env) {
  const child = spawn(tool('psql', settings), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], {env: {...process.env, ...env}, windowsHide: true});
  let buffer = '', errors = '', waiting = null, closed = false;
  const marker = `__done_${crypto.randomUUID()}__`;
  const settle = () => {
    const end = buffer.indexOf(marker + '\n');
    if (waiting && end >= 0) { const answer = buffer.slice(0, end); buffer = buffer.slice(end + marker.length + 1); waiting.resolve(answer); waiting = null; }
  };
  child.stdout.on('data', chunk => { buffer += chunk.toString().replaceAll('\r\n', '\n'); settle(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('error', error => waiting?.reject(new Error(`psql: ${error.code === 'ENOENT' ? 'not found, set --pg-bin' : error.message}`)));
  child.on('close', () => { closed = true; waiting?.reject(new Error(`psql failed: ${errors.trim().split('\n').at(-1) ?? 'closed'}`)); });
  return {
    query: sql => new Promise((resolve, reject) => {
      if (closed) return reject(new Error(`psql failed: ${errors.trim().split('\n').at(-1) ?? 'closed'}`));
      waiting = {resolve, reject};
      child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    }),
    close: () => new Promise(resolve => { if (closed) return resolve(); child.on('close', resolve); child.stdin.end('\\q\n'); }),
  };
}

const quote = name => `"${name.replaceAll('"', '""')}"`;

/** Row count and a hash of every row of each table in public, independent of physical order. */
async function fingerprint(query) {
  const tables = (await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"))
    .split('\n').filter(Boolean);
  const result = {};
  for (const table of tables) {
    const [count, hash] = (await query(`SELECT count(*) || '|' || coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') FROM public.${quote(table)} t;`)).trim().split('|');
    result[table] = {rows: Number(count), md5: hash};
  }
  return result;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const defaultOut = () => isWindows
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'BarberBot', 'backups')
  : path.join(os.homedir(), '.local', 'share', 'barberbot', 'backups');
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const copies = out => fs.readdirSync(out).filter(name => /^shop-\d{8}-\d{6}\.dump$/.test(name)).sort();

/** Only one backup at a time; a lock older than two hours is left from a crash and is replaced. */
function lock(out) {
  const file = path.join(out, 'backup.lock');
  try { if (Date.now() - fs.statSync(file).mtimeMs > 2 * 3600_000) fs.rmSync(file); } catch { /* no lock */ }
  try { fs.writeFileSync(file, String(process.pid), {flag: 'wx'}); }
  catch { throw new Error(`Another backup is running (${file}).`); }
  return () => fs.rmSync(file, {force: true});
}

function writeStatus(out, patch) {
  const file = path.join(out, 'status.json');
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  fs.writeFileSync(file, JSON.stringify({...previous, ...patch}, null, 2));
}

async function backup(settings) {
  const out = path.resolve(settings.out ?? defaultOut());
  const keep = Number(settings.keep ?? 14);
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive whole number.');
  fs.mkdirSync(out, {recursive: true});
  const unlock = lock(out);
  const started = new Date();
  const name = `shop-${stamp(started)}.dump`;
  const temporary = path.join(out, `${name}.partial`);
  try {
    const env = connectionEnv(sourceConnection());
    const psql = session(settings, env);
    let metadata;
    try {
      await psql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
      const snapshot = (await psql.query('SELECT pg_export_snapshot();')).trim();
      const version = (await psql.query('SHOW server_version;')).trim();
      await run(tool('pg_dump', settings), ['--format=custom', '--no-owner', `--snapshot=${snapshot}`, `--file=${temporary}`], env);
      const tables = await fingerprint(psql.query);
      const migration = tables.__EFMigrationsHistory
        ? (await psql.query('SELECT max("MigrationId") FROM public."__EFMigrationsHistory";')).trim() : null;
      await psql.query('COMMIT;');
      metadata = {kind: 'BarberBotDatabaseBackup', file: name, createdAt: started.toISOString(), serverVersion: version, migration, tables};
    } finally { await psql.close(); }
    const final = path.join(out, name);
    fs.renameSync(temporary, final);
    metadata.bytes = fs.statSync(final).size;
    metadata.sha256 = await sha256(final);
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(metadata, null, 2));
    // Older copies are removed only now, after the new one is complete.
    for (const old of copies(out).slice(0, -keep)) { fs.rmSync(path.join(out, old)); fs.rmSync(path.join(out, `${old}.json`), {force: true}); }
    writeStatus(out, {lastAttempt: started.toISOString(), ok: true, error: null, lastSuccess: started.toISOString(), file: name});
    console.log(`OK backup ${final} (${metadata.bytes} bytes, ${Object.keys(metadata.tables).length} tables, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    writeStatus(out, {lastAttempt: started.toISOString(), ok: false, error: error.message});
    throw error;
  } finally { unlock(); }
}

async function verify(settings) {
  const out = path.resolve(settings.out ?? defaultOut());
  const maxAgeHours = Number(settings['max-age-hours'] ?? 36);
  const name = settings.file ?? copies(out).at(-1);
  if (!name) throw new Error(`No backups in ${out}.`);
  const file = path.join(out, path.basename(name));
  const metadata = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  const started = Date.now();
  if (await sha256(file) !== metadata.sha256) throw new Error(`${path.basename(file)} is damaged: SHA-256 differs from its metadata.`);
  const admin = process.env.SHOP_RESTORE_CONNECTION ?? sourceConnection();
  const database = `shop_restore_check_${crypto.randomBytes(6).toString('hex')}`;
  const adminEnv = connectionEnv(admin, 'postgres');
  await run(tool('psql', settings), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${quote(database)} TEMPLATE template0;`], adminEnv);
  try {
    const env = connectionEnv(admin, database);
    await run(tool('pg_restore', settings), ['--no-owner', '--exit-on-error', `--dbname=${database}`, file], env);
    const psql = session(settings, env);
    let restored;
    try { await psql.query('ANALYZE;'); restored = await fingerprint(psql.query); } finally { await psql.close(); }
    const differences = [...new Set([...Object.keys(metadata.tables), ...Object.keys(restored)])]
      .filter(table => JSON.stringify(metadata.tables[table]) !== JSON.stringify(restored[table]));
    if (differences.length) throw new Error(`Restored data differs from the source snapshot: ${differences.join(', ')}.`);
    const ageHours = (Date.now() - Date.parse(metadata.createdAt)) / 3600_000;
    const seconds = (Date.now() - started) / 1000;
    const rows = Object.values(restored).reduce((sum, table) => sum + table.rows, 0);
    writeStatus(out, {lastVerify: new Date().toISOString(), verifyOk: ageHours <= maxAgeHours, verifiedFile: metadata.file,
      restoreSeconds: Number(seconds.toFixed(1)), backupAgeHours: Number(ageHours.toFixed(1))});
    console.log(`OK restore ${metadata.file}: ${Object.keys(restored).length} tables, ${rows} rows match; ${seconds.toFixed(1)} s; copy is ${ageHours.toFixed(1)} h old`);
    // A copy that restores fine but is too old means the daily backup stopped: that is a failure too.
    if (ageHours > maxAgeHours) throw new Error(`The newest copy is ${ageHours.toFixed(1)} h old (limit ${maxAgeHours} h): the daily backup is not running.`);
  } finally {
    await run(tool('psql', settings), ['-X', '-q', '-c', `DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE);`], adminEnv).catch(() => {});
  }
}

(async () => {
  const settings = options(process.argv.slice(2));
  if (settings.command === 'backup') await backup(settings);
  else if (settings.command === 'verify') await verify(settings);
  else throw new Error('Usage: node scripts/database-backup.cjs backup|verify [--out DIR] ...');
})().catch(error => { console.error(`FAIL ${error.message}`); process.exitCode = 1; });
