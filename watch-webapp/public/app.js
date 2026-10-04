const $ = selector => document.querySelector(selector);
const homeView = $('[data-view="home"]');
const playerView = $('[data-view="player"]');
const streamInput = $('#stream-url');
const homeMessage = $('#home-message');
const sourceLink = $('#source-link');
const video = $('#video');
const stage = $('.player-stage');
const playerEmpty = $('#player-empty');
const emptyCopy = $('#empty-copy');
const message = $('#player-message');
const playButton = $('#play-button');
const muteButton = $('#mute-button');
const refreshButton = $('#refresh-button');
const liveButton = $('#live-button');
const tvButton = $('#tv-button');

let hls = null;
let candidate = null;
let sourceUrl = '';
let operation = null;
let busy = false;
let localLive = false;
let segmentDuration = 6;
let buffering = true;
let lastProgress = 0;
let lastTime = -1;
let generation = 0;
let castContext = null;
let remotePlayer = null;
let remoteController = null;
let castLoading = false;
let castLoadPromise = null;
let tvMode = null;
let nativeProbeAt = 0;
let nativeProbePending = false;

function showView(name) {
  homeView.classList.toggle('is-active', name === 'home');
  playerView.classList.toggle('is-active', name === 'player');
  homeView.setAttribute('aria-hidden', String(name !== 'home'));
  playerView.setAttribute('aria-hidden', String(name !== 'player'));
}
function say(text = '') { message.textContent = text; }
function placeholder(text) {
  emptyCopy.textContent = text;
  playerEmpty.classList.remove('is-hidden');
}
function castSession() { return castContext?.getCurrentSession() || null; }
function casting() {
  if (!castSession() || !remotePlayer?.isMediaLoaded) return false;
  try {
    const url = new URL(remotePlayer.mediaInfo?.contentId || '');
    return url.origin === location.origin && url.pathname.startsWith('/api/media/');
  } catch { return false; }
}
function setBusy(value) {
  busy = value;
  refreshButton.disabled = value || !sourceUrl;
  refreshButton.textContent = value ? 'LOADING' : 'REFRESH';
  playButton.disabled = value || !candidate;
  syncControls();
}
function destroyLocal() {
  generation++;
  hls?.destroy();
  hls = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.classList.remove('is-visible');
  localLive = false;
  buffering = true;
  lastProgress = 0;
  lastTime = -1;
}
function latestLocalPosition() {
  if (!localLive || !video.seekable.length) return null;
  const start = video.seekable.start(video.seekable.length - 1);
  const end = video.seekable.end(video.seekable.length - 1);
  // Seek to the safe live target, not the final byte at the edge of the buffer.
  const target = Number.isFinite(hls?.liveSyncPosition)
    ? hls.liveSyncPosition : end - Math.max(2, segmentDuration * 2);
  return Math.max(start, Math.min(end - 0.1, target));
}
function remoteLivePosition() {
  const range = remotePlayer?.liveSeekableRange;
  if (!range || range.isLiveDone || !Number.isFinite(range.end)) return null;
  return Math.max(range.start, range.end - Math.max(2, segmentDuration));
}
function syncControls() {
  const onTV = casting();
  const paused = onTV ? remotePlayer.isPaused : video.paused;
  playButton.textContent = paused ? 'PLAY' : 'PAUSE';
  muteButton.textContent = (onTV ? remotePlayer.isMuted : video.muted) ? 'UNMUTE' : 'MUTE';
  const target = onTV ? remoteLivePosition() : latestLocalPosition();
  const position = onTV ? remotePlayer.currentTime : video.currentTime;
  const progressing = onTV
    ? remotePlayer.playerState === 'PLAYING'
    : !buffering && !video.ended && Date.now() - lastProgress < 5000;
  const atLive = target !== null && !paused && progressing && !busy && !castLoading &&
    position >= target - Math.max(2, segmentDuration / 2);
  liveButton.disabled = busy || target === null;
  liveButton.classList.toggle('is-live', atLive);
  liveButton.setAttribute('aria-label', atLive ? 'Playing live' : 'Go to live');
  liveButton.title = target === null ? 'Live position unavailable' : atLive ? 'At the latest available video' : 'Jump to live';
  stage.classList.toggle('is-casting', onTV);
  if (onTV && !busy) placeholder('PLAYING ON TV');
  updateTVButton();
}

