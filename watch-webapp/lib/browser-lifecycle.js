import {AppError} from './network.js';
import {aborted,abortable} from './discovery-control.js';

// Share startup across callers, but never keep a rejected launch or dead browser.
export class ReusableBrowser {
  constructor(launch){this.launch=launch;this.pending=null;this.currentBrowser=null;}
  forget(pending){if(this.pending===pending){this.pending=null;this.currentBrowser=null;}}
  async get(signal){
    aborted(signal);
    if(!this.pending){
      const pending=Promise.resolve().then(()=>this.launch()).then(browser=>{
        this.currentBrowser=browser;
        browser.once('disconnected',()=>this.forget(pending));
        return browser;
      }).catch(cause=>{
        this.forget(pending);
        const error=new AppError('BROWSER_UNAVAILABLE',503);error.cause=cause;throw error;
      });
      this.pending=pending;
    }
    const pending=this.pending;
    const browser=await abortable(pending,signal);
    if(!browser.isConnected()){
      this.forget(pending);
      const error=new AppError('BROWSER_UNAVAILABLE',503);
      error.cause=new Error('Extraction browser disconnected during startup');throw error;
    }
    return browser;
  }
  async context(options,signal){
    for(let attempt=0;attempt<2;attempt++){
      const browser=await this.get(signal);
      try{
        // Do not abandon a created context when cancellation races newContext.
        const context=await browser.newContext(options);
        if(signal?.aborted){await context.close().catch(()=>{});aborted(signal);}
        return context;
      }catch(cause){
        aborted(signal);
        if(browser.isConnected())throw cause;
        if(this.currentBrowser===browser){this.pending=null;this.currentBrowser=null;}
        if(attempt===0)continue;
        const error=new AppError('BROWSER_UNAVAILABLE',503);error.cause=cause;throw error;
      }
    }
  }
}
