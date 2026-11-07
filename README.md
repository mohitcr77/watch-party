# Watch Party

A two-person watch party that runs entirely in the browser. There is no server to keep running. It is hosted free on GitHub Pages.

## Modes

- **Screen share.** One person shares a screen, window or tab. It captures at the display's native pixel resolution at up to 60 fps, with stereo audio. You pick the codec (H.264 hardware, AV1 or VP9) and the max bitrate. A live overlay shows the received resolution, fps, bitrate and round-trip time, and says what is limiting quality.
- **Synced file.** You both open the same video file. Only play, pause and seek travel between you, so each of you watches the original file at full quality, whatever the distance. This is the best mode for movies.

## How it connects

1. Both browsers join the room through free public Nostr relays, using [Trystero](https://github.com/dmotz/trystero). The room code also encrypts this handshake.
2. After that, chat, sync and video go directly between the two browsers over WebRTC. Nothing passes through a server.

## Use it

Open the site, enter a name, and click **Join room**. Then click **Copy invite link** and send it to your friend.

To share sound, pick a **Chrome tab** in the share picker and keep "Share tab audio" ticked.

## If you get "connection failed"

Some networks, mostly mobile data and office networks, block direct connections. To fix it, add a TURN relay to `config.js`. [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) has 1,000 GB free per month, and [Metered Open Relay](https://www.metered.ca/stun-turn) has a free tier.

## Run locally

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080.