async function apiResolve(signal) {
  const response = await fetch('/api/resolve', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({url: sourceUrl}), signal
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`SERVER ERROR ${response.status}. TRY REFRESH.`); }
  if (!response.ok) throw new Error(data.detail || data.error || 'Could not resolve page');
  if (!data.candidates?.length) throw new Error('NO PLAYABLE MEDIA FOUND');
  return data.candidates;
}
async function probeManifest(item, signal, url = item.proxyUrl, depth = 0) {
  if (!item.isHls || depth > 3) return null;
  const response = await fetch(url, {signal, cache: 'no-store'});
  if (!response.ok) throw new Error(`STREAM ERROR ${response.status}`);
  const text = await response.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('INVALID STREAM PLAYLIST');
  if (text.includes('#EXT-X-STREAM-INF:')) {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'));
    const next = lines.slice(index + 1).find(line => line.trim() && !line.startsWith('#'));
    return next ? probeManifest(item, signal, new URL(next.trim(), response.url || new URL(url, location.href)).href, depth + 1) : null;
  }
  return {
    live: !text.includes('#EXT-X-ENDLIST') && !text.includes('#EXT-X-PLAYLIST-TYPE:VOD'),
    duration: Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]) || 6
  };
}
function waitForMedia(signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error('VIDEO COULD NOT LOAD'));
    const cancelled = () => finish(new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) return cancelled();
    video.addEventListener('canplay', ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', cancelled, {once: true});
    timer = setTimeout(() => finish(new Error('STREAM TIMED OUT')), 14000);
  });
}
async function attachLocal(item, signal) {
  destroyLocal();
  const thisGeneration = generation;
  candidate = item;
  stage.classList.remove('is-casting');
  placeholder('LOADING');
  const ready = waitForMedia(signal);
  // Attach rejection handling immediately, even if setup throws synchronously.
  ready.catch(() => {});
  video.classList.add('is-visible');
  if (item.isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
    if (!window.Hls?.isSupported()) throw new Error('HLS IS NOT SUPPORTED IN THIS BROWSER');
    hls = new Hls({enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3});
    hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
      if (generation !== thisGeneration) return;
      localLive = Boolean(data.details.live);
      segmentDuration = data.details.targetduration || 6;
      syncControls();
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (generation !== thisGeneration || !data.fatal) return;
      buffering = true;
      say('STREAM INTERRUPTED — PRESS REFRESH');
      syncControls();
      // Trigger readiness failure so refresh can re-extract the source.
      video.dispatchEvent(new Event('error'));
    });
    hls.loadSource(item.proxyUrl);
    hls.attachMedia(video);
  } else {
    video.src = item.proxyUrl;
    video.load();
    if (item.isHls) {
      probeManifest(item, signal).then(info => {
        if (info && generation === thisGeneration) {
          localLive = info.live; segmentDuration = info.duration; syncControls();
        }
      }).catch(() => {});
    }
  }
  await ready;
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  playerEmpty.classList.add('is-hidden');
  try { await video.play(); say(); }
  catch { say('READY — PRESS PLAY'); }
  syncControls();
}
async function resolveAndPlay(signal, toTV = false) {
  const items = await apiResolve(signal);
  let lastError;
  for (const item of items.slice(0, 3)) {
    try {
      if (toTV && castSession()) {
        candidate = item;
        await loadOnTV(item, signal);
      } else await attachLocal(item, signal);
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('NO PLAYABLE MEDIA FOUND');
}
async function runOperation(task) {
  operation?.abort();
  const controller = new AbortController();
  operation = controller;
  setBusy(true);
  say();
  try { await task(controller.signal); }
  catch (error) {
    if (!controller.signal.aborted) {
      placeholder('TRY REFRESH');
      say(String(error.message || error).toUpperCase());
    }
  } finally {
    if (operation === controller) { operation = null; setBusy(false); }
  }
}
async function openStream() {
  let url;
  try {
    const raw = streamInput.value.trim();
    if (!raw) throw new Error();
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch { homeMessage.textContent = 'ENTER A VALID URL'; streamInput.focus(); return; }
  homeMessage.textContent = '';
  sourceUrl = url.href;
  sourceLink.href = sourceUrl;
  showView('player');
  const toTV = casting();
  await runOperation(signal => resolveAndPlay(signal, toTV));
}
async function refreshStream() {
  if (busy || !sourceUrl) return;
  const toTV = casting();
  await runOperation(async signal => {
    if (candidate) {
      try {
        if (toTV) await loadOnTV(candidate, signal);
        else await attachLocal(candidate, signal);
        return;
      } catch (error) { if (signal.aborted) throw error; }
    }
    say('RECONNECTING TO SOURCE');
    await resolveAndPlay(signal, toTV);
  });
}

function updateTVButton() {
  const airplay = typeof video.webkitShowPlaybackTargetPicker === 'function';
  const castReady = Boolean(castContext);
  tvMode = airplay ? 'airplay' : castReady ? 'cast' : null;
  tvButton.hidden = !tvMode;
  tvButton.textContent = tvMode === 'airplay' ? 'AIRPLAY' : 'CAST';
  tvButton.classList.toggle('is-connected', casting() || Boolean(video.webkitCurrentPlaybackTargetIsWireless));
  tvButton.disabled = busy || castLoading || !candidate;
  tvButton.title = tvMode === 'cast' ? 'Choose a Google Cast device' : 'Choose an AirPlay device';
}
function mediaMime(item) {
  if (item.isHls) return 'application/vnd.apple.mpegurl';
  const type = item.contentType?.split(';')[0];
  if (type?.startsWith('video/')) return type;
  const url = new URL(item.proxyUrl, location.href).searchParams.get('url') || '';
  return /\.webm(?:$|\?)/i.test(url) ? 'video/webm' : 'video/mp4';
}
async function loadOnTV(item, signal) {
  const session = castSession();
  if (!session) throw new Error('NO CAST DEVICE CONNECTED');
  castLoading = true;
  updateTVButton();
  try {
    let live = Boolean(item.isHls && localLive);
    if (item.isHls) {
      const probeController = new AbortController();
      const timeout = setTimeout(() => probeController.abort(), 12000);
      const cancelProbe = () => probeController.abort();
      signal?.addEventListener('abort', cancelProbe, {once: true});
      let info;
      try { info = await probeManifest(item, probeController.signal); }
      finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancelProbe); }
      if (info) { live = info.live; segmentDuration = info.duration; }
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const media = new chrome.cast.media.MediaInfo(new URL(item.proxyUrl, location.href).href, mediaMime(item));
    media.streamType = live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
    media.metadata = new chrome.cast.media.GenericMediaMetadata();
    media.metadata.title = 'WATCH';
    media.customData = {sourceUrl, isHls: item.isHls, segmentDuration};
    const request = new chrome.cast.media.LoadRequest(media);
    request.autoplay = true;
    if (!live && video.currentTime > 0) request.currentTime = video.currentTime;
    await session.loadMedia(request);
    // Only stop the local download after the receiver accepts the media.
    destroyLocal();
    placeholder('PLAYING ON TV');
    say();
  } catch (error) {
    throw new Error(error.message || `CAST FAILED (${error.code || error}) — TRY ANOTHER STREAM`);
  } finally { castLoading = false; syncControls(); }
}
function adoptCastMedia() {
  const media = castSession()?.getMediaSession()?.media;
  if (!media) return;
  try {
    const url = new URL(media.contentId);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/media/')) return;
    candidate = {proxyUrl: url.href, isHls: Boolean(media.customData?.isHls), contentType: media.contentType};
    sourceUrl = media.customData?.sourceUrl || sourceUrl;
    sourceLink.href = sourceUrl;
    streamInput.value = sourceUrl;
    segmentDuration = media.customData?.segmentDuration || 6;
    showView('player');
    destroyLocal();
    setBusy(false);
  } catch { /* A different receiver session must not replace our current source. */ }
}
window.__onGCastApiAvailable = available => {
  if (!available || !window.cast?.framework || castContext) return;
  castContext = cast.framework.CastContext.getInstance();
  castContext.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED
  });
  remotePlayer = new cast.framework.RemotePlayer();
  remoteController = new cast.framework.RemotePlayerController(remotePlayer);
  remoteController.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, syncControls);
  castContext.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, updateTVButton);
  castContext.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, event => {
    if (event.sessionState === cast.framework.SessionState.SESSION_RESUMED) adoptCastMedia();
    if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
      stage.classList.remove('is-casting');
      if (candidate && playerView.classList.contains('is-active') && !busy) {
        refreshStream();
      }
    }
    syncControls();
  });
  updateTVButton();
};

