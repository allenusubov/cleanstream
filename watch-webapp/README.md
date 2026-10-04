# WATCH

Deployable web version of the clean player prototype.

## What it does

- User pastes a normal webpage URL.
- The backend opens that page in headless Chromium.
- It looks for ordinary HTML5 video sources, MP4/WebM media, and HLS manifests.
- It proxies compatible media back into the minimal WATCH player.
- HLS plays natively in Safari and through Hls.js in Chrome.

It is intended for media/pages you are authorized to access. It does not bypass DRM, subscriptions, authentication, or other access controls.

## Recommended deployment: Render

1. Put this folder in a GitHub repo.
2. In Render, create a **New Web Service**.
3. Connect the repo.
4. Render will detect `render.yaml` / `Dockerfile`.
5. Deploy.
6. Open the generated `onrender.com` URL.

The server exposes `/health` for health checks.

## Railway

This repo also includes `railway.json` and the same Dockerfile.

## Notes

The first request after a cold start can take longer because Chromium has to launch.
Some sites do not expose media until a human clicks their player, or use DRM/session controls. Those pages may return `NO PLAYABLE MEDIA FOUND` in this first version.
