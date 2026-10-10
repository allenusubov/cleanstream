function identity(site){
  let root=site.displayHost||site.indexUrls?.[0]||site.id;
  try{return new URL(root.includes('://')?root:'https://'+root).hostname.replace(/^www\./i,'').toLowerCase();}catch{return site.id;}
}
const union=(a=[],b=[])=>[...new Set([...a,...b])].slice(0,32);
export function mergeProviders(builtins,customs){
  const sites=new Map();
  for(const site of [...builtins,...customs]){
    if(!site?.enabled)continue;
    const key=identity(site),existing=sites.get(key);
    if(!existing){sites.set(key,{...site});continue;}
    // Add reusable custom routes without replacing a built-in adapter's type,
    // restrictions, search templates, or identity.
    const categories={...existing.categories};
    for(const [category,urls] of Object.entries(site.categories||{}))categories[category]=union(categories[category],urls);
    sites.set(key,{...existing,categories,indexUrls:union(existing.indexUrls,site.indexUrls),eventListUrls:union(existing.eventListUrls,site.eventListUrls)});
  }
  return [...sites.values()];
}
