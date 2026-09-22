'use strict';
const https = require('node:https');
const { BrokerError, fail } = require('./errors');
const E = require('./whatsapp-onboarding-contract');
const { tokenText } = require('./whatsapp-secrets');
const { GRAPH_VERSION } = require('./whatsapp-contract');
const { createWhatsappHttp } = require('./whatsapp-http');
const limits = require('./whatsapp-activation-limits');
function createActivationHttp({ request = https.request, timeoutMs = 8000, registrationTimeoutMs = limits.REGISTER_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(registrationTimeoutMs) || registrationTimeoutMs < 1 || registrationTimeoutMs > limits.REGISTER_TIMEOUT_MS) fail('invalid_request');
  const verification = createWhatsappHttp({ request, timeoutMs });
  return async input => {
    if (['inspect','phones','phone_state','waba_owner'].includes(input?.action)) return verification(input);
    const { action, id, token, proof, signal, pin } = input || {};
    if (!E.exact(input, ['action','id','token','proof','signal', ...(action === 'register_phone' ? ['pin'] : [])])
      || !['profile','subscriptions','subscribe','register_phone'].includes(action) || !E.id(id)
      || !Buffer.isBuffer(token) || !tokenText(token.toString('utf8')) || !/^[a-f0-9]{64}$/.test(proof)
      || action === 'register_phone' && (typeof pin !== 'string' || !/^\d{6}$/.test(pin))) fail('invalid_request');
    if (signal?.aborted) fail('provider_timeout');
    const query = new URLSearchParams({ appsecret_proof: proof });
    if (action === 'profile') query.set('fields', 'id,status,code_verification_status,quality_rating,is_on_biz_app,platform_type,display_phone_number,verified_name');
    if (action === 'subscriptions') query.set('limit', '100');
    const suffix = action === 'register_phone' ? '/register' : ['subscriptions','subscribe'].includes(action) ? '/subscribed_apps' : '';
    const body = action === 'register_phone' ? Buffer.from(JSON.stringify({ messaging_product: 'whatsapp', pin }))
      : action === 'subscribe' ? Buffer.from('{}') : null;
    return new Promise((resolve, reject) => {
      let req, timer, done = false;
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); body?.fill(0); error ? reject(error) : resolve(value); };
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      timer = setTimeout(abort, action === 'register_phone' ? registrationTimeoutMs : timeoutMs); timer.unref?.();
      try {
        req = request({ protocol:'https:', hostname:'graph.facebook.com', port:443, method:body ? 'POST' : 'GET',
          path:`/${GRAPH_VERSION}/${id}${suffix}?${query}`, agent:false, rejectUnauthorized:true, minVersion:'TLSv1.2',
          headers:{ authorization:'Bearer '+token.toString('utf8'), accept:'application/json', 'accept-encoding':'identity',
            ...(body ? {'content-type':'application/json','content-length':body.length} : {}) } }, res => {
          if (String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
            || !['','identity'].includes(String(res.headers['content-encoding'] || '').toLowerCase()) || res.statusCode >= 300 && res.statusCode < 400) {
            finish(new BrokerError('provider_failed')); res.destroy(); return;
          }
          const chunks=[]; let size=0;
          res.on('data', chunk => { size+=chunk.length; if(size>131072){finish(new BrokerError('provider_failed'));res.destroy();}else if(!done)chunks.push(chunk); });
          res.on('aborted',()=>finish(new BrokerError('provider_failed'))); res.on('error',()=>finish(new BrokerError('provider_failed')));
          res.on('end',()=>{if(done)return;try{
            const value=JSON.parse(Buffer.concat(chunks));
            if([190,102].includes(value?.error?.code))fail('credential_revoked');
            if([401,403].includes(res.statusCode)||[10,200].includes(value?.error?.code))fail('provider_unauthorized');
            if(res.statusCode!==200||value?.error){
              // Only a received provider rejection is known not to have applied.
              const error=new BrokerError('provider_failed'); error.providerRejected=res.statusCode>=400&&res.statusCode<500&&!!value?.error;
              throw error;
            }
            if(!value||typeof value!=='object'||Array.isArray(value))fail('provider_failed');
            finish(null,value);
          }catch(error){finish(error instanceof BrokerError?error:new BrokerError('provider_failed'));}});
        });
        req.on('error',()=>finish(new BrokerError('provider_failed'))); signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted||done)abort();else req.end(body||undefined);
      }catch{finish(new BrokerError('provider_failed'));req?.destroy();}
    });
  };
}
module.exports={createActivationHttp};
