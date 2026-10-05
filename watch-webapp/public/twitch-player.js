let sdk;
function loadSDK() {
  if(window.Twitch?.Player)return Promise.resolve();
  return sdk ||= new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{sdk=null;reject(new Error('TWITCH_UNAVAILABLE'));},12000);
    const script=document.createElement('script');
    script.src='https://player.twitch.tv/js/embed/v1.js';
    script.onload=()=>{clearTimeout(timer);window.Twitch?.Player?resolve():reject(new Error('TWITCH_UNAVAILABLE'));};
    script.onerror=()=>{clearTimeout(timer);sdk=null;reject(new Error('TWITCH_UNAVAILABLE'));};
    document.head.append(script);
  });
}
export class TwitchPlayer {
  constructor(container,onChange,onError){this.container=container;this.onChange=onChange;this.onError=onError;this.player=null;this.channel='';this.token=0;}
  destroy(){this.token++;this.player=null;this.channel='';this.container.replaceChildren();this.container.hidden=true;}
  async load(item,signal){
    this.destroy();const token=this.token;await loadSDK();
    if(signal.aborted||token!==this.token)throw new DOMException('Cancelled','AbortError');
    this.channel=item.channel;this.container.hidden=false;
    const mount=document.createElement('div');mount.id=`twitch-${Date.now()}-${Math.random().toString(36).slice(2)}`;this.container.append(mount);
    await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
      const abort=()=>{this.destroy();finish(new DOMException('Cancelled','AbortError'));};
      const timer=setTimeout(()=>finish(new Error('TWITCH_UNAVAILABLE')),14000);
      signal.addEventListener('abort',abort,{once:true});
      try{
        this.player=new Twitch.Player(mount.id,{channel:item.channel,width:'100%',height:'100%',autoplay:true,muted:false,parent:[location.hostname]});
        this.player.addEventListener(Twitch.Player.READY,()=>{if(token!==this.token)return;finish();this.player.play();this.onChange();});
        for(const eventName of [Twitch.Player.PLAY,Twitch.Player.PLAYING,Twitch.Player.PAUSE,Twitch.Player.SEEK,Twitch.Player.ONLINE]){
          this.player.addEventListener(eventName,()=>{if(token===this.token)this.onChange();});
        }
        this.player.addEventListener(Twitch.Player.OFFLINE,()=>{if(token===this.token)this.onError(new Error('TWITCH_UNAVAILABLE'));});
      }catch{finish(new Error('TWITCH_UNAVAILABLE'));}
    });
  }
  get paused(){return this.player?.isPaused?.()??true;}
  get buffering(){return false;}
  get muted(){return Boolean(this.player?.getMuted?.());}
  play(){this.player?.play?.();}
  pause(){this.player?.pause?.();}
  mute(){this.player?.setMuted?.(!this.muted);}
  jump(){if(!this.player||!this.channel)return;this.player.setChannel(this.channel);this.player.play();}
}
