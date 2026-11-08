import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm';
import { ICE_SERVERS } from './config.js';

const $ = (id) => document.getElementById(id);
const APP_ID = 'watch-party-mohitcr77-v1';
window.__wp = () => state; // debugging hook for the console and e2e tests

const state = {
  me: selfId,
  name: 'Guest',
  room: null,
  roomCode: null,
  action: null,
  peers: new Map(), // id -> { name, rtt }
  sharer: null,
  pcs: new Map(), // media connections, separate from Trystero's data connections
  speed: new Map(), // id -> speed-test data channel on the media connection
  localStream: null,
  rev: 0, // logical clock: the newest file/playback change wins
  roomFile: null,
  playback: { playing: false, position: 0, at: Date.now() },
  localFile: null,
  programmaticSeek: false,
  mode: 'share',
};

const send = (msg, target) => state.action?.send(msg, target ? { target } : undefined);
const nameOf = (id) => state.peers.get(id)?.name ?? 'Your friend';
const newer = (rev, from) => rev > state.rev || (rev === state.rev && from > state.me);

// ---------- lobby ----------

const params = new URLSearchParams(location.search);
$('roomInput').value = params.get('room') ?? '';
$('nameInput').value = storageGet('wp-name') ?? '';

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

$('joinBtn').addEventListener('click', join);
for (const id of ['nameInput', 'roomInput']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && join());

function join() {
  state.name = $('nameInput').value.trim() || 'Guest';
  const code = ($('roomInput').value.trim() || Math.random().toString(36).slice(2, 8)).toUpperCase();
  storageSet('wp-name', state.name);
  history.replaceState(null, '', `?room=${code}`);
  state.roomCode = code;
  state.peers.set(state.me, { name: state.name, rtt: 0 });

  $('lobby').hidden = true;
  $('app').hidden = false;
  $('roomCode').textContent = code;
  setStatus('Waiting for your friend to join…', false);
  renderPeople();
  renderShareUi();
  renderFileInfo();

  const room = joinRoom({ appId: APP_ID, password: code, rtcConfig: { iceServers: ICE_SERVERS } }, code);
  state.room = room;
  state.action = room.makeAction('msg');
  state.action.onMessage = (msg, meta) => onMessage(msg, typeof meta === 'string' ? meta : meta.peerId);
  room.onPeerJoin = (id) => {
    state.peers.set(id, { name: 'Connecting…', rtt: 0 });
    send(hello(), id);
    ping(id);
    renderPeople();
  };
  room.onPeerLeave = (id) => {
    sys(`${nameOf(id)} left`);
    state.peers.delete(id);
    closePc(id);
    if (state.sharer === id) onSharer(null);
    renderPeople();
  };
  window.addEventListener('beforeunload', () => room.leave());
  setInterval(() => { for (const id of state.peers.keys()) if (id !== state.me) ping(id); }, 15_000);
}

function hello() {
  return {
    type: 'hello',
    name: state.name,
    sharing: !!state.localStream,
    file: state.roomFile,
    playback: { playing: state.playback.playing, position: expectedPosition() },
    rev: state.rev,
  };
}

function ping(id) { send({ type: 'ping', t: Date.now() }, id); }

// ---------- messages ----------

