// Local demonstration helper. Uses only Node built-ins and the system SSH client.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const readline = require('node:readline');
const {spawn} = require('node:child_process');

function urlFromLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!event || typeof event !== 'object' || event.type !== 'v1.tcpip_forward.register.accepted' || typeof event.id !== 'string') return null;
  const match = /^localhost\/([a-z0-9-]+\.(?:lhr\.life|localhost\.run))$/.exec(event.id);
  return match ? `https://${match[1]}/` : null;
}

function isReady(status, contentType, body) {
  if (status !== 200 || !/^application\/json(?:;|$)/i.test(contentType || '') || body.length > 4096) return false;
  try { return JSON.parse(body).status === 'ready'; } catch { return false; }
}

function verifyReady(base) {
  return new Promise(resolve => {
    const request = https.get(new URL(`api/health/ready?tunnelCheck=${Date.now()}`, base),
      {headers: {'Cache-Control': 'no-cache'}}, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', part => { body += part; if (body.length > 4096) response.destroy(); });
        response.on('end', () => resolve(isReady(response.statusCode, response.headers['content-type'], body)));
        response.on('error', () => resolve(false));
      });
    request.setTimeout(5000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function publishUrl(url, files, verify = verifyReady) {
  if (!/^https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)\/$/.test(url)) return false;
  if (!await verify(url)) return false;
  const content = JSON.stringify({Telegram: {MiniAppUrl: url}}, null, 2) + '\n';
  for (const file of files) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, {encoding: 'utf8', mode: 0o600});
    fs.renameSync(temporary, file);
  }
  return true;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/local-preview.json'), 'utf8').replace(/^\uFEFF/, ''));
  const published = path.resolve(metadata.publishDirectory);
  const relative = path.relative(path.join(root, 'artifacts'), published);
  if (metadata.kind !== 'CosmeticsShopLocalAcceptance' || path.resolve(metadata.projectRoot) !== root
    || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unexpected local preview metadata.');
  const files = [path.join(published, 'appsettings.Tunnel.json'), path.join(root, 'backend/CosmeticsShop.Api/appsettings.Tunnel.json')];
  const run = path.join(root, 'artifacts/local-tunnel');
  fs.mkdirSync(run, {recursive: true});
  const stateFile = path.join(run, 'state.json');
  const stopFile = path.join(run, 'stop');
  // Refuse a duplicate supervisor. A reused/live PID is never terminated here.
  if (fs.existsSync(stateFile)) {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (Number.isInteger(previous.pid) && previous.pid > 0) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new Error('A tunnel supervisor may already be running; inspect artifacts/local-tunnel/state.json.');
    }
  }
  const state = {kind: 'CosmeticsShopTunnelSupervisor', projectRoot: root, pid: process.pid, startedUtc: new Date().toISOString(), url: null};
  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  saveState();
  const knownHosts = path.join(run, 'known_hosts');
  const previousHosts = path.join(root, 'artifacts/tunnel-diagnostics/known_hosts');
  if (!fs.existsSync(knownHosts) && fs.existsSync(previousHosts)) fs.copyFileSync(previousHosts, knownHosts);
  let child = null, candidate = null, applying = false, stopping = false, retry = null;
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  const apply = async () => {
    if (applying || stopping || !candidate || candidate === state.url) return;
    applying = true;
    const next = candidate;
    try {
      if (await publishUrl(next, files, async url => {
        const ready = await verifyReady(url);
        return ready && !stopping && candidate === url;
      })) {
        state.url = next;
        saveState();
        log(`Verified tunnel URL updated: ${next}`);
      }
    } catch { log('Could not update tunnel settings; retaining the previous URL and retrying.'); }
    finally { applying = false; }
  };
  const connect = () => {
    if (stopping) return;
    candidate = null;
    const args = ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none',
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=12',
      '-o', 'ExitOnForwardFailure=yes', '-R', '80:127.0.0.1:8081', 'nokey@localhost.run',
      '--', '--inject-http-proxy-headers', '--output', 'json'];
    child = spawn('ssh', args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    state.sshPid = child.pid;
    saveState();
    // Never interpret or execute commands from the remote banner.
    const lines = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
    lines.on('line', line => { const url = urlFromLine(line); if (url) {candidate = url; void apply();} });
    child.stderr.on('data', () => {});
    child.on('error', () => log('SSH could not start. Check the SSH installation and network.'));
    child.on('close', () => {
      child = null; candidate = null;
      if (!stopping) {log('SSH disconnected; reconnecting in five seconds.'); retry = setTimeout(connect, 5000);}
    });
  };
  const timer = setInterval(() => {
    if (fs.existsSync(stopFile)) stop();
    else void apply();
  }, 2000);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer); clearTimeout(retry);
    if (child) child.kill();
    log('Tunnel supervisor stopped. Previously sent buttons may no longer work.');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  connect();
}

module.exports = {urlFromLine, isReady, publishUrl};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
