// Emulates a long-haul internet path between two browsers on one machine.
// Every WebRTC candidate is rewritten to point at a UDP proxy, so all media and data
// cross a shaped link: bottleneck bandwidth with a drop-tail queue, one-way delay,
// jitter (kept FIFO, like a real queue), and random loss.
import dgram from 'node:dgram';

export class Link {
  constructor({ mbps, delayMs, jitterMs, loss, queueMs = 150 }) {
    Object.assign(this, { mbps, delayMs, jitterMs, loss, queueMs });
    this.busyUntil = 0;
    this.lastDeliver = 0;
    this.sent = 0;
    this.dropped = 0;
  }
  push(buf, deliver) {
    const now = performance.now();
    if (Math.random() < this.loss) { this.dropped++; return; }
    const start = Math.max(now, this.busyUntil);
    if (start - now > this.queueMs) { this.dropped++; return; }
    this.busyUntil = start + (buf.length * 8) / (this.mbps * 1e6) * 1000;
    const jitter = (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 1.5) * this.jitterMs;
    const at = Math.max(this.busyUntil + this.delayMs + jitter, this.lastDeliver);
    this.lastDeliver = at;
    this.sent++;
    setTimeout(() => deliver(buf), Math.max(0, at - now));
  }
}

// One proxy per remote candidate: the browser that received the candidate talks to `front`,
// we forward from `back` to the real candidate address and route replies back.
export async function makeProxy(targetIp, targetPort, forward, reverse) {
  const front = dgram.createSocket('udp4');
  const back = dgram.createSocket('udp4');
  let client = null;
  front.on('message', (msg, rinfo) => {
    client = rinfo;
    forward.push(msg, (b) => { try { back.send(b, targetPort, targetIp); } catch {} });
  });
  back.on('message', (msg) => {
    if (client) reverse.push(msg, (b) => { try { front.send(b, client.port, client.address); } catch {} });
  });
  await new Promise((r) => front.bind(0, '127.0.0.1', r));
  await new Promise((r) => back.bind(0, r));
  return { port: front.address().port, close: () => { front.close(); back.close(); } };
}

// Injected into each page before any script runs.
export const PAGE_HOOK = `
(() => {
  const rewrite = async (line) => {
    const p = line.replace(/^a=/, '').split(' ');
    const proto = (p[2] || '').toLowerCase(), ip = p[4], port = +p[5], type = p[7];
    if (proto !== 'udp' || type !== 'host' || ip.includes(':') || ip.endsWith('.local')) return null;
    p[4] = '127.0.0.1';
    p[5] = String(await window.__allocProxy(ip, port));
    return (line.startsWith('a=') ? 'a=' : '') + p.join(' ');
  };
  const P = RTCPeerConnection.prototype;
  const addIce = P.addIceCandidate, setRemote = P.setRemoteDescription;
  P.addIceCandidate = async function (c, ...rest) {
    if (!c || !c.candidate) return addIce.call(this, c, ...rest);
    const init = typeof c.toJSON === 'function' ? c.toJSON() : { ...c };
    const line = await rewrite(init.candidate);
    if (!line) return;
    return addIce.call(this, { ...init, candidate: line }, ...rest);
  };
  P.setRemoteDescription = async function (d, ...rest) {
    if (!d || !d.sdp) return setRemote.call(this, d, ...rest);
    const out = [];
    for (const l of d.sdp.split('\\r\\n')) {
      if (l.startsWith('a=candidate:')) { const r = await rewrite(l); if (r) out.push(r); }
      else out.push(l);
    }
    return setRemote.call(this, { type: d.type, sdp: out.join('\\r\\n') }, ...rest);
  };
})();
`;

// A detailed, moving 1080p "screen" so the encoder needs real bitrate, like a film.
export const FAKE_SCREEN = `
(() => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const W = 1920, H = 1080;
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = c.getContext('2d');
    const tiles = [], grain = [];
    for (let t = 0; t < 4; t++) {
      const tile = ctx.createImageData(256, 256);
      for (let i = 0; i < tile.data.length; i += 4) {
        const v = Math.random() * 255;
        tile.data[i] = v; tile.data[i + 1] = v * 0.8; tile.data[i + 2] = 255 - v; tile.data[i + 3] = 255;
      }
      tiles.push(tile);
      const gc = Object.assign(document.createElement('canvas'), { width: 256, height: 256 }); gc.getContext('2d').putImageData(tile, 0, 0); grain.push(gc);
    }
    let f = 0;
    setInterval(() => {
      f++;
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, 'hsl(' + (f % 360) + ',70%,40%)');
      g.addColorStop(1, 'hsl(' + ((f * 3) % 360) + ',70%,20%)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = 'hsl(' + ((f + i * 60) % 360) + ',60%,55%)';
        ctx.beginPath(); ctx.arc((i * 337 + f * 6) % W, (i * 211 + f * 3) % H, 90 + i * 20, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 0.12;
      for (let y = 0; y < H; y += 256) for (let x = 0; x < W; x += 256) ctx.drawImage(grain[(f + x + y) % 4], x, y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.font = '64px sans-serif';
      ctx.fillText('Frame ' + f + '  subtitles look like this', 120 + (f * 4) % 600, H - 120);
    }, 1000 / 30);
    return c.captureStream(30);
  };
})();
`;
