export function excludedPlatform(value){
  try{
    const host=new URL(value).hostname.toLowerCase();
    return ['youtube.com','youtu.be','youtube-nocookie.com','googlevideo.com','twitch.tv','twitchcdn.net','ttvnw.net'].some(root=>host===root||host.endsWith('.'+root));
  }catch{return false;}
}
export function aggregatorEvent(event){
  return Boolean(event&&event.contentType!=='tvm'&&!['movie','tv'].includes(event.kind)&&
    !['youtube','twitch'].includes(event.provider));
}
