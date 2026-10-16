import {publicURL} from './network.js';
import {excludedPlatform} from '../public/live-only.js';

// Read literal player configuration, including a literal atob(...) value.
// No downloaded JavaScript is evaluated, and an extensionless URL is fetched
// for its manifest header before being presented as an HLS candidate.
export function configuredPlayerSources(html,base){
  const text=String(html);if(!/\bHls\b|\bClappr\b|\bjwplayer\b|mpegurl|<video\b/i.test(text))return [];
  const found=new Map();
  const add=(raw,encoded=false)=>{
    try{
      const value=(encoded?Buffer.from(raw,'base64').toString('utf8'):raw).replace(/\\u0026/gi,'&').replace(/\\u003d/gi,'=').replace(/\\u003a/gi,':').replace(/\\u002f/gi,'/').replace(/\\\//g,'/').replace(/&amp;/g,'&');
      const url=publicURL(new URL(value,base).href);
      if(excludedPlatform(url.href)||/doubleclick|\/ads?\/|preroll|analytics/i.test(url.href)||url.href.length>4096)return;
      if(!found.has(url.href))found.set(url.href,{url:url.href,kind:'player-media',label:'PLAYER VIDEO'});
    }catch{}
  };
  for(const match of text.matchAll(/\b(?:source|file|src|streamUrl|hlsUrl|playlistUrl)\s*[:=]\s*(?:window\.)?atob\(\s*(["'])([A-Za-z0-9+/=]{12,8192})\1\s*\)/gi))add(match[2],true);
  for(const match of text.matchAll(/\b(?:source|file|streamUrl|hlsUrl|playlistUrl)\s*[:=]\s*(["'])(https?:[^"'\r\n]{5,4096})\1/gi))add(match[2]);
  for(const match of text.matchAll(/\.loadSource\(\s*(["'])(https?:[^"'\r\n]{5,4096})\1\s*\)/gi))add(match[2]);
  return [...found.values()].slice(0,8);
}