tvButton.addEventListener('click', async () => {
  if (!candidate || busy) return;
  if (tvMode === 'airplay') {
    video.webkitShowPlaybackTargetPicker();
    return;
  }
  if (tvMode !== 'cast') return;
  try {
    // Called directly from the click, preserving the browser's user gesture.
    await castContext.requestSession();
    if (castSession() && !casting() && !castLoadPromise) {
      castLoadPromise = loadOnTV(candidate);
      await castLoadPromise;
    }
  } catch (error) {
    if (error !== 'cancel' && error?.code !== 'cancel') {
      say(error.message || 'CAST UNAVAILABLE — CHECK YOUR TV, WI-FI, AND CHROME LOCAL NETWORK PERMISSION');
    }
  } finally { castLoadPromise = null; updateTVButton(); }
});
$('#open-stream').addEventListener('click', openStream);
streamInput.addEventListener('keydown', event => { if (event.key === 'Enter') openStream(); });
refreshButton.addEventListener('click', refreshStream);
$('#back-button').addEventListener('click', () => {
  operation?.abort(); operation = null;
  destroyLocal();
  // TV playback can continue while another link is entered.
  showView('home');
  setBusy(false);
  requestAnimationFrame(() => streamInput.focus());
});
playButton.addEventListener('click', async () => {
  if (casting()) { remoteController.playOrPause(); return; }
  if (!candidate || busy) return;
  if (!video.paused) video.pause();
  else {
    try { await video.play(); say(); }
    catch { say('PLAYBACK COULD NOT START — PRESS REFRESH'); }
  }
});
muteButton.addEventListener('click', () => {
  if (casting()) remoteController.muteOrUnmute();
  else video.muted = !video.muted;
  syncControls();
});
liveButton.addEventListener('click', async () => {
  if (casting()) {
    const target = remoteLivePosition();
    if (target === null) return;
    const media = castSession()?.getMediaSession();
    const request = new chrome.cast.media.SeekRequest();
    request.currentTime = target;
    request.resumeState = chrome.cast.media.ResumeState.PLAYBACK_START;
    media?.seek(request, () => say(), () => say('COULD NOT JUMP TO LIVE — PRESS REFRESH'));
    return;
  }
  const target = latestLocalPosition();
  if (target === null) return;
  video.currentTime = target;
  try { await video.play(); say(); }
  catch { say('PRESS PLAY TO RESUME'); }
});
$('#fullscreen-button').addEventListener('click', async () => {
  if (casting()) { say('VIDEO IS PLAYING ON YOUR TV'); return; }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else await stage.requestFullscreen?.();
  } catch { say('FULLSCREEN IS UNAVAILABLE'); }
});
for (const name of ['play', 'pause', 'volumechange', 'durationchange', 'progress', 'seeked', 'webkitcurrentplaybacktargetiswirelesschanged']) {
  video.addEventListener(name, syncControls);
}
video.addEventListener('playing', () => { buffering = false; lastProgress = Date.now(); syncControls(); });
video.addEventListener('waiting', () => { buffering = true; syncControls(); });
video.addEventListener('ended', () => { buffering = true; syncControls(); });
video.addEventListener('error', () => {
  buffering = true;
  if (!busy && candidate && !casting()) say('STREAM INTERRUPTED — PRESS REFRESH');
  syncControls();
});
video.addEventListener('timeupdate', () => {
  if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = Date.now(); }
  syncControls();
});
setInterval(() => {
  if (!playerView.classList.contains('is-active')) return;
  syncControls();
  // Native Safari doesn't expose HLS playlist state. Read the same small playlist
  // periodically to distinguish live from VOD/ended streams without re-extracting.
  if (candidate?.isHls && !hls && !casting() && !busy && !nativeProbePending && Date.now() - nativeProbeAt > 15000) {
    nativeProbeAt = Date.now(); nativeProbePending = true;
    const thisGeneration = generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    probeManifest(candidate, controller.signal).then(info => {
      if (info && thisGeneration === generation) { localLive = info.live; segmentDuration = info.duration; }
    }).catch(() => {}).finally(() => { clearTimeout(timer); nativeProbePending = false; });
  }
}, 1000);
updateTVButton();
syncControls();
