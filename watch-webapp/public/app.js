
const homeView = document.querySelector('[data-view="home"]');
const playerView = document.querySelector('[data-view="player"]');

const streamInput = document.querySelector('#stream-url');
const openButton = document.querySelector('#open-stream');
const homeMessage = document.querySelector('#home-message');

const backButton = document.querySelector('#back-button');
const sourceLink = document.querySelector('#source-link');
const video = document.querySelector('#video');
const playerEmpty = document.querySelector('#player-empty');
const emptyCopy = document.querySelector('#empty-copy');
const playerMessage = document.querySelector('#player-message');

const playButton = document.querySelector('#play-button');
const muteButton = document.querySelector('#mute-button');
const airplayButton = document.querySelector('#airplay-button');
const fullscreenButton = document.querySelector('#fullscreen-button');

let hls = null;
let requestController = null;

function showView(name) {
  const isHome = name === 'home';

  homeView.classList.toggle('is-active', isHome);
  playerView.classList.toggle('is-active', !isHome);

  homeView.setAttribute('aria-hidden', String(!isHome));
  playerView.setAttribute('aria-hidden', String(isHome));
}

function normalizeUrl(value) {
  const raw = value.trim();
  if (!raw) return null;

  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

function resetPlayer() {
  requestController?.abort();
  requestController = null;

  if (hls) {
    hls.destroy();
    hls = null;
  }

  video.pause();
  video.removeAttribute('src');
  video.load();

  video.classList.remove('is-visible');
  playerEmpty.classList.remove('is-hidden');
  emptyCopy.textContent = 'LOADING';

  playerMessage.textContent = '';
  playButton.textContent = 'PLAY';
  muteButton.textContent = 'MUTE';
}

async function attachCandidate(candidate) {
  const src = candidate.proxyUrl;

  if (candidate.isHls) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else if (window.Hls?.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          playerMessage.textContent = `PLAYBACK ERROR: ${String(data.type).toUpperCase()}`;
        }
      });
    } else {
      throw new Error('HLS is not supported in this browser');
    }
  } else {
    video.src = src;
  }

  video.classList.add('is-visible');
  playerEmpty.classList.add('is-hidden');

  try {
    await video.play();
  } catch {
    playerMessage.textContent = 'READY — PRESS PLAY';
  }
}

async function parseApiResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    const clean = text
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    throw new Error(
      clean
        ? `SERVER ERROR: ${clean}`
        : `SERVER ERROR ${response.status}`
    );
  }
}

async function openStream() {
  const url = normalizeUrl(streamInput.value);
  homeMessage.textContent = '';

  if (!url) {
    homeMessage.textContent = 'ENTER A VALID URL';
    streamInput.focus();
    return;
  }

  resetPlayer();
  sourceLink.href = url.href;
  showView('player');

  requestController = new AbortController();

  try {
    const response = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: url.href }),
      signal: requestController.signal
    });

    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data.detail || data.error || 'Could not resolve page');
    }

    if (!Array.isArray(data.candidates) || !data.candidates.length) {
      emptyCopy.textContent = 'NO VIDEO';
      playerMessage.textContent = 'NO PLAYABLE MEDIA FOUND';
      return;
    }

    await attachCandidate(data.candidates[0]);
  } catch (error) {
    if (error.name === 'AbortError') return;

    emptyCopy.textContent = 'FAILED';
    playerMessage.textContent = String(error.message || error).toUpperCase();
  } finally {
    requestController = null;
  }
}

openButton.addEventListener('click', openStream);

streamInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') openStream();
});

backButton.addEventListener('click', () => {
  resetPlayer();
  showView('home');
  requestAnimationFrame(() => streamInput.focus());
});

playButton.addEventListener('click', async () => {
  if (!video.src && !hls) return;

  if (video.paused) {
    try {
      await video.play();
    } catch {
      playerMessage.textContent = 'PLAYBACK COULD NOT START';
    }
  } else {
    video.pause();
  }
});

video.addEventListener('play', () => {
  playButton.textContent = 'PAUSE';
});

video.addEventListener('pause', () => {
  playButton.textContent = 'PLAY';
});

muteButton.addEventListener('click', () => {
  video.muted = !video.muted;
  muteButton.textContent = video.muted ? 'UNMUTE' : 'MUTE';
});

fullscreenButton.addEventListener('click', async () => {
  const target = video.classList.contains('is-visible')
    ? video
    : document.querySelector('.player-stage');

  if (document.fullscreenElement) {
    await document.exitFullscreen?.();
    return;
  }

  await target.requestFullscreen?.();
});

airplayButton.addEventListener('click', () => {
  if (typeof video.webkitShowPlaybackTargetPicker === 'function') {
    video.webkitShowPlaybackTargetPicker();
    return;
  }

  playerMessage.textContent = 'AIRPLAY IS AVAILABLE IN SAFARI WHEN THE MEDIA SUPPORTS IT';
});
