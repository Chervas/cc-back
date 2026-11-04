'use strict';
const {BrokerError,fail}=require('./errors');
// Separate, opt-in provider state. Never reuse authentication rate_windows:
// its expiry sweep would erase a multi-hour provider cooldown.
function sqliteState(db){
  db.exec('CREATE TABLE IF NOT EXISTS meta_marketing_ads_pacing (scope TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL,pause_until INTEGER NOT NULL)');
  return {load:scope=>db.prepare('SELECT next_allowed_at,pause_until FROM meta_marketing_ads_pacing WHERE scope=?').get(scope)||{next_allowed_at:0,pause_until:0},
    save:(scope,value)=>db.prepare('INSERT INTO meta_marketing_ads_pacing VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET next_allowed_at=MAX(next_allowed_at,excluded.next_allowed_at),pause_until=MAX(pause_until,excluded.pause_until)').run(scope,value.next_allowed_at,value.pause_until)};
}
function createPacing({state,now=Date.now,wait=(ms,signal)=>new Promise((resolve,reject)=>{
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new BrokerError('provider_timeout'));};
  const timer=setTimeout(done,ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
}),minDelayMs=1000,cooldownMs=7200000}={}){
  if(typeof state?.load!=='function'||typeof state?.save!=='function'||!Number.isInteger(minDelayMs)||minDelayMs<1000||!Number.isInteger(cooldownMs)||cooldownMs<7200000)fail('invalid_request');
  let tail=Promise.resolve();
  const denied=remaining=>{const e=new BrokerError('rate_limited');e.retryAfterMs=Math.max(1,Math.ceil(remaining));throw e;};
  const snapshot=scope=>{const v=state.load(scope);if(!v||!Number.isSafeInteger(v.next_allowed_at)||!Number.isSafeInteger(v.pause_until)||v.next_allowed_at<0||v.pause_until<0)fail('internal_error');return v;};
  return {snapshot,async run(scope,{signal,deadline},request){
    if(typeof scope!=='string'||!scope||typeof request!=='function'||!Number.isSafeInteger(deadline))fail('invalid_request');
    const old=tail;let release;tail=new Promise(resolve=>{release=resolve;});
    try{
      await old;if(signal?.aborted)fail('provider_timeout');let v=snapshot(scope),at=now();
      if(v.pause_until>at)denied(v.pause_until-at);
      const delay=Math.max(0,v.next_allowed_at-at);if(at+delay+1000>=deadline)denied(Math.max(delay,1000));
      if(delay)await wait(delay,signal);if(signal?.aborted||now()>=deadline)fail('provider_timeout');
      v=snapshot(scope);if(v.pause_until>now())denied(v.pause_until-now());
      state.save(scope,{next_allowed_at:now()+minDelayMs,pause_until:v.pause_until});
      try{return await request();}catch(error){if(error?.code==='rate_limited'){const latest=snapshot(scope);state.save(scope,{next_allowed_at:latest.next_allowed_at,pause_until:now()+cooldownMs});}throw error;}
    }finally{release();}
  },observe(scope,usagePct){if(!Number.isFinite(usagePct)||usagePct<0||usagePct>100)fail('provider_failed');const v=snapshot(scope);if(usagePct>=90)state.save(scope,{next_allowed_at:v.next_allowed_at,pause_until:now()+cooldownMs});},
    usage(scope,usagePct){const v=snapshot(scope);return {usagePct,nextAllowedAt:v.next_allowed_at,pauseUntil:v.pause_until};}};
}
module.exports={createPacing,sqliteState};
