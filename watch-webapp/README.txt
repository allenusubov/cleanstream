# CLEAN STREAM

Minimal live-event search and direct-playback web app.

## Current behavior

- Search NBA schedules and live/upcoming events.
- Search YouTube Live when `YOUTUBE_API_KEY` is configured.
- Search Twitch live channels when `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are configured.
- Resolve configured event/source pages with Playwright only when needed.
- Publish a source after a fast direct-playback check, then continue deeper live-HLS stability verification in the background.
- Play accepted media directly from the original source to the viewer. `/api/media` is intentionally disabled; Clean Stream does not relay the full video through Cloud Run.
- Preserve search/player state in the URL so refresh and browser back work normally.

## Optional search credentials

### YouTube Live
Set:

- `YOUTUBE_API_KEY`

The server uses the official YouTube Data API for live search and the official embedded player for playback.

### Twitch
Register a Twitch developer application and set:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

The secret stays server-side. Clean Stream obtains an app access token and uses Twitch's official live channel search. Playback uses Twitch's official embedded player.

## Deployment

The current production target is Google Cloud Run using the included Dockerfile. The service exposes `/health` for health checks.

Keep request-based billing and minimum instances at zero if minimizing idle compute is important.

## Access model

This project is intended for public or authorized media/pages. It does not bypass DRM, subscriptions, authentication, or other access controls.
