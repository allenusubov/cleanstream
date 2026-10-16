Clean Stream v0.23.0

Live events and aggregator streams, played on the viewer or TV when the provider supports direct playback.

The GSC feed reader handles the provider’s current event list, its public k1 wire format, exact ESPN IDs, participant/time matching, published embed routes, and events awaiting stream URLs. Saved old player links are not reused as a new event’s ID. Other sites exposing this same feed can be detected from their page.

Provider players are clearly labelled and sandboxed without popup/top-navigation permission. Providers observed to require their own origin or removal of popup protection are labelled OPEN ORIGINAL SITE instead; opening those links requires the user’s explicit click and never happens automatically during extraction. Native media extraction for these providers is still attempted, so this is not a permanent direct-playback blacklist. They use their own controls; Clean Stream’s custom Cast/AirPlay and LIVE controls apply to direct media only. An iframe loading is never recorded as verified video playback. Explicit embedding restrictions are respected. Reading a feed does not guarantee that every provider permits playback or embedding from this origin.

WATCH tries the event’s alternative media and stream pages before retrying a failed provider. Recently failed media is lowered in device selection. Provider check results distinguish no matching event, incomplete checks and streams not posted yet.

- Source discovery starts only from explicit CHECK SOURCES, CHECK MORE, CHECK MIRRORS, RECHECK, WATCH, PLAY, or REFRESH actions. Browsing events and playback interruptions do not start discovery. Event/schedule metadata may still refresh.
- Event pages expose their player frames and event-specific source rows to a bounded concurrent walker. Paste-link playback consumes candidates as they arrive, tries another candidate after startup failure, and cancels inspection after advancing playback. Browser errors are separate from device playback failures.
- Event rows keep one main action; additional checks are in the compact options menu beside WATCH. Status labels wrap without overlapping.
- Four-provider batches use actual browser/receiver playback history. Repeated playback failures lower priority temporarily, without excluding providers.
- Saved current-event/category routes precede homepage exploration. Structured event data, contextual Watch links, signed URLs, and extensionless HLS playlists are supported.
- Three seconds of advancing video records playback evidence. Finding or downloading media on the server does not prove device or Cast compatibility.
- Website inspection has separate partial/incomplete statuses, preserves saved routes, and checks known category routes even when the homepage fails.
- Chrome prefers hls.js. Safari/iOS prefers native playback, with hls.js fallback when available.
- Custom source selection, bulk deletion and undo, stream-only refresh, jump to live, AirPlay/Cast, and event metadata remain.

Playback history stays in this browser and is sent with explicit checks for ranking. No paid APIs or new services were added. Video is not relayed through Cloud Run. Source restrictions can still prevent direct playback; hosting free-tier limits do not guarantee zero charges.