function onMessage(msg, from) {
  switch (msg.type) {
    case 'hello': {
      const prevName = state.peers.get(from)?.name;
      const known = prevName && prevName !== 'Connecting…';
      state.peers.set(from, { ...state.peers.get(from), name: String(msg.name).slice(0, 24) });
      if (!known) sys(`${nameOf(from)} joined`);
      setStatus(`Connected to ${nameOf(from)}`, true);
      if (msg.file && newer(msg.rev, from)) {
        state.rev = msg.rev;
        state.roomFile = msg.file;
        adoptPlayback(msg.playback, from);
        sys(`Room video is "${msg.file.name}". Pick the same file in Synced file.`);
        if (!state.sharer) setMode('file');
      }
      if (msg.sharing && state.sharer !== from) onSharer(from);
      if (state.localStream) connectViewer(from);
      renderPeople();
      renderFileInfo();
      break;
    }
    case 'ping': send({ type: 'pong', t: msg.t }, from); break;
    case 'pong': {
      const p = state.peers.get(from);
      if (p) p.rtt = Date.now() - msg.t;
      break;
    }
    case 'chat': chat(nameOf(from), String(msg.text).slice(0, 1000)); break;
    case 'share': onSharer(msg.on ? from : state.sharer === from ? null : state.sharer); break;
    case 'signal': onSignal(from, msg.data); break;
    case 'file':
      if (!newer(msg.rev, from)) break;
      state.rev = msg.rev;
      state.roomFile = msg.file;
      state.playback = { playing: false, position: 0, at: Date.now() };
      sys(`${nameOf(from)} set the room video to "${msg.file.name}"`);
      renderFileInfo();
      if (!state.sharer) setMode('file');
      applyRemotePlayback();
      break;
    case 'playback':
      if (!newer(msg.rev, from)) break;
      state.rev = msg.rev;
      adoptPlayback(msg, from);
      applyRemotePlayback();
      break;
  }
}

// Positions arrive about half a round trip late, so shift them forward by that much.
function adoptPlayback({ playing, position }, from) {
  const oneWay = (state.peers.get(from)?.rtt ?? 0) / 2;
  state.playback = { playing: !!playing, position: Number(position) || 0, at: Date.now() - oneWay };
}

// ---------- screen share: sharer side ----------

const VIDEO_PRIORITY = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];

function quality() {
  const res = $('resSelect').value;
  const dpr = window.devicePixelRatio || 1;
  const [w, h] = res === 'native'
    ? [Math.round(screen.width * dpr), Math.round(screen.height * dpr)]
    : [Math.round((Number(res) * 16) / 9), Number(res)];
  return {
    width: w,
    height: h,
    fps: Number($('fpsSelect').value),
    codec: $('codecSelect').value,
    hint: $('hintSelect').value,
    mbps: Number($('bitrateInput').value),
    minMbps: Number($('minSelect').value),
  };
}

async function startShare() {
  const q = quality();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') sys(`Could not start sharing: ${err.message}`);
    return;
  }
  const [video] = stream.getVideoTracks();
  video.contentHint = q.hint;
  video.addEventListener('ended', stopShare);

  state.localStream = stream;
  state.sharer = state.me;
  send({ type: 'share', on: true });

  const vid = $('shareVideo');
  vid.srcObject = stream;
  vid.muted = true;
  vid.play().catch(() => {});

  if (!stream.getAudioTracks().length) sys('Sharing without audio. To include sound, share a browser tab and keep "Share tab audio" ticked.');
  const s = video.getSettings();
  sys(`Capturing at ${s.width}×${s.height} @ ${Math.round(s.frameRate ?? q.fps)} fps`);

  for (const id of state.peers.keys()) if (id !== state.me) connectViewer(id);
  renderShareUi();
  renderPeople();
}

function stopShare() {
  if (!state.localStream) return;
  state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  for (const id of [...state.pcs.keys()]) closePc(id);
  if (state.sharer === state.me) {
    send({ type: 'share', on: false });
    state.sharer = null;
  }
  $('shareVideo').srcObject = null;
  renderShareUi();
  renderPeople();
}

