'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {createMetaMarketingOAuthHttp}=require('../src/meta-marketing-oauth-http');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
function wire({status=200,headers={},response={},hold=false,error=false}={}) {
  const calls=[];let destroyed=0;
  return {calls,get destroyed(){return destroyed;},request(options,callback) {
    const req=new EventEmitter();req.destroy=()=>destroyed++;req.end=()=>{calls.push(options);if(hold)return;
      queueMicrotask(()=>{if(error)return req.emit('error',Error(APP));
        const res=new PassThrough();res.statusCode=status;res.headers={'content-type':'application/json',...headers};callback(res);res.end(typeof response==='string'?response:JSON.stringify(response));});
    };return req;
  }};
}
const input=f=>({binding:f.binding,code:Buffer.from('FICTITIOUS_OAUTH_CODE'),appSecret:Buffer.from(APP)});
for(const [name,setup] of [
  ['redirect',{status:302,headers:{location:'https://example.invalid'}}],['gzip',{headers:{'content-encoding':'gzip'}}],
  ['html',{headers:{'content-type':'text/html'}}],['oversized',{response:'x'.repeat(32769)}],['broken JSON',{response:'broken'}],
  ['array',{response:[]}],['error body',{response:{error:{message:APP}}}],['network',{error:true}],
  ['invalid token',{response:{access_token:'line\r\n'}}],['invalid expiry',{response:{access_token:TOKEN,expires_in:'3600'}}],
  ['unsupported token type',{response:{access_token:TOKEN,token_type:'mac'}}],
])test('code exchange rejects '+name+' without redirect/retry/credential leak',async t=>{
  const f=fixture(t),w=wire(setup);let works=0;
  await assert.rejects(createMetaMarketingOAuthHttp({request:w.request}).withExchangedToken(input(f),()=>{works++;return {};}),e=>!e.stack.includes(APP));
  assert.equal(w.calls.length,1);assert.equal(works,0);assert.equal(w.calls[0].hostname,'graph.facebook.com');
  assert.equal(w.calls[0].rejectUnauthorized,true);assert.equal(w.calls[0].minVersion,'TLSv1.2');assert.equal(w.calls[0].agent,false);
});
test('caller cancellation and deadline close code transport; pre-aborted input opens no connection',async t=>{
  const f=fixture(t),w=wire({hold:true}),controller=new AbortController(),http=createMetaMarketingOAuthHttp({request:w.request,timeoutMs:5});
  const work=http.withExchangedToken({...input(f),signal:controller.signal},()=>({}));controller.abort();await assert.rejects(work,{code:'provider_timeout'});
  await assert.rejects(http.withExchangedToken({...input(f),signal:controller.signal},()=>({})),{code:'provider_timeout'});assert.equal(w.calls.length,1);
  const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(http.withExchangedToken(input(f),()=>({})),{code:'provider_timeout'});}finally{clearTimeout(keepAlive);}
  assert(w.destroyed>=2);
});
test('borrowed token is zeroed after success, leaked output and cancellation while application/caller buffers are preserved',async t=>{
  const f=fixture(t);let borrowed;const args=input(f);
  assert.deepEqual(await f.http.withExchangedToken(args,(token,metadata)=>{borrowed=token;assert.equal(token.toString(),TOKEN);return {subjectId:metadata.subjectId};}),{subjectId:'201'});
  assert(borrowed.every(v=>v===0));assert.equal(args.appSecret.toString(),APP);assert.equal(args.code.toString(),'FICTITIOUS_OAUTH_CODE');
  await assert.rejects(f.http.withExchangedToken(args,token=>{borrowed=token;return {leak:token.toString()};}),{code:'provider_failed'});assert(borrowed.every(v=>v===0));
  const controller=new AbortController();await assert.rejects(f.http.withExchangedToken({...args,signal:controller.signal},token=>{borrowed=token;controller.abort();return {};}),{code:'provider_timeout'});
  assert(borrowed.every(v=>v===0));
});
