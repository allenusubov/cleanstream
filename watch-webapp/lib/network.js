import dns from 'node:dns/promises';
import net from 'node:net';
import {currentSignal,aborted,abortable} from './discovery-control.js';

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
export function publicURL(input) {
  let url;
  try {url=new URL(input);}catch{throw new AppError('INVALID_URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port)))throw new AppError('INVALID_URL');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(!host||/^(localhost|localhost\.localdomain)$|\.(localhost|local|internal)$/i.test(host)||(net.isIP(host)&&privateAddress(host)))throw new AppError('INVALID_URL');
  return url;
}
const dnsJobs=new Map();
export async function safeURL(input) {
  aborted();
  const url=publicURL(input),host=url.hostname.replace(/^\[|\]$/g,'');
  let records;
  if(net.isIP(host))records=[{address:host}];
  else {
    if(!dnsJobs.has(host)){
      // Share only simultaneous lookups. Check DNS again on each subsequent
      // fetch/redirect instead of trusting a stale public-address result.
      const job=dns.lookup(host,{all:true}).finally(()=>dnsJobs.delete(host));dnsJobs.set(host,job);
    }
    records=await abortable(dnsJobs.get(host),AbortSignal.any([AbortSignal.timeout(5000),...(currentSignal()?[currentSignal()]:[])]));
  }
  if(!records.length||records.some(x=>privateAddress(x.address)))throw new AppError('INVALID_URL');
  aborted();return url;
}
export async function fetchLimited(input, {signal, limit = 1024 * 1024, headers = {}, partial = false} = {}) {
  const timeout = AbortSignal.timeout(10000);
  const signals=[timeout,signal,currentSignal()].filter(Boolean);
  const combined=AbortSignal.any(signals);
  aborted(combined);
  let url = input;
  for (let n = 0; n < 10; n++) {
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
  constructor(max = 2) {
    this.max = Math.max(1, Number(max) || 2);
    this.active = 0;
    this.queue = [];
  }
  async run(task,signal=currentSignal()) {
    aborted(signal);
    if(this.active>=this.max)await new Promise((resolve,reject)=>{
      const entry=()=>{signal?.removeEventListener('abort',cancel);resolve();};
      const cancel=()=>{const index=this.queue.indexOf(entry);if(index>=0)this.queue.splice(index,1);reject(signal.reason||new DOMException('Cancelled','AbortError'));};
      this.queue.push(entry);signal?.addEventListener('abort',cancel,{once:true});
    });
    else this.active++;
    try {aborted(signal);return await task();}
    finally {const next=this.queue.shift();if(next)next();else this.active--;}
  }
}
