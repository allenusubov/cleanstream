
import express from 'express';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));
app.use(express.static('public', {
  etag: true,
  maxAge: 0
}));

const sessions = new Map();
const ipBuckets = new Map();

// Expire only idle sessions. HLS segment/playlist requests keep an active TV alive.
const SESSION_IDLE_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.lastAccess < cutoff && !session.activeRequests) sessions.delete(id);
  }
  for (const [ip, times] of ipBuckets) {
    if (!times.some(time => Date.now() - time < 60_000)) ipBuckets.delete(ip);
  }
}, 60_000).unref();
const NAV_TIMEOUT_MS = 12_000;
const INITIAL_SETTLE_MS = 2_500;
const POST_INTERACTION_MS = 4_500;
const MAX_CANDIDATES = 12;

const MEDIA_EXT = /\.(m3u8|mp4|m4v|mov|webm|mpd)(?:$|\?)/i;
const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  sharedBrowser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-first-run',
      '--no-zygote'
    ]
  });

  sharedBrowser.on('disconnected', () => {
    sharedBrowser = null;
  });

  return sharedBrowser;
}

function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const max = 8;

  const bucket = ipBuckets.get(key) || [];
  const fresh = bucket.filter(ts => now - ts < windowMs);

  if (fresh.length >= max) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  fresh.push(now);
  ipBuckets.set(key, fresh);
  next();
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;

  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;

  const v4_172 = ip.match(/^172\.(\d+)\./);
  if (v4_172 && Number(v4_172[1]) >= 16 && Number(v4_172[1]) <= 31) return true;

  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;

  return false;
}

async function assertSafeHttpUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }

  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not supported');
  }

  const records = await dns.lookup(url.hostname, { all: true });

  if (!records.length || records.some(r => isPrivateIp(r.address))) {
    throw new Error('Private/local network URLs are not allowed');
  }

  return url;
}

function scoreCandidate(candidate) {
  let score = 0;
  const url = candidate.url || '';
  const ct = (candidate.contentType || '').toLowerCase();

  if (/\.m3u8(?:$|\?)/i.test(url)) score += 150;
  if (HLS_TYPES.has(ct.split(';')[0])) score += 150;
  if (/\.(mp4|m4v|mov|webm)(?:$|\?)/i.test(url)) score += 100;
  if (ct.startsWith('video/')) score += 90;
  if (candidate.kind === 'video') score += 45;
  if (candidate.kind === 'source') score += 40;
  if (candidate.kind === 'network') score += 25;
  if (candidate.kind === 'request') score += 15;

  if (/ads?|doubleclick|vast|preroll|promo|analytics|tracking|pixel/i.test(url)) score -= 250;
  if (candidate.status && candidate.status >= 400) score -= 100;

  return score;
}

function dedupeCandidates(items) {
  const seen = new Set();

  return items
    .filter(item => item?.url && /^https?:\/\//i.test(item.url))
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

function absoluteUrl(raw, base) {
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

function proxiedUrl(sessionId, absolute) {
  return `/api/media/${encodeURIComponent(sessionId)}?url=${encodeURIComponent(absolute)}`;
}

function rewriteManifest(text, baseUrl, sessionId) {
  return text.split(/\r?\n/).map(line => {
    if (!line) return line;

    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, raw) => {
        const absolute = absoluteUrl(raw, baseUrl);
        return absolute ? `URI="${proxiedUrl(sessionId, absolute)}"` : `URI="${raw}"`;
      });
    }

    const absolute = absoluteUrl(line.trim(), baseUrl);
    return absolute ? proxiedUrl(sessionId, absolute) : line;
  }).join('\n');
}

function cookieHeaderFor(cookies, targetUrl) {
  const url = new URL(targetUrl);

  return cookies
    .filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '');
      return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    })
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function collectDomCandidates(page) {
  const output = [];

  for (const frame of page.frames()) {
    try {
      const frameItems = await frame.evaluate(() => {
        const items = [];

        document.querySelectorAll('video').forEach(video => {
          [video.currentSrc, video.src, video.getAttribute('src')]
            .filter(Boolean)
            .forEach(url => items.push({ url, kind: 'video' }));

          video.querySelectorAll('source').forEach(source => {
            const url = source.currentSrc || source.src || source.getAttribute('src');

            if (url) {
              items.push({
                url,
                kind: 'source',
                contentType: source.type || ''
              });
            }
          });
        });

        document.querySelectorAll('source').forEach(source => {
          const url = source.currentSrc || source.src || source.getAttribute('src');

          if (url) {
            items.push({
              url,
              kind: 'source',
              contentType: source.type || ''
            });
          }
        });

        return items;
      });

      for (const item of frameItems) {
        const url = absoluteUrl(item.url, frame.url());
        if (url) output.push({ ...item, url });
      }
    } catch {}
  }

  return output;
}

async function tryStartPlayers(page) {
  const selectors = [
    'button[aria-label*="play" i]',
    '[role="button"][aria-label*="play" i]',
    '.vjs-big-play-button',
    '.jw-icon-playback',
    '.plyr__control[data-plyr="play"]',
    'button[class*="play" i]',
    '[class*="play-button" i]'
  ];

  for (const frame of page.frames()) {
    try {
      const videos = frame.locator('video');
      const count = await videos.count();

      for (let i = 0; i < Math.min(count, 3); i++) {
        try {
          await videos.nth(i).evaluate(video => {
            video.muted = true;
            const result = video.play();
            if (result?.catch) result.catch(() => {});
          });
        } catch {}
      }
    } catch {}

    for (const selector of selectors) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible({ timeout: 250 })) {
          await locator.click({ timeout: 800, force: true });
          await page.waitForTimeout(350);
          break;
        }
      } catch {}
    }
  }
}