function sortCodecs(kind, preferred) {
  const codecs = RTCRtpReceiver.getCapabilities(kind)?.codecs ?? [];
  const rank = (c) => {
    if (c.mimeType === preferred) {
      // Prefer H.264 High profile (64xxxx) over Baseline/Main.
      return /profile-level-id=64/.test(c.sdpFmtpLine ?? '') ? -2 : -1;
    }
    const i = VIDEO_PRIORITY.indexOf(c.mimeType);
    return i === -1 ? 100 : i;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}

async function connectViewer(id) {
  closePc(id);
  const q = quality();
  const pc = createPc(id);
  state.speed.set(id, speedChannel(pc, id));

  for (const track of state.localStream.getTracks()) {
    const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [state.localStream] });
    if (track.kind === 'video') {
      try { tx.setCodecPreferences(sortCodecs('video', q.codec)); } catch (e) { console.warn('codec prefs', e); }
    }
  }

  const offer = await pc.createOffer();
  offer.sdp = tuneSdp(offer.sdp, q.mbps, q.minMbps);
  await pc.setLocalDescription(offer);
  send({ type: 'signal', data: { sdp: pc.localDescription.toJSON(), mbps: q.mbps, minMbps: q.minMbps } }, id);
}

async function applySenderParams(pc) {
  const q = quality();
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    const enc = p.encodings[0];
    if (sender.track.kind === 'video') {
      enc.maxBitrate = q.mbps * 1_000_000;
      enc.maxFramerate = q.fps;
      enc.scaleResolutionDownBy = 1;
      enc.priority = 'high';
      enc.networkPriority = 'high';
      p.degradationPreference = q.hint === 'detail' ? 'maintain-resolution' : 'balanced';
    } else {
      enc.maxBitrate = 320_000;
      enc.priority = 'high';
    }
    try { await sender.setParameters(p); } catch (e) { console.warn('setParameters', e); }
  }
}

// Opus: stereo + high bitrate. Video: lift Chrome's default bitrate ceiling.
// Chrome reads these from the remote description, so the viewer's answer is what governs the sharer.
// Start low and let Chrome probe upward: a high start floods long-distance links and the
// bandwidth estimate collapses to its floor.
function tuneSdp(sdp, mbps, minMbps = 0) {
  const kbps = mbps * 1000;
  const minKbps = Math.min(minMbps, mbps) * 1000;
  const lines = sdp.split('\r\n');
  const rtpmap = new Map();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (m) rtpmap.set(m[1], m[2].toLowerCase());
  }
  const videoExtra = `x-google-start-bitrate=${Math.max(1500, minKbps)};x-google-max-bitrate=${kbps}` + (minKbps ? `;x-google-min-bitrate=${minKbps}` : '');
  const audioExtra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=510000;useinbandfec=1';
  const hasFmtp = new Set();
  const out = lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m) return l;
    hasFmtp.add(m[1]);
    const codec = rtpmap.get(m[1]);
    if (codec === 'opus') return `a=fmtp:${m[1]} ${mergeFmtp(m[2], audioExtra)}`;
    if (['h264', 'vp9', 'av1', 'vp8'].includes(codec)) return `a=fmtp:${m[1]} ${mergeFmtp(m[2], videoExtra)}`;
    return l;
  });
  const result = [];
  for (const l of out) {
    result.push(l);
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (m && !hasFmtp.has(m[1]) && ['vp8', 'vp9', 'av1'].includes(m[2].toLowerCase())) {
      result.push(`a=fmtp:${m[1]} ${videoExtra}`);
    }
  }
  return result.join('\r\n');
}

function mergeFmtp(existing, extra) {
  const map = new Map(existing.split(';').filter(Boolean).map((kv) => kv.split('=')));
  for (const kv of extra.split(';')) {
    const [k, v] = kv.split('=');
    map.set(k, v);
  }
  return [...map].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
}

// ---------- screen share: shared ----------

function createPc(id) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
  pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', data: { candidate: e.candidate.toJSON() } }, id);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      sys(`Video connection with ${nameOf(id)} failed. One of your networks probably needs a TURN relay (see README).`);
    }
  };
  state.pcs.set(id, pc);
  return pc;
}

function closePc(id) {
  state.speed.delete(id);
  state.pcs.get(id)?.close();
  state.pcs.delete(id);
}

