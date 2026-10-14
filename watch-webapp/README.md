# Clean Stream v0.21.0

Live events and aggregator streams, played directly on the viewer or TV.

- Source discovery starts only from explicit CHECK SOURCES, CHECK MORE, CHECK MIRRORS, RECHECK, WATCH, PLAY, or REFRESH actions. Browsing events and playback interruptions do not start discovery. Event/schedule metadata may still refresh.
- Four-provider batches use actual browser/receiver playback history. Repeated playback failures lower priority temporarily, without excluding providers.
- Saved current-event/category routes precede homepage exploration. Structured event data, contextual Watch links, signed URLs, and extensionless HLS playlists are supported.
- Three seconds of advancing video records playback evidence. Finding or downloading media on the server does not prove device or Cast compatibility.
- Website inspection has separate partial/incomplete statuses, preserves saved routes, and checks known category routes even when the homepage fails.
- Chrome prefers hls.js. Safari/iOS prefers native playback, with hls.js fallback when available.
- Custom source selection, bulk deletion and undo, stream-only refresh, jump to live, AirPlay/Cast, and event metadata remain.

Playback history stays in this browser and is sent with explicit checks for ranking. No paid APIs or new services were added. Video is not relayed through Cloud Run. Source restrictions can still prevent direct playback; hosting free-tier limits do not guarantee zero charges.
