export function youtubeId(value) {
  try {
    const url=new URL(value);if(!['https:','http:'].includes(url.protocol))return null;
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    let id=null;
    if(host==='youtu.be')id=url.pathname.split('/')[1];
    if(['youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host)) {
      id=url.pathname==='/watch'?url.searchParams.get('v'):/^\/(live|embed|shorts)\//.test(url.pathname)?url.pathname.split('/')[2]:null;
    }
    return /^[\w-]{11}$/.test(id||'')?id:null;
  }catch{return null;}
}
export function youtubeCandidate(id,live=true) {
  return {id:`youtube-${id}`,provider:'youtube',videoId:id,sourceUrl:`https://www.youtube.com/watch?v=${id}`,live,castEligible:false,displayName:'YOUTUBE.COM'};
}
