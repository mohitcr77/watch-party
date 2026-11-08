import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
const URL = (process.env.BASE || 'http://localhost:8080/') + '?room=T' + Date.now().toString(36).slice(-6).toUpperCase();
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok:', m); };
const launch = () => puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
});
const [ba, bb] = await Promise.all([launch(), launch()]);
const [a, b] = await Promise.all([ba.newPage(), bb.newPage()]);
for (const [p, n] of [[a, 'A'], [b, 'B']]) p.on('pageerror', (e) => console.log(n, 'pageerror', e.message));
async function joinAs(p, name) {
  await p.goto(URL);
  await p.type('#nameInput', name);
  await p.click('#joinBtn');
  
}
await joinAs(a, 'Alice'); await joinAs(b, 'Bob'); const t0=Date.now();
for (const p of [a,b]) await p.waitForFunction(() => document.querySelector('#connStatus').textContent.startsWith('Connected to'), { timeout: 60000 });
console.log('peers found each other in', Date.now()-t0, 'ms');
await b.waitForFunction(() => document.querySelectorAll('#peopleList li').length === 2);
assert(true, 'both joined, roster shows 2');

await a.type('#chatInput', 'hello'); await a.keyboard.press('Enter');
await b.waitForFunction(() => document.querySelector('#chatLog').textContent.includes('Alice: hello'), { timeout: 5000 });
assert(true, 'chat delivered');

await a.click('#shareBtn');
for (const [p,n] of [[a,'A'],[b,'B']]) p.on('console', (m) => console.log(n, m.type(), m.text()));
try { await b.waitForFunction(() => { const v = document.querySelector('#shareVideo'); return v.srcObject && v.videoWidth > 0; }, { timeout: 30000 }); }
catch (e) { for (const [p,n] of [[a,'A'],[b,'B']]) console.log(n, await p.$eval('#chatLog', (x) => x.innerText), await p.evaluate(() => { const v=document.querySelector('#shareVideo'); return {src: !!v.srcObject, w: v.videoWidth, rs: v.readyState, tracks: v.srcObject?.getTracks().map(t=>t.kind+':'+t.readyState+':'+t.muted)}; })); await ba.close(); await bb.close(); process.exit(1); }
const dims = await b.evaluate(() => [document.querySelector('#shareVideo').videoWidth, document.querySelector('#shareVideo').videoHeight]);
assert(dims[0] > 0, `viewer receives video ${dims.join('x')}`);
await new Promise((r) => setTimeout(r, 4000));
console.log('viewer stats:\n' + await b.$eval('#stats', (e) => e.textContent));
console.log('sharer stats:\n' + await a.$eval('#stats', (e) => e.textContent));
const jb = await b.evaluate(() => [...window.__wp().pcs.values()][0].getReceivers().map((r) => r.jitterBufferTarget));
assert(jb.length && jb.every((v) => v === 1000), `viewer buffer is 1s on all receivers (${jb})`);
await a.select('#minSelect', '4');
await a.waitForFunction(() => [...window.__wp().pcs.values()].some((pc) => pc.remoteDescription?.sdp.includes('x-google-min-bitrate=4000')), { timeout: 20000 });
assert(true, 'guaranteed 4 Mbps reached the negotiated answer');
await b.waitForFunction(() => { const v = document.querySelector('#shareVideo'); return v.srcObject && v.videoWidth > 0; }, { timeout: 20000 });
assert(true, 'video keeps playing after renegotiating guaranteed bitrate');

await a.click('#shareBtn');
await b.waitForFunction(() => document.querySelector('#chatLog').textContent.includes('stopped sharing'), { timeout: 5000 });
assert(true, 'stop sharing propagated');

// File sync: generate a 20s webm in-page, give both peers the same file.
const b64 = await a.evaluate(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
  const ctx = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(); const t0 = performance.now();
  await new Promise((res) => { (function draw() { const t = performance.now() - t0; ctx.fillStyle = `hsl(${t / 20},80%,50%)`; ctx.fillRect(0, 0, 320, 180); if (t < 12000) setTimeout(draw, 33); else { rec.onstop = res; rec.stop(); } })(); });
  const buf = await new Blob(chunks).arrayBuffer();
  let s = ''; new Uint8Array(buf).forEach((x) => (s += String.fromCharCode(x))); return btoa(s);
});
const file = process.argv[2] + '/movie.webm'; writeFileSync(file, Buffer.from(b64, 'base64'));
for (const p of [a, b]) { await p.click('.tab[data-mode=file]'); }
await (await a.$('#fileInput')).uploadFile(file);
await b.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('movie.webm'), { timeout: 5000 });
await (await b.$('#fileInput')).uploadFile(file);
await b.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('matches'));
assert(true, 'room file announced and matched');
// webm from MediaRecorder lacks duration; seeking needs it, so force-load index.
for (const p of [a, b]) await p.waitForFunction(() => document.querySelector('#fileVideo').readyState >= 1);
await a.evaluate(() => document.querySelector('#fileVideo').play());
await new Promise((r) => setTimeout(r, 3000));
const [ta, tb, pb] = await Promise.all([a.$eval('#fileVideo', (v) => v.currentTime), b.$eval('#fileVideo', (v) => v.currentTime), b.$eval('#fileVideo', (v) => v.paused)]);
assert(!pb && Math.abs(ta - tb) < 0.5, `B follows A's play (A=${ta.toFixed(2)} B=${tb.toFixed(2)})`);
await b.evaluate(() => document.querySelector('#fileVideo').pause());
await new Promise((r) => setTimeout(r, 1000));
assert(await a.$eval('#fileVideo', (v) => v.paused), 'A follows B pause');
await b.evaluate(() => { document.querySelector('#fileVideo').currentTime = 2; });
await new Promise((r) => setTimeout(r, 1500));
const ta2 = await a.$eval('#fileVideo', (v) => v.currentTime);
assert(Math.abs(ta2 - 2) < 0.4, `A follows B seek to 2s (A=${ta2.toFixed(2)})`);
await ba.close(); await bb.close();
console.log('ALL PASSED');