async function onSignal(from, data) {
  if (data.sdp?.type === 'offer') {
    closePc(from);
    const pc = createPc(from);
    speedChannel(pc, from);
    pc.ontrack = (e) => {
      const vid = $('shareVideo');
      if (vid.srcObject !== e.streams[0]) {
        vid.srcObject = e.streams[0];
        vid.muted = false;
        vid.play().catch(() => {
          vid.muted = true;
          vid.play();
          $('unmuteBtn').hidden = false;
        });
      }
      renderShareUi();
    };
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    answer.sdp = tuneSdp(answer.sdp, Number(data.mbps) || 30, Number(data.minMbps) || 0);
    await pc.setLocalDescription(answer);
    send({ type: 'signal', data: { sdp: pc.localDescription.toJSON() } }, from);
  } else if (data.sdp?.type === 'answer') {
    const pc = state.pcs.get(from);
    if (!pc) return;
    await pc.setRemoteDescription(data.sdp);
    await applySenderParams(pc);
  } else if (data.candidate) {
    try { await state.pcs.get(from)?.addIceCandidate(data.candidate); } catch (e) { console.warn('ice', e); }
  }
}

function onSharer(id) {
  const prev = state.sharer;
  if (prev === id) return;
  state.sharer = id;
  if (state.localStream && id !== state.me) {
    sys(`${nameOf(id)} took over sharing`);
    stopShare();
    state.sharer = id;
  }
  if (prev && prev !== state.me) {
    closePc(prev);
    $('shareVideo').srcObject = null;
  }
  if (id && id !== state.me) {
    sys(`${nameOf(id)} started sharing`);
    setMode('share');
  } else if (!id && prev && prev !== state.me) {
    sys(`${nameOf(prev)} stopped sharing`);
  }
  renderShareUi();
  renderPeople();
}

// Live quality changes apply without renegotiating (codec changes need a restart).
for (const id of ['bitrateInput', 'fpsSelect', 'hintSelect', 'resSelect']) {
  $(id).addEventListener('change', async () => {
    renderUploadHint();
    if (!state.localStream) return;
    const q = quality();
    const [video] = state.localStream.getVideoTracks();
    video.contentHint = q.hint;
    try {
      await video.applyConstraints({
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      });
    } catch (e) { console.warn('applyConstraints', e); }
    for (const pc of state.pcs.values()) applySenderParams(pc);
  });
}
$('bitrateInput').addEventListener('input', renderUploadHint);
// The minimum lives in the SDP, so changing it means reconnecting the video.
$('minSelect').addEventListener('change', () => {
  if (!state.localStream) return;
  const q = quality();
  sys(q.minMbps ? `Guaranteeing ${q.minMbps} Mbps. If video freezes or stutters, lower it.` : 'Guaranteed bitrate off. Chrome adapts on its own.');
  for (const id of [...state.pcs.keys()]) connectViewer(id);
});
$('speedBtn').addEventListener('click', runSpeedTest);
$('codecSelect').addEventListener('change', () => state.localStream && sys('Codec change applies the next time you start sharing.'));
$('shareBtn').addEventListener('click', () => (state.localStream ? stopShare() : startShare()));
$('unmuteBtn').addEventListener('click', () => {
  $('shareVideo').muted = false;
  $('unmuteBtn').hidden = true;
});

// ---------- speed test ----------
// Floods a data channel on the same path as the video for a few seconds. It measures what the
// link can carry, independent of Chrome's video bandwidth estimate.

const SPEED_SECONDS = 6;

function speedChannel(pc, id) {
  const dc = pc.createDataChannel('speed', { negotiated: true, id: 0 });
  dc.binaryType = 'arraybuffer';
  let bytes = 0, first = 0, last = 0;
  dc.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      const now = performance.now();
      if (!first) first = now;
      last = now;
      bytes += e.data.byteLength;
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.type === 'start') { bytes = 0; first = 0; last = 0; }
    if (msg.type === 'end') {
      const mbps = last > first ? (bytes * 8) / ((last - first) / 1000) / 1e6 : 0;
      dc.send(JSON.stringify({ type: 'result', mbps }));
      sys(`Speed test: ${nameOf(id)} can send you about ${mbps.toFixed(1)} Mbps.`);
    }
    if (msg.type === 'result') reportSpeed(id, msg.mbps);
  };
  return dc;
}

