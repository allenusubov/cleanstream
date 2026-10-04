let sdk;
function loadSDK() {
  if(window.YT?.Player)return Promise.resolve();
  return sdk ||= new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{sdk=null;reject(new Error('YOUTUBE_UNAVAILABLE'));},12000);
    const previous=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{clearTimeout(timer);previous?.();resolve();};
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';
    script.onerror=()=>{clearTimeout(timer);sdk=null;reject(new Error('YOUTUBE_UNAVAILABLE'));};
    document.head.append(script);
  });
}
export class YouTubePlayer {
  constructor(container,onChange,onError) {this.container=container;this.onChange=onChange;this.onError=onError;this.player=null;this.live=false;this.token=0;}
  destroy() {this.token++;this.player?.destroy();this.player=null;this.container.replaceChildren();this.container.hidden=true;}
  async load(item,signal) {
    this.destroy();const token=this.token;await loadSDK();
    if(signal.aborted||token!==this.token)throw new DOMException('Cancelled','AbortError');
    this.live=item.live===true;this.container.hidden=false;
    const mount=document.createElement('div');this.container.append(mount);
    await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
      const abort=()=>{this.destroy();finish(new DOMException('Cancelled','AbortError'));};
      const timer=setTimeout(()=>finish(new Error('YOUTUBE_UNAVAILABLE')),14000);
      signal.addEventListener('abort',abort,{once:true});
      this.player=new YT.Player(mount,{videoId:item.videoId,width:'100%',height:'100%',
        playerVars:{autoplay:1,playsinline:1,origin:location.origin,rel:0},
        events:{onReady:()=>{if(token!==this.token)return;finish();this.player.playVideo();this.onChange();},
          onStateChange:()=>{if(token!==this.token)return;this.onChange();},
          onError:e=>{if(token!==this.token)return;const error=new Error([101,150].includes(e.data)?'YOUTUBE_EMBED_BLOCKED':'YOUTUBE_UNAVAILABLE');if(settled)this.onError(error);else finish(error);}}});
    });
  }
  get paused(){return this.player?.getPlayerState?.()!==1;}
  get buffering(){return this.player?.getPlayerState?.()===3;}
  get muted(){return Boolean(this.player?.isMuted?.());}
  get time(){return this.player?.getCurrentTime?.()||0;}
  get target(){const d=this.player?.getDuration?.();return this.live && d>0?Math.max(0,d-2):null;}
  play(){this.player?.playVideo();}
  pause(){this.player?.pauseVideo();}
  mute(){this.muted?this.player?.unMute():this.player?.mute();}
  jump(){if(this.target!==null){this.player.seekTo(this.target,true);this.play();}}
}
