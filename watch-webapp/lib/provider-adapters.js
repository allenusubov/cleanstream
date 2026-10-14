// Reusable category routes, never an old game's URL or a guessed video token.
const routes={NBA:'nba',WNBA:'wnba',NFL:'nfl',UFC:'ufc',MMA:'ufc',BOXING:'boxing',NHL:'nhl',MLB:'mlb',SOCCER:'soccer',F1:'f1',NASCAR:'nascar',TENNIS:'tennis',RUGBY:'rugby'};
export function adapterRoutes(site,event){
  const root=site.indexUrls?.[0];if(!root)return [];
  const host=new URL(root).hostname.replace(/^www\./,'');const league=String(event.league||event.sport||'').toUpperCase();
  if(/^(streameaste\.is|streameast100\.is|footybites\.is)$/.test(host)&&routes[league])return [new URL('/'+routes[league]+'-streams',root).href];
  if(host==='streamseast.eu'&&league==='NBA')return [new URL('/nba/',root).href];
  return [];
}
export function structuredEventLinks(body,base){
  const text=String(body||''),values=[];
  try{values.push(JSON.parse(text));}catch{}
  for(const script of text.matchAll(/<script\b[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi))try{values.push(JSON.parse(script[1]));}catch{}
  const links=new Map();let visited=0;
  function walk(value,depth=0){
    if(!value||typeof value!=='object'||depth>8||++visited>3000)return;
    if(!Array.isArray(value)){
      const target=value.eventUrl||value.watchUrl||value.embedUrl||value.url||value.href||value.link;
      const title=value.title||value.name||value.eventName||[value.teams?.home?.name,value.teams?.away?.name].filter(Boolean).join(' vs ');
      if(typeof target==='string'&&typeof title==='string'&&title){try{const u=new URL(target,base);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)links.set(u.href,{url:u.href,text:title});}catch{}}
    }
    for(const item of Object.values(value))if(item&&typeof item==='object')walk(item,depth+1);
  }
  values.forEach(value=>walk(value));return [...links.values()];
}