async function runSpeedTest() {
  const targets = [...state.speed].filter(([, dc]) => dc.readyState === 'open');
  if (!targets.length) return sys('Start sharing first, then run the speed test.');
  $('speedBtn').disabled = true;
  $('speedBtn').textContent = 'Testing…';
  sys(`Testing for ${SPEED_SECONDS} seconds. Video may stutter briefly.`);
  const chunk = new Uint8Array(64 * 1024);
  await Promise.all(targets.map(async ([, dc]) => {
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.send(JSON.stringify({ type: 'start' }));
    const end = performance.now() + SPEED_SECONDS * 1000;
    while (performance.now() < end && dc.readyState === 'open') {
      while (dc.bufferedAmount < 8 << 20 && performance.now() < end) dc.send(chunk);
      await new Promise((r) => { dc.onbufferedamountlow = r; setTimeout(r, 200); });
    }
    if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'end' }));
  }));
  $('speedBtn').disabled = false;
  $('speedBtn').textContent = 'Test connection speed';
}

function reportSpeed(id, mbps) {
  const safe = [30, 20, 15, 10, 6, 4, 2].find((m) => m <= mbps * 0.7) ?? 0;
  sys(`Speed test: you can send ${nameOf(id)} about ${mbps.toFixed(1)} Mbps.` + (safe
    ? ` Try "Guaranteed bitrate" at ${safe} Mbps and max bitrate around ${Math.min(80, Math.max(safe, Math.floor(mbps * 0.8)))} Mbps.`
    : ' That is too slow for good screen share. Use 720p, or Synced file mode.'));
}

// ---------- stats overlay ----------

const prevBytes = new Map();
setInterval(async () => {
  const el = $('stats');
  if (state.mode !== 'share') return (el.hidden = true);
  if (state.localStream) return renderSenderStats(el);
  const pc = state.sharer && state.pcs.get(state.sharer);
  if (!pc) return (el.hidden = true);
  const report = await pc.getStats();
  let v;
  report.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') v = s; });
  if (!v) return (el.hidden = true);
  const codec = v.codecId && report.get(v.codecId)?.mimeType?.replace('video/', '');
  const mbps = bitrate('in', v);
  const pair = selectedPair(report);
  const relayed = pair && report.get(pair.localCandidateId)?.candidateType === 'relay';
  el.textContent = [
    `${v.frameWidth ?? '?'}×${v.frameHeight ?? '?'} @ ${Math.round(v.framesPerSecond ?? 0)} fps`,
    `${codec ?? ''} ${mbps.toFixed(1)} Mbps${v.decoderImplementation ? ` · ${v.decoderImplementation}` : ''}`,
    `lost ${v.packetsLost ?? 0}${pair?.currentRoundTripTime ? ` · rtt ${Math.round(pair.currentRoundTripTime * 1000)} ms` : ''}${relayed ? ' · via TURN' : ''}`,
  ].join('\n');
  el.hidden = false;
}, 1000);

async function renderSenderStats(el) {
  const [settings] = state.localStream.getVideoTracks().map((t) => t.getSettings());
  const lines = [`capture ${settings.width}×${settings.height} @ ${Math.round(settings.frameRate ?? 0)} fps`];
  for (const [id, pc] of state.pcs) {
    const report = await pc.getStats();
    report.forEach((s) => {
      if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
      const codec = s.codecId && report.get(s.codecId)?.mimeType?.replace('video/', '');
      const limit = s.qualityLimitationReason && s.qualityLimitationReason !== 'none' ? ` · limited by ${s.qualityLimitationReason}` : '';
      lines.push(`→ ${nameOf(id)}: ${s.frameWidth ?? '?'}×${s.frameHeight ?? '?'} @ ${Math.round(s.framesPerSecond ?? 0)} · ${codec ?? ''} ${bitrate(id, s).toFixed(1)} Mbps${limit}`);
    });
    const pair = selectedPair(report);
    const remote = [...report.values()].find((s) => s.type === 'remote-inbound-rtp' && s.kind === 'video');
    if (pair) {
      const route = report.get(pair.localCandidateId)?.candidateType === 'relay' ? 'via TURN' : 'direct';
      const avail = pair.availableOutgoingBitrate ? `${(pair.availableOutgoingBitrate / 1e6).toFixed(1)} Mbps` : '?';
      const rtt = pair.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : '?';
      const loss = remote?.fractionLost != null ? ` · loss ${(remote.fractionLost * 100).toFixed(1)}%` : '';
      lines.push(`  network: est. ${avail} available · rtt ${rtt}${loss} · ${route}`);
    }
  }
  el.textContent = lines.join('\n');
  el.hidden = false;
}

