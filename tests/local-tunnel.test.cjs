const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {urlFromLine, isReady, publishUrl} = require('../scripts/local-tunnel.cjs');

test('only registration events for permitted service hosts produce a URL', () => {
  const line = id => JSON.stringify({type:'v1.tcpip_forward.register.accepted',id});
  assert.equal(urlFromLine(line('localhost/abc123.lhr.life')), 'https://abc123.lhr.life/');
  for (const invalid of ['localhost/abc.lhr.life.evil.test','localhost/user@evil.test','https://abc.lhr.life','localhost/abc.lhr.life/path']) {
    assert.equal(urlFromLine(line(invalid)), null);
  }
  assert.equal(urlFromLine('banner $(command)'), null);
  assert.equal(urlFromLine('null'), null);
  assert.equal(urlFromLine('42'), null);
  assert.equal(urlFromLine(JSON.stringify({type:'other',id:'localhost/abc.lhr.life'})), null);
});

test('readiness requires JSON ready and rejects SPA HTML even with status 200', () => {
  assert.equal(isReady(200,'application/json; charset=utf-8','{"status":"ready"}'),true);
  assert.equal(isReady(200,'text/html','<html>no tunnel</html>'),false);
  assert.equal(isReady(503,'application/json','{"status":"ready"}'),false);
  assert.equal(isReady(200,'application/json','{"status":"ok"}'),false);
  assert.equal(isReady(200,'application/json','not JSON'),false);
});

test('failed readiness preserves the previous URL; healthy rotation updates both dedicated files', async () => {
  fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});
  const directory=fs.mkdtempSync(path.join(path.resolve(__dirname,'../artifacts'), 'tunnel-test-'));
  const files=[path.join(directory,'source.json'),path.join(directory,'published.json')];
  const first='https://first.lhr.life/';
  const second='https://second.lhr.life/';
  assert.equal(await publishUrl(first,files,async()=>true),true);
  const saved=files.map(file=>fs.readFileSync(file,'utf8'));
  assert.equal(await publishUrl(second,files,async()=>false),false);
  assert.deepEqual(files.map(file=>fs.readFileSync(file,'utf8')),saved);
  let checked=false;
  assert.equal(await publishUrl('http://second.lhr.life/',files,async()=>{checked=true;return true;}),false);
  assert.equal(checked,false);
  assert.equal(await publishUrl(second,files,async()=>true),true);
  for (const file of files) assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{Telegram:{MiniAppUrl:second}});
});
