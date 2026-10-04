import dns from 'node:dns/promises';
import net from 'node:net';

export class AppError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function privateAddress(input) {
  let ip = input.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
    if (ip.includes(':')) ip = ip.split(':').flatMap(x => [parseInt(x, 16) >> 8, parseInt(x, 16) & 255]).join('.');
  }
  if (net.isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0,168].includes(b)) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18,19].includes(b));
  }
  // Public IPv6 unicast only; excludes loopback, mapped/private and link-local ranges.
  return net.isIP(ip) !== 6 || !/^[23][0-9a-f]{3}:/.test(ip) || ip.startsWith('2001:db8:');
}
export async function safeURL(input) {
  let url;
  try { url = new URL(input); } catch { throw new AppError('INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80','443'].includes(url.port))) throw new AppError('INVALID_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{address:host}] : await dns.lookup(host, {all:true});
  if (!records.length || records.some(x => privateAddress(x.address))) throw new AppError('INVALID_URL');
  return url;
}
export async function fetchLimited(input, {signal, limit = 1024 * 1024, headers = {}, partial = false} = {}) {
  const timeout = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = input;
  for (let n = 0; n < 6; n++) {
    url = (await safeURL(url)).href;
    const response = await fetch(url, {headers, redirect:'manual', signal:combined});
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next) throw new AppError('SOURCE_UNAVAILABLE', 502);
      url = new URL(next, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new AppError('SOURCE_UNAVAILABLE', 502); }
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    try {
      if (reader) while (true) {
        const {value, done} = await reader.read(); if (done) break;
        if (size + value.length > limit) {
          if (!partial) throw new AppError('SOURCE_UNAVAILABLE', 502);
          chunks.push(value.slice(0, limit - size)); size = limit; break;
        }
        chunks.push(value); size += value.length;
        if (partial && size >= limit) break;
      }
    } finally { await reader?.cancel().catch(() => {}); }
    return {url, status:response.status, headers:response.headers, body:Buffer.concat(chunks)};
  }
  throw new AppError('SOURCE_UNAVAILABLE', 502);
}

export class WorkPool {
  constructor(max = 2, queueLimit = 10, dailyLimit = 240) {
    this.max = max; this.queueLimit = queueLimit; this.dailyLimit = dailyLimit;
    this.active = 0; this.queue = []; this.day = ''; this.used = 0;
  }
  async run(task) {
    const day = new Date().toISOString().slice(0,10);
    if (day !== this.day) { this.day = day; this.used = 0; }
    if (this.used >= this.dailyLimit) throw new AppError('USAGE_LIMIT', 429);
    if (this.active >= this.max && this.queue.length >= this.queueLimit) throw new AppError('BUSY', 429);
    this.used++;
    if (this.active >= this.max) await new Promise(resolve => this.queue.push(resolve));
    else this.active++;
    try { return await task(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
}