function selectedPair(report) {
  const transport = [...report.values()].find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  return transport && report.get(transport.selectedCandidatePairId);
}

function bitrate(key, s) {
  const bytes = s.bytesReceived ?? s.bytesSent ?? 0;
  const prev = prevBytes.get(key);
  prevBytes.set(key, { bytes, ts: s.timestamp });
  if (!prev || s.timestamp <= prev.ts) return 0;
  return ((bytes - prev.bytes) * 8) / ((s.timestamp - prev.ts) / 1000) / 1e6;
}

// ---------- synced file mode ----------

const fileVideo = $('fileVideo');

$('fileInput').addEventListener('change', () => {
  const file = $('fileInput').files[0];
  if (!file) return;
  const matchesRoom = state.roomFile && state.roomFile.name === file.name && state.roomFile.size === file.size;
  if (state.localFile) URL.revokeObjectURL(fileVideo.src);
  state.localFile = file;
  fileVideo.src = URL.createObjectURL(file);
  fileVideo.hidden = false;

  if (!state.roomFile || (!matchesRoom && confirm(`"${file.name}" differs from the room video "${state.roomFile.name}". Make yours the room video for everyone?`))) {
    state.rev += 1;
    state.roomFile = { name: file.name, size: file.size, by: state.name };
    state.playback = { playing: false, position: 0, at: Date.now() };
    send({ type: 'file', file: state.roomFile, rev: state.rev });
  } else {
    fileVideo.addEventListener('loadedmetadata', applyRemotePlayback, { once: true });
  }
  renderFileInfo();
});

function expectedPosition() {
  const { playing, position, at } = state.playback;
  return playing ? position + (Date.now() - at) / 1000 : position;
}

function seekTo(t) {
  state.programmaticSeek = true;
  fileVideo.currentTime = t;
}

function applyRemotePlayback() {
  if (!state.localFile || fileVideo.readyState < 1) return;
  const target = expectedPosition();
  if (Math.abs(fileVideo.currentTime - target) > 0.3) seekTo(target);
  if (state.playback.playing && fileVideo.paused) fileVideo.play().catch(() => sys('Press play once to allow playback in this browser.'));
  if (!state.playback.playing && !fileVideo.paused) fileVideo.pause();
}

function publishPlayback() {
  state.rev += 1;
  state.playback = { playing: !fileVideo.paused, position: fileVideo.currentTime, at: Date.now() };
  send({ type: 'playback', playing: state.playback.playing, position: state.playback.position, rev: state.rev });
}

fileVideo.addEventListener('play', () => { if (!state.playback.playing) publishPlayback(); });
fileVideo.addEventListener('pause', () => { if (state.playback.playing) publishPlayback(); });
fileVideo.addEventListener('seeked', () => {
  if (state.programmaticSeek) { state.programmaticSeek = false; return; }
  publishPlayback();
});

