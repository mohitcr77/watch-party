// Servers that help the two browsers find a direct path to each other.
// STUN is free and works for most home networks. If a friend sees
// "connection failed" (strict mobile or office networks), add a TURN relay here,
// e.g. from Cloudflare Realtime TURN or Metered Open Relay:
//   { urls: 'turn:turn.example.com:3478', username: '...', credential: '...' }
export const ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
