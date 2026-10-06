# CLEAN STREAM

Minimal live-event search and direct-playback web app.

## Current behavior

- Use ESPN as the primary multi-sport schedule/event layer for NBA, WNBA, NFL, college football, NHL, MLB, UFC, F1, ATP/WTA tennis, and major soccer competitions; unsupported feeds fail independently instead of blocking the rest.
- Search YouTube Live when `YOUTUBE_API_KEY` is configured.
- Search Twitch live channels when `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are configured.
- Resolve configured event/source pages with Playwright only when needed.
- Keep raw candidates internal; show a source only after the fast playback check succeeds, enable WATCH immediately on the first usable result, and keep finding more usable sources in the background.
- Play accepted media directly from the original source to the viewer. `/api/media` is intentionally disabled; Clean Stream does not relay the full video through Cloud Run.
- Preserve search/player state in the URL so refresh and browser back work normally.
- Multi-event result pages do no automatic source work: CHECK SOURCES or clicking an event title starts that event only. Single-event pages start source discovery automatically.
- Show a spoiler-free one-event-at-a-time homepage ticker backed by the LIVE + next-24-hour schedule. It slides one event at a time, pauses 1.5 seconds, and can be scrolled/dragged/swiped in either direction. Event clicks open an exact-event results page and start discovery automatically; EXPLORE opens a chronological LIVE / UPCOMING view with category filters.
- Preserve custom category routes exactly, including paths, query strings, and hash fragments such as `/#nfl`; TEST-discovered routes merge behind manual routes instead of simplifying them. TEST ALL refreshes enabled source profiles with bounded concurrency. Custom sources can be imported/exported or shared device-to-device with a URL fragment that never goes to the server. `public/default-custom-sources.json` can seed a new device without an account or database. Settings also include homepage event-category priority, category ON/OFF controls, and favorite teams/athletes/fighters.

## Source adapter hierarchy

Configured/authorized sources are discovered with a bounded hierarchy instead of a broad crawl:

1. **Site** — start from the source registry entry.
2. **Category** — follow the matching league/sport navigation (for example NBA, NFL, tennis), or an explicit `categories` mapping when one is configured.
3. **Event** — match only links for the selected event.
4. **Mirrors** — inspect the event page for separate mirror/server/feed links, iframe players, and bounded mirror-tab interactions.

Each distinct working mirror is validated independently and returned as its own source result. Mirrors from the same site intentionally keep the same displayed domain name. Index/category results are cached for two minutes and mirror discovery for one minute so repeated searches do not restart navigation from zero.

Source adapters are general by default: a source is not excluded just because one sport route is known. Custom TEST profiles mark category support as YES/UNKNOWN (and manual profiles may mark a category NO). Known-category sources and historically fast sources are tried first; UNKNOWN sources remain a fallback so missing route discovery never means an event is impossible to find. A source is sport-gated only when its adapter explicitly sets `restrictLeagues: true`. Missing category routes fall back to the source's event-list/root pages.

Optional registry fields for site-specific tuning:

- `categories`: map league/sport names to one or more category URLs.
- `categoryAliases`: extra words used to recognize category links.
- `mirrorSelector`: selector for mirror controls when the default buttons/tabs/links are not enough.
- `mirrorTextPattern`: regular-expression string for mirror labels.
- `maxMirrors`: bounded mirror count (default 10).
- `restrictLeagues`: opt-in sport gating for a deliberately narrow adapter.
- `mirrorSettleMs`: short wait after changing a mirror tab (default 500 ms).

The generic adapter is intended for public or authorized source pages supplied in the registry.

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
