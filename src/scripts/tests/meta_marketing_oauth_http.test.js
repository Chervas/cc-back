'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomUUID}=require('node:crypto');
const express=require('express'),{loadDiscoverySource,unusedMetaSurfaceDependencies}=require('./fixtures/business_profile_discovery.fixture');
const {connectionForTestServer}=require('./fixtures/campaign_offline_runtime.cjs');
const C=require('../../services/metaMarketingOAuth.contract');
test('Mounted OAuth router preserves authentication and uses the same configured origin for successful and rejected callbacks',async t=>{
  const previous=process.env.FRONTEND_URL;process.env.FRONTEND_URL='https://dev.example.invalid/configured/path';
  t.after(()=>{if(previous===undefined)delete process.env.FRONTEND_URL;else process.env.FRONTEND_URL=previous;});
  const id=randomUUID(),sessionRef=randomUUID();let callbacks=0,statuses=0,enrollmentReads=0;
  const sessions={bearer:v=>{if(v!=='Bearer FICTITIOUS_JWT')throw Object.assign(Error(),{name:'JsonWebTokenError'});return 'FICTITIOUS_JWT';},
    verify:async v=>{if(v!=='FICTITIOUS_JWT')throw Object.assign(Error(),{name:'JsonWebTokenError'});return {userId:91002,sessionVersion:1,jti:sessionRef,exp:Math.floor(Date.now()/1000)+600};}};
  const service={callback:async({state})=>{callbacks++;if(state!=='FICTITIOUS_STATE')throw Error('FICTITIOUS_PRIVATE_ERROR');return {requestId:id,returnOrigin:C.frontendOrigin()};},
    status:async input=>{statuses++;assert.equal(input.scopeKey,'group:5');return {enabled:false};}};
  const auth=loadDiscoverySource('routes/auth.middleware.js',{'../services/accessSession.service':sessions});
  const router=loadDiscoverySource('routes/oauth.routes.js',{...unusedMetaSurfaceDependencies(),express,sequelize:require('sequelize'),'../../models':{},'./auth.middleware':auth,
    '../services/accessSession.service':sessions,'./metaMarketingOAuth.routes':{createRouter:options=>{
      assert.equal(options.returnOrigin,undefined,'Legacy hardcoded frontend origin must not override the configured OAuth origin');
      return require('../../routes/metaMarketingOAuth.routes').createRouter({...options,service});
    }},'./metaMarketingEnrollment.routes':{createRouter:options=>require('../../routes/metaMarketingEnrollment.routes').createRouter({...options,service:{overview:async input=>{
      enrollmentReads++;assert.equal(input.scopeKey,'group:5');return {enabled:false,canSelect:false,selection:null};
    }}})}});
  const app=express();app.use('/oauth',router);const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const agent=new http.Agent({keepAlive:false});agent.createConnection=connectionForTestServer(server);
  t.after(()=>new Promise(r=>{agent.destroy();server.close(r);server.closeAllConnections();}));
  const request=(path,authenticated=false)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,agent,path:'/oauth'+path,headers:authenticated?{authorization:'Bearer FICTITIOUS_JWT'}:{}},res=>{
      let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end();
  });
  const endpoint='/meta/marketing/authorization?assignment_scope=group&group_id=5';
  assert.equal((await request(endpoint)).status,401);assert.equal(statuses,0);assert.equal((await request(endpoint,true)).status,200);assert.equal(statuses,1);
  const enrollmentEndpoint='/meta/marketing/enrollment?assignment_scope=group&group_id=5';
  assert.equal((await request(enrollmentEndpoint)).status,401);assert.equal(enrollmentReads,0);
  const selection=await request(enrollmentEndpoint,true);assert.equal(selection.status,200);assert.match(selection.headers['cache-control'],/no-store/);assert.equal(enrollmentReads,1);
  const good=await request('/meta/marketing/callback?state=FICTITIOUS_STATE&code=FICTITIOUS_CODE');
  assert.equal(good.status,303);assert.equal(good.headers.location,'https://dev.example.invalid/pages/settings?meta_authorization='+id);
  assert.match(good.headers['cache-control'],/no-store/);assert.equal(good.headers['referrer-policy'],'no-referrer');
  for(const query of ['state=unknown&code=FICTITIOUS_CODE','state=FICTITIOUS_STATE&code=FICTITIOUS_CODE&redirect_uri=https://foreign.example.invalid']){
    const bad=await request('/meta/marketing/callback?'+query);assert.equal(bad.status,303);assert.equal(bad.headers.location,'https://dev.example.invalid/pages/settings?meta_authorization_error=1');
    assert(!bad.body.includes('FICTITIOUS_PRIVATE_ERROR'));assert(!bad.headers.location.includes('FICTITIOUS_CODE'));
  }
  assert.equal(callbacks,2);assert.equal((await request('/meta/marketing/callback/extra?state=FICTITIOUS_STATE')).status,401);
});
