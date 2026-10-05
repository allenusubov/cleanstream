# CLEAN STREAM

Minimal live-event search and direct-playback web app.

## Current behavior

- Use ESPN as the primary multi-sport schedule/event layer for NBA, WNBA, NFL, college football, NHL, MLB, UFC, F1, ATP/WTA tennis, and major soccer competitions; unsupported feeds fail independently instead of blocking the rest.
- Search YouTube Live when `YOUTUBE_API_KEY` is configured.
- Search Twitch live channels when `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are configured.
- Resolve configured event/source pages with Playwright only when needed.
- Publish discovered source/mirror candidates immediately, resolve them in parallel, enable WATCH as soon as the first direct-playback candidate succeeds, and keep deeper HLS checks in the background.
- Play accepted media directly from the original source to the viewer. `/api/media` is intentionally disabled; Clean Stream does not relay the full video through Cloud Run.
- Preserve search/player state in the URL so refresh and browser back work normally.
- Multi-event result pages do no automatic source work: CHECK SOURCES or clicking an event title starts that event only. Single-event pages start source discovery automatically.
- Show a spoiler-free one-event-at-a-time homepage ticker backed by the LIVE + next-24-hour schedule. It slides one event at a time, pauses 1.5 seconds, and can be scrolled/dragged/swiped in either direction. Event clicks open an exact-event results page and start discovery automatically; EXPLORE opens a chronological LIVE / UPCOMING view with category filters.
- Preserve custom category routes exactly, including paths, query strings, and hash fragments such as `/#nfl`; TEST-discovered routes merge behind manual routes instead of simplifying them. Settings also include homepage event-category priority, category ON/OFF controls, and favorite teams/athletes/fighters.
- Treat source adapters as general by default; sport gating must be explicitly opted into.
- Custom source TEST results merge with manual routes instead of overwriting them.
- Custom route editing accepts full URLs or root-relative paths such as `NFL /nfl`.

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