// Drift correction: nudge playbackRate for small drift, hard seek for large drift.
setInterval(() => {
  if (!state.localFile || fileVideo.seeking || fileVideo.readyState < 3) return;
  if (!state.playback.playing) { fileVideo.playbackRate = 1; return; }
  if (fileVideo.paused) return applyRemotePlayback();
  const drift = fileVideo.currentTime - expectedPosition();
  if (Math.abs(drift) > 1) seekTo(expectedPosition());
  else if (Math.abs(drift) > 0.08) fileVideo.playbackRate = 1 - Math.max(-0.1, Math.min(0.1, drift * 0.5));
  else fileVideo.playbackRate = 1;
}, 500);

// ---------- UI ----------

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('sharePanel').hidden = mode !== 'share';
  $('filePanel').hidden = mode !== 'file';
  $('shareVideo').hidden = mode !== 'share';
  $('fileVideo').hidden = mode !== 'file' || !state.localFile;
  if (mode === 'share') fileVideo.pause();
  renderShareUi();
  renderFileInfo();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function renderShareUi() {
  const sharing = !!state.localStream;
  const btn = $('shareBtn');
  btn.textContent = sharing ? 'Stop sharing' : state.sharer ? 'Take over sharing' : 'Start sharing';
  btn.className = sharing ? 'danger' : 'primary';
  $('speedBtn').hidden = !sharing;
  $('codecSelect').disabled = sharing;
  const ph = $('placeholder');
  if (state.mode === 'file') {
    ph.hidden = !!state.localFile;
    ph.textContent = state.roomFile ? `Pick "${state.roomFile.name}" below to join playback.` : 'Pick a video file below to start.';
  } else {
    ph.hidden = sharing || !!$('shareVideo').srcObject;
    ph.textContent = state.sharer ? 'Connecting to stream…' : 'Nobody is sharing yet.';
  }
  renderUploadHint();
}

function renderUploadHint() {
  const q = quality();
  const viewers = Math.max(1, state.peers.size - 1);
  $('bitrateLabel').textContent = `${q.mbps} Mbps`;
  $('uploadHint').textContent = `Target ${q.width}×${q.height} @ ${q.fps}. Needs about ${q.mbps * viewers} Mbps upload for ${viewers} viewer${viewers > 1 ? 's' : ''}.`;
}

function renderFileInfo() {
  const info = $('fileInfo');
  const f = state.roomFile;
  if (!f) info.textContent = 'Pick a video. Your friend picks the same file. Only play, pause and seek are sent, so you each watch at full original quality.';
  else {
    const mine = state.localFile;
    const match = mine && mine.name === f.name && mine.size === f.size;
    info.textContent = `Room video: ${f.name} (${(f.size / 1e9).toFixed(2)} GB, set by ${f.by}).` +
      (mine ? (match ? ' Your file matches.' : ' Your file differs, sync may be off.') : ' Pick the same file to join.');
  }
  if (state.mode === 'file') $('placeholder').hidden = !!state.localFile;
}

function renderPeople() {
  const ul = $('peopleList');
  ul.replaceChildren(...[...state.peers].map(([id, p]) => {
    const li = document.createElement('li');
    li.textContent = p.name + (id === state.me ? ' (you)' : '');
    if (id === state.sharer) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'sharing';
      li.append(b);
    }
    return li;
  }));
  if (state.peers.size < 2 && state.room) setStatus('Waiting for your friend to join…', false);
  renderUploadHint();
}

function setStatus(text, ok) {
  const el = $('connStatus');
  el.textContent = text;
  el.classList.toggle('ok', ok);
}

function appendLog(node) {
  const log = $('chatLog');
  log.append(node);
  log.scrollTop = log.scrollHeight;
}
function sys(text) {
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = text;
  appendLog(d);
}
function chat(name, text) {
  const d = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = name + ': ';
  d.append(b, text);
  appendLog(d);
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (text) {
    send({ type: 'chat', text });
    chat(state.name, text);
  }
  $('chatInput').value = '';
});

$('copyLinkBtn').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${state.roomCode}`;
  try { await navigator.clipboard.writeText(link); sys('Invite link copied'); } catch { prompt('Copy this link', link); }
});

$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen();
});
