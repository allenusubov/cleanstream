// Only metadata is cached. No video bytes or persistent paid services.
export class MetadataCache {
  constructor(max=150) { this.values=new Map();this.pending=new Map();this.max=max; }
  async get(key,ttl,load) {
    const hit=this.values.get(key);
    if(hit && hit.until>Date.now())return hit.value;
    if(this.pending.has(key))return this.pending.get(key);
    const job=Promise.resolve().then(load).then(value=>{
      this.values.set(key,{value,until:Date.now()+ttl});
      if(this.values.size>this.max)this.values.delete(this.values.keys().next().value);
      return value;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,job);return job;
  }
}
