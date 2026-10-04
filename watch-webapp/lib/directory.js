// Read ordinary directory links without launching a browser. Dynamic-only sites
// may use the bounded browser fallback in discovery.js.
export function decodeText(value) {
  return String(value).replace(/&#(x[0-9a-f]+|\d+);/gi,(_,v)=>{
    const n=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):Number(v);
    return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g,(_,v)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[v]));
}
export function directoryLinks(html,base,allowedHosts=[]) {
  const links=[];
  const clean=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,'');
  for(const match of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href=match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if(!href)continue;
    try {
      const url=new URL(decodeText(href),base);
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password||(allowedHosts.length&&!allowedHosts.includes(url.hostname)))continue;
      const aria=match[1].match(/\baria-label\s*=\s*(["'])(.*?)\1/i)?.[2];
      const text=decodeText(aria||match[2].replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
      if(text)links.push({url:url.href,text});
      if(links.length>=600)break;
    }catch{}
  }
  return links;
}
