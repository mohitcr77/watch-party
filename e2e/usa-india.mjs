import puppeteer from 'puppeteer-core';
import { Link, makeProxy, PAGE_HOOK, FAKE_SCREEN } from './link.mjs';

const BASE = process.env.BASE || 'http://localhost:8080/';
const MOVIE = new URL('./movie.webm', import.meta.url).pathname;
const PHASE_SECONDS = Number(process.env.PHASE_SECONDS || 30);
const only = process.env.ONLY;

const SCENARIOS = [
  { name: 'Good (US fiber, wired)', tries: [10, 15], up: 40, oneWay: 115, jitter: 8, loss: 0.001 },
  { name: 'Typical (US cable, Wi-Fi)', tries: [4, 6], up: 15, oneWay: 130, jitter: 20, loss: 0.005 },
  { name: 'Rough (slow upload, congested route)', tries: [2, 4], up: 8, oneWay: 150, jitter: 40, loss: 0.015 },
].filter((s) => !only || s.name.startsWith(only));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const launch = () => puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function senderSample(a) {
  return a.evaluate(async () => {
    const pc = [...window.__wp().pcs.values()][0];
    if (!pc) return null;
    const r = await pc.getStats();
    let out, pair;
    r.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') out = s; });
    r.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = r.get(s.selectedCandidatePairId); });
    return out && { w: out.frameWidth, h: out.frameHeight, fps: out.framesPerSecond ?? 0, bytes: out.bytesSent, ts: out.timestamp,
      limit: out.qualityLimitationReason, avail: pair?.availableOutgoingBitrate ?? 0, rtt: pair?.currentRoundTripTime ?? 0 };
  });
}

async function viewerSample(b) {
  return b.evaluate(async () => {
    const pc = [...window.__wp().pcs.values()][0];
    if (!pc) return null;
    const r = await pc.getStats();
    let v;
    r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') v = s; });
    return v && { w: v.frameWidth, h: v.frameHeight, fps: v.framesPerSecond ?? 0, freezes: v.freezeCount ?? 0, frozen: v.totalFreezesDuration ?? 0,
      lost: v.packetsLost ?? 0, recv: v.packetsReceived ?? 0, jb: v.jitterBufferEmittedCount ? (v.jitterBufferDelay / v.jitterBufferEmittedCount) * 1000 : 0 };
  });
}

async function measure(a, b, seconds) {
  const rows = [];
  let prev = null;
  const v0 = await viewerSample(b);
  for (let t = 0; t < seconds; t += 2) {
    await sleep(2000);
    const s = await senderSample(a);
    const v = await viewerSample(b);
    if (!s || !v) continue;
    const mbps = prev && s.ts > prev.ts ? ((s.bytes - prev.bytes) * 8) / ((s.ts - prev.ts) / 1000) / 1e6 : 0;
    prev = s;
    rows.push({ ...s, mbps, view: v });
  }
  const steady = rows.slice(Math.floor(rows.length / 2));
  const v1 = rows.at(-1)?.view;
  return {
    resolution: `${median(steady.map((r) => r.view.w))}×${median(steady.map((r) => r.view.h))}`,
    viewerFps: median(steady.map((r) => r.view.fps)).toFixed(0),
    sentMbps: median(steady.map((r) => r.mbps)).toFixed(1),
    estimateMbps: (median(steady.map((r) => r.avail)) / 1e6).toFixed(1),
    rttMs: (median(steady.map((r) => r.rtt)) * 1000).toFixed(0),
    limitedBy: median(steady.map((r) => (r.limit === 'bandwidth' ? 1 : 0))) ? 'bandwidth' : steady.at(-1)?.limit ?? '?',
    freezes: v1 && v0 ? v1.freezes - v0.freezes : '?',
    frozenSec: v1 && v0 ? (v1.frozen - v0.frozen).toFixed(1) : '?',
    jitterBufferMs: median(steady.map((r) => r.view.jb)).toFixed(0),
    timeline: rows.map((r) => `${r.view.w}p${r.view.h}@${Math.round(r.view.fps)}/${r.mbps.toFixed(1)}M`).join(' '),
  };
}

async function runScenario(sc) {
  const aToB = new Link({ mbps: sc.up, delayMs: sc.oneWay, jitterMs: sc.jitter, loss: sc.loss });
  const bToA = new Link({ mbps: 50, delayMs: sc.oneWay, jitterMs: sc.jitter, loss: sc.loss });
  const proxies = [];
  const [ba, bb] = await Promise.all([launch(), launch()]);
  const result = { scenario: sc.name };
  try {
    const [a, b] = await Promise.all([ba.newPage(), bb.newPage()]);
    for (const [p, fwd, rev] of [[a, aToB, bToA], [b, bToA, aToB]]) {
      await p.exposeFunction('__allocProxy', async (ip, port) => {
        const px = await makeProxy(ip, port, fwd, rev);
        proxies.push(px);
        return px.port;
      });
      await p.evaluateOnNewDocument(PAGE_HOOK);
    }
    await a.evaluateOnNewDocument(FAKE_SCREEN);
    const url = `${BASE}?room=L${Date.now().toString(36).slice(-6).toUpperCase()}`;
    for (const [p, name] of [[a, 'US'], [b, 'India']]) {
      await p.goto(url);
      await p.type('#nameInput', name);
      await p.click('#joinBtn');
    }
    for (const p of [a, b]) await p.waitForFunction(() => document.querySelector('#connStatus').textContent.startsWith('Connected to'), { timeout: 60000 });

    await a.click('#shareBtn');
    await b.waitForFunction(() => { const v = document.querySelector('#shareVideo'); return v.srcObject && v.videoWidth > 0; }, { timeout: 30000 });
    result.adaptive = await measure(a, b, PHASE_SECONDS);

    for (const min of sc.tries) {
      await a.evaluate((min, max) => {
        const sl = document.querySelector('#bitrateInput'); sl.value = max; sl.dispatchEvent(new Event('change'));
        const m = document.querySelector('#minSelect'); m.value = min; m.dispatchEvent(new Event('change'));
      }, String(min), String(Math.round(min * 1.5)));
      await sleep(2000);
      result[`guaranteed${min}`] = await measure(a, b, PHASE_SECONDS);
    }

    await a.click('#shareBtn');
    for (const p of [a, b]) {
      await p.click('.tab[data-mode=file]');
      await (await p.$('#fileInput')).uploadFile(MOVIE);
      await p.waitForFunction(() => document.querySelector('#fileVideo').readyState >= 1);
      await sleep(1500);
    }
    await a.evaluate(() => document.querySelector('#fileVideo').play());
    await sleep(4000);
    const [ta, tb] = await Promise.all([a.$eval('#fileVideo', (v) => v.currentTime), b.$eval('#fileVideo', (v) => v.currentTime)]);
    result.fileSyncGapMs = Math.round(Math.abs(ta - tb) * 1000);
    result.linkDrops = { usToIndia: aToB.dropped, indiaToUs: bToA.dropped };
  } catch (e) {
    result.error = e.message;
  } finally {
    await ba.close(); await bb.close();
    proxies.forEach((p) => p.close());
  }
  return result;
}

for (const sc of SCENARIOS) {
  const r = await runScenario(sc);
  console.log(JSON.stringify(r, null, 2));
}
process.exit(0);