app.get('/health', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.post('/api/resolve', rateLimit, async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();

  let target;
  try {
    target = await assertSafeHttpUrl(rawUrl);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let context;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent: USER_AGENT,
      locale: 'en-US',
      javaScriptEnabled: true
    });

    // Close popup tabs immediately. The main page stays open.
    let mainPage = null;
    context.on('page', popup => {
      if (mainPage && popup !== mainPage) {
        popup.close().catch(() => {});
      }
    });

    const page = await context.newPage();
    mainPage = page;

    // Images and fonts are unnecessary for finding the player and slow these pages down.
    await page.route('**/*', async route => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });

    const networkCandidates = [];

    page.on('request', request => {
      try {
        const url = request.url();
        if (MEDIA_EXT.test(url)) {
          networkCandidates.push({
            url,
            contentType: '',
            kind: 'request'
          });
        }
      } catch {}
    });

    page.on('response', async response => {
      try {
        const url = response.url();
        const headers = await response.allHeaders();
        const contentType = (headers['content-type'] || '').toLowerCase();

        if (
          MEDIA_EXT.test(url) ||
          contentType.startsWith('video/') ||
          HLS_TYPES.has(contentType.split(';')[0])
        ) {
          networkCandidates.push({
            url,
            contentType,
            kind: 'network',
            status: response.status()
          });
        }
      } catch {}
    });

    // "commit" only waits until the server begins returning the document.
    // Heavy ad/stream pages often never finish DOMContentLoaded.
    try {
      await page.goto(target.href, {
        waitUntil: 'commit',
        timeout: NAV_TIMEOUT_MS
      });
    } catch (error) {
      // If navigation actually started, keep going instead of failing the request.
      if (page.url() === 'about:blank') throw error;
    }

    await page.waitForTimeout(INITIAL_SETTLE_MS);

    let domCandidates = await collectDomCandidates(page);
    let candidates = dedupeCandidates([
      ...domCandidates,
      ...networkCandidates
    ]);

    // Many live players do not request HLS until the play control is activated.
    if (!candidates.length) {
      await tryStartPlayers(page);
      await page.waitForTimeout(POST_INTERACTION_MS);

      domCandidates = await collectDomCandidates(page);
      candidates = dedupeCandidates([
        ...domCandidates,
        ...networkCandidates
      ]);
    }

    const cookies = await context.cookies();
    const sessionId = crypto.randomBytes(18).toString('hex');

    sessions.set(sessionId, {
      sourceUrl: target.href,
      finalPageUrl: page.url(),
      cookies,
      userAgent: USER_AGENT,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      activeRequests: 0
    });


    return res.json({
      sourceUrl: target.href,
      finalPageUrl: page.url(),
      candidates: candidates.slice(0, MAX_CANDIDATES).map(candidate => ({
        kind: candidate.kind,
        contentType: candidate.contentType || '',
        isHls:
          /\.m3u8(?:$|\?)/i.test(candidate.url) ||
          HLS_TYPES.has((candidate.contentType || '').split(';')[0].toLowerCase()),
        proxyUrl: proxiedUrl(sessionId, candidate.url)
      }))
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Could not resolve media from that page',
      detail: error?.message || String(error)
    });
  } finally {
    await context?.close().catch(() => {});
  }
});

// Receivers fetch this public, token-scoped URL from another origin.
app.use('/api/media/:sessionId', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/media/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(410).send('Session expired');
  }

  session.lastAccess = Date.now();
  let target;
  try {
    target = await assertSafeHttpUrl(String(req.query.url || ''));
  } catch (error) {
    return res.status(400).send(error.message);
  }

  const abort = new AbortController();
  const disconnect = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', disconnect);
  session.activeRequests++;
  try {
    const headers = {
      'user-agent': session.userAgent,
      'referer': session.finalPageUrl || session.sourceUrl,
      'accept': '*/*'
    };

    const cookie = cookieHeaderFor(session.cookies, target.href);
    if (cookie) headers.cookie = cookie;
    if (req.headers.range) headers.range = req.headers.range;

    const upstream = await fetch(target.href, {
      headers,
      redirect: 'follow',
      signal: abort.signal
    });

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isHls =
      /\.m3u8(?:$|\?)/i.test(target.href) ||
      HLS_TYPES.has(contentType.split(';')[0]);

    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel();
      return res.status(upstream.status).send(`Upstream media error ${upstream.status}`);
    }

    if (isHls) {
      const manifest = await upstream.text();
      const rewritten = rewriteManifest(
        manifest,
        upstream.url || target.href,
        req.params.sessionId
      );

      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.setHeader('cache-control', 'no-store');
      return res.send(rewritten);
    }

    for (const header of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control'
    ]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    res.status(upstream.status);

    if (!upstream.body) return res.end();

    if (req.method === 'HEAD') {
      await upstream.body.cancel();
      return res.end();
    }
    await pipeline(Readable.fromWeb(upstream.body), res);

  } catch (error) {
    if (!abort.signal.aborted) console.error(error);

    if (!res.headersSent && !res.destroyed) {
      res.status(502).send('Media proxy failed');
    } else if (!res.destroyed) {
      res.end();
    }
  } finally {
    session.activeRequests--;
    session.lastAccess = Date.now();
    res.off('close', disconnect);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WATCH listening on port ${PORT}`);
});
