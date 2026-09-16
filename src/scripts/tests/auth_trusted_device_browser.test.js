'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/security_offline_runtime.cjs');
const T = require('../../services/authTrustedDevice.service');
const env = {DEV_SECURITY_PROFILE:'isolated-security-v2',RUNTIME_NAMESPACE:'dev',JOB_RUNTIME_NAMESPACE:'dev',QUEUE_PREFIX:'dev',DB_NAME:'clinicaclick_dev_isolated',EMAIL_PUBLIC_APP_URL:'http://localhost:4203'};
function request(headers={},extra={}) {
  const h={host:'127.0.0.1:3004',origin:'http://localhost:4203','sec-fetch-site':'same-origin',...headers};
  return {secure:false,headers:h,socket:{remoteAddress:'127.0.0.1'},get:k=>h[k],...extra};
}
test('isolated localhost can remember a browser with a distinct host-only HttpOnly cookie',()=>{
  const req=request();assert.equal(T.browserRequest(req,env),true);
  let saved;const res={cookie:(name,value,opts)=>{saved={name,value,opts}},clearCookie:(name,opts)=>{saved={name,opts}}};
  const device={token:'A'.repeat(43),expiresAt:new Date(Date.now()+60000)};
  T.setCookie(res,device,req,env);
  assert.equal(saved.name,T.DEV_COOKIE);assert.equal(saved.opts.secure,false);assert.equal(saved.opts.httpOnly,true);
  assert.equal(saved.opts.sameSite,'strict');assert.equal(saved.opts.path,'/');assert.equal(saved.opts.domain,undefined);
  assert.equal(T.cookie(request({cookie:T.DEV_COOKIE+'='+device.token}),env),device.token);
  assert.equal(T.cookie(request({cookie:T.COOKIE+'='+device.token}),env),null);
  assert.equal(T.cookie(request({cookie:T.DEV_COOKIE+'='+device.token+'; '+T.DEV_COOKIE+'='+device.token}),env),null);
  T.clearCookie(res,req,env);assert.equal(saved.name,T.DEV_COOKIE);assert.equal(saved.opts.secure,false);
});
test('localhost exception requires all isolation markers, exact origin, loopback transport and expected host',()=>{
  for(const key of Object.keys(env))assert.equal(T.browserRequest(request(),{...env,[key]:'wrong'}),false,key);
  for(const headers of [{origin:undefined},{origin:'http://localhost:4200'},{origin:'http://localhost:4203.evil.invalid'},{host:'crm.clinicaclick.com'},{'sec-fetch-site':'cross-site'}])assert.equal(T.browserRequest(request(headers),env),false);
  assert.equal(T.browserRequest(request({},{socket:{remoteAddress:'203.0.113.5'}}),env),false);
  assert.equal(T.browserRequest(request(),{}),false);
  const alt={...env,EMAIL_PUBLIC_APP_URL:'http://localhost:4200'};
  assert.equal(T.browserRequest(request({origin:alt.EMAIL_PUBLIC_APP_URL}),alt),true);
});
test('public runtime retains HTTPS and its Secure cookie, never accepting the DEV cookie',()=>{
  const req=request({host:'crm.example.invalid',origin:'https://crm.example.invalid'},{secure:true});
  assert.equal(T.browserRequest(req,{}),true);
  assert.equal(T.browserRequest({...req,secure:false},{}),false);
  assert.equal(T.browserRequest(request({host:'crm.example.invalid',origin:'https://evil.invalid'},{secure:true}),{}),false);
  let saved;T.setCookie({cookie:(name,value,opts)=>{saved={name,opts}}},{token:'A'.repeat(43),expiresAt:new Date(Date.now()+60000)},req,{});
  assert.equal(saved.name,T.COOKIE);assert.equal(saved.opts.secure,true);
  req.headers.cookie=T.DEV_COOKIE+'='+'A'.repeat(43);assert.equal(T.cookie(req,{}),null);
});
