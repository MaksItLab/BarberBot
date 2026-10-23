// R10: the whole automatic regression set in one run, with a report that names what it does not check.
// Usage: node scripts/test-all.cjs [--skip-server] [--skip-browser]
//   Server tests need SHOP_TEST_ADMIN_CONNECTION (a separate test PostgreSQL); on Windows without it
//   scripts/test-database.ps1 starts one. Browser suites use SHOP_UI_URL, or a Vite dev server started here.
//   PLAYWRIGHT_CHANNEL: msedge by default; empty for Playwright's own Chromium.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const results = [];
const isWindows = process.platform === 'win32';

/** Runs a command, keeps only the tail of its output, and never rejects. */
function run(command, commandArgs, {timeoutMs, env = {}, cwd = root} = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, commandArgs, {cwd, env: {...process.env, ...env}, shell: isWindows, windowsHide: true});
    let output = '';
    const keep = chunk => { output = (output + chunk).slice(-20_000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = timeoutMs && setTimeout(() => { output += `\nTimed out after ${timeoutMs / 1000} s.`; child.kill(); }, timeoutMs);
    child.on('error', error => keep(`\n${error.message}`));
    child.on('close', code => { clearTimeout(timer); resolve({code, output, seconds: (Date.now() - started) / 1000}); });
  });
}

const lastLine = text => text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';

async function serverTests() {
  if (args.has('--skip-server')) return results.push({name: 'Серверные тесты', status: 'SKIP', detail: '--skip-server'});
  const command = process.env.SHOP_TEST_ADMIN_CONNECTION
    ? ['dotnet', ['test', 'tests/CosmeticsShop.Api.IntegrationTests', '--configuration', 'Release']]
    : isWindows ? ['pwsh', ['-NoProfile', '-File', 'scripts/test-database.ps1']] : null;
  if (!command) return results.push({name: 'Серверные тесты', status: 'FAIL', detail: 'Задайте SHOP_TEST_ADMIN_CONNECTION: отдельный тестовый PostgreSQL.'});
  const result = await run(...command, {timeoutMs: 15 * 60_000});
  const summary = result.output.match(/(Passed|Failed)!\s+-\s+Failed:\s+\d+,\s+Passed:\s+\d+[^\n]*?Total:\s+\d+/)?.[0];
  const failures = [...result.output.matchAll(/^\s*Failed (\S+) \[/gm)].map(match => match[1]);
  results.push({name: 'Серверные тесты', status: result.code === 0 ? 'PASS' : 'FAIL', seconds: result.seconds,
    detail: [summary ?? lastLine(result.output), ...failures].join('; ')});
}

async function waitFor(url, timeoutMs) {
  for (const until = Date.now() + timeoutMs; Date.now() < until;) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function browserSuites() {
  if (args.has('--skip-browser')) return results.push({name: 'Браузерные наборы', status: 'SKIP', detail: '--skip-browser'});
  let server;
  let base = process.env.SHOP_UI_URL;
  if (!base) {
    base = 'http://127.0.0.1:5173';
    server = spawn('pnpm', ['--dir', 'frontend', 'exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
      {cwd: root, shell: isWindows, stdio: 'ignore', windowsHide: true});
    if (!await waitFor(base, 60_000)) {
      server.kill();
      return results.push({name: 'Браузерные наборы', status: 'FAIL', detail: 'Vite не запустился на 5173 за 60 с.'});
    }
  }
  try {
    const suites = fs.readdirSync(path.join(root, 'tests/frontend'))
      .filter(name => name.endsWith('.cjs') && !['browser.cjs', 'e2e.cjs'].includes(name)).sort();
    for (const suite of suites) {
      const result = await run('node', [path.join('tests/frontend', suite)], {timeoutMs: 5 * 60_000, env: {SHOP_UI_URL: base}});
      const passed = result.code === 0 && /^PASS:/m.test(result.output);
      results.push({name: suite, status: passed ? 'PASS' : 'FAIL', seconds: result.seconds,
        detail: passed ? '' : lastLine(result.output).slice(0, 300)});
    }
  } finally { server?.kill(); }
}

function report(totalSeconds) {
  const lines = ['# Регрессионный набор', '', `Дата: ${new Date().toISOString()}. Время: ${totalSeconds.toFixed(0)} с.`, '',
    '| Проверка | Итог | Время, с | Подробности |', '| --- | --- | --- | --- |',
    ...results.map(value => `| ${value.name} | ${value.status} | ${value.seconds?.toFixed(1) ?? ''} | ${(value.detail ?? '').replaceAll('|', '/')} |`),
    '', '## Не проверено этим набором', '',
    '- Настоящий Telegram на телефоне и компьютере, сети и VPN: протокол в docs/device-protocol.md (R02).',
    '- `tests/frontend/e2e.cjs`: опубликованное приложение с настоящим PostgreSQL, `scripts/test-e2e.ps1` на Windows.',
    '- Telegram API (DeviceStorage, activated, подтверждение закрытия) имитируется по документации.',
    '- Перезапуск процесса PostgreSQL; проверены перезапуск приложения и новое соединение.'];
  const text = lines.join('\n') + '\n';
  fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
  fs.writeFileSync(path.join(root, 'artifacts/test-report.md'), text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}

(async () => {
  const started = Date.now();
  fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true}); // suites save screenshots there
  await serverTests();
  await browserSuites();
  report((Date.now() - started) / 1000);
  process.exitCode = results.some(value => value.status === 'FAIL') ? 1 : 0;
})();
