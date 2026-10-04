
import express from 'express';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));
app.use(express.static('public', {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

const sessions = new Map();
const ipBuckets = new Map();

const SESSION_TTL_MS = 20 * 60 * 1000;
const RESOLVE_TIMEOUT_MS = 35_000;
const PAGE_SETTLE_MS = 7_000;
const MAX_CANDIDATES = 12;

const MEDIA_EXT = /\.(m3u8|mp4|m4v|mov|webm)(?:$|\?)/i;
const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const max = 10;

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

  if (/\.m3u8(?:$|\?)/i.test(url)) score += 120;
  if (HLS_TYPES.has(ct.split(';')[0])) score += 120;
  if (/\.(mp4|m4v|mov|webm)(?:$|\?)/i.test(url)) score += 85;
  if (ct.startsWith('video/')) score += 80;
  if (candidate.kind === 'video') score += 35;
  if (candidate.kind === 'source') score += 30;
  if (candidate.kind === 'network') score += 20;

  if (/ads?|doubleclick|vast|preroll|promo|analytics|tracking/i.test(url)) score -= 200;
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

async function createBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });
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

  let browser;

  try {
    browser = await createBrowser();

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent: USER_AGENT,
      locale: 'en-US',
      javaScriptEnabled: true
    });

    const page = await context.newPage();
    const networkCandidates = [];

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

    await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: RESOLVE_TIMEOUT_MS
    });

    await page.waitForTimeout(PAGE_SETTLE_MS);

    const domCandidates = [];

    for (const frame of page.frames()) {
      try {
        const frameItems = await frame.evaluate(() => {
          const output = [];

          document.querySelectorAll('video').forEach(video => {
            [
              video.currentSrc,
              video.src,
              video.getAttribute('src')
            ]
              .filter(Boolean)
              .forEach(url => output.push({ url, kind: 'video' }));

            video.querySelectorAll('source').forEach(source => {
              const url = source.currentSrc || source.src || source.getAttribute('src');

              if (url) {
                output.push({
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
              output.push({
                url,
                kind: 'source',
                contentType: source.type || ''
              });
            }
          });

          return output;
        });

        for (const item of frameItems) {
          const url = absoluteUrl(item.url, frame.url());
          if (url) domCandidates.push({ ...item, url });
        }
      } catch {}
    }

    const candidates = dedupeCandidates([
      ...domCandidates,
      ...networkCandidates
    ]).slice(0, MAX_CANDIDATES);

    const cookies = await context.cookies();
    const sessionId = crypto.randomBytes(18).toString('hex');

    sessions.set(sessionId, {
      sourceUrl: target.href,
      finalPageUrl: page.url(),
      cookies,
      userAgent: USER_AGENT,
      createdAt: Date.now()
    });

    setTimeout(() => sessions.delete(sessionId), SESSION_TTL_MS).unref?.();

    return res.json({
      sourceUrl: target.href,
      finalPageUrl: page.url(),
      candidates: candidates.map(candidate => ({
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
    await browser?.close().catch(() => {});
  }
});

app.get('/api/media/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(410).send('Session expired');
  }

  let target;
  try {
    target = await assertSafeHttpUrl(String(req.query.url || ''));
  } catch (error) {
    return res.status(400).send(error.message);
  }

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
      redirect: 'follow'
    });

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isHls =
      /\.m3u8(?:$|\?)/i.test(target.href) ||
      HLS_TYPES.has(contentType.split(';')[0]);

    if (!upstream.ok && upstream.status !== 206) {
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

    const reader = upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!res.write(Buffer.from(value))) {
        await new Promise(resolve => res.once('drain', resolve));
      }
    }

    res.end();
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.status(502).send('Media proxy failed');
    } else {
      res.end();
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WATCH listening on port ${PORT}`);
});
