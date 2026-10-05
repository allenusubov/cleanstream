export function twitchChannel(value) {
  try{
    const url=new URL(value);if(!['https:','http:'].includes(url.protocol))return null;
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    if(host!=='twitch.tv'&&host!=='m.twitch.tv')return null;
    const channel=url.pathname.split('/').filter(Boolean)[0];
    if(!channel||['directory','videos','downloads','jobs','p','settings'].includes(channel.toLowerCase()))return null;
    return /^[a-z0-9_]{2,25}$/i.test(channel)?channel:null;
  }catch{return null;}
}
export function twitchCandidate(channel) {
  return {id:`twitch-${channel.toLowerCase()}`,provider:'twitch',channel,sourceUrl:`https://www.twitch.tv/${channel}`,live:true,castEligible:false,displayName:'TWITCH.TV'};
}
