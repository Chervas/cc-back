'use strict';
const https=require('node:https'),dns=require('node:dns').promises;
const {createHash}=require('node:crypto');
const {fail,BrokerError}=require('./errors');
const {publicAddress}=require('./whatsapp-template-media');
const C=require('./whatsapp-authorized-contract'),E=require('./whatsapp-onboarding-contract');
const {GRAPH_VERSION}=require('./whatsapp-contract');
const READ='meta.whatsapp.authorized.media.read.v1';
const MAX=32*1024*1024;
function validate(p){if(!C.keys(p,['authorizationId','phoneId','mediaId'])||!E.uuid(p.authorizationId)||!E.id(p.phoneId)||!E.id(p.mediaId))fail('invalid_request');return p;}
function project(r){
 if(!C.keys(r,['id','mimeType','sha256','size','base64'])||!E.id(r.id)||typeof r.mimeType!=='string'||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(r.mimeType)
   ||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<1||r.size>MAX||typeof r.base64!=='string'||r.base64.length!==4*Math.ceil(r.size/3))fail('provider_failed');
 return r;
}
function mediaUrl(value){
 let u;try{u=new URL(value);}catch{fail('provider_failed');}
 // Only Meta's authenticated media origin. Never accept a caller URL, forward
 // a credential to a redirect or return the temporary provider URL to CRM.
 if(u.protocol!=='https:'||u.hostname!=='lookaside.fbsbx.com'||u.port||u.username||u.password||u.hash)fail('provider_failed');return u;
}
function createDownloader({request=https.request,lookup=dns.lookup}={}){
 const get=async(url,token,signal,max)=>{
  const addresses=await lookup(url.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))fail('provider_failed');
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(err,result)=>{if(done)return;done=true;err?reject(err):resolve(result);};
   const address=addresses[0];
   const req=request(url,{method:'GET',signal,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',
    lookup:(_h,o,cb)=>o?.all?cb(null,[address]):cb(null,address.address,address.family),
    headers:{authorization:'Bearer '+token.toString('utf8'),'accept-encoding':'identity'}},res=>{
     if(res.statusCode!==200||!['','identity'].includes(String(res.headers['content-encoding']||''))||Number(res.headers['content-length']||0)>max){finish(new BrokerError('provider_failed'));res.destroy();return;}
     const chunks=[];let bytes=0;
     res.on('data',b=>{bytes+=b.length;if(bytes>max){finish(new BrokerError('provider_failed'));res.destroy();}else chunks.push(b);});
     res.on('error',()=>finish(new BrokerError('provider_failed')));res.on('aborted',()=>finish(new BrokerError('provider_failed')));
     res.on('end',()=>finish(null,Buffer.concat(chunks)));
    });
   req.setTimeout(12000,()=>{finish(new BrokerError('provider_timeout'));req.destroy();});req.on('error',()=>finish(new BrokerError('provider_failed')));req.end();
  });
 };
 return async({mediaId,phoneId,token,proof,signal,assertActive})=>{
  const query=new URLSearchParams({phone_number_id:phoneId,appsecret_proof:proof});
  assertActive();const raw=await get(new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}?${query}`),token,signal,65536);
  let info;try{info=JSON.parse(raw.toString('utf8'));}catch{fail('provider_failed');}finally{raw.fill(0);}
  const size=Number(info.file_size);
  if(info.id!==mediaId||!Number.isSafeInteger(size)||size<1||size>MAX)fail('provider_failed');
  const url=mediaUrl(info.url);assertActive();const body=await get(url,token,signal,MAX);
  try{
   const digest=createHash('sha256').update(body).digest();
   const expected=/^[a-fA-F0-9]{64}$/.test(info.sha256||'')?Buffer.from(info.sha256,'hex'):Buffer.from(info.sha256||'','base64');
   if(body.length!==size||expected.length!==32||!expected.equals(digest))fail('provider_failed');
   assertActive();return project({id:mediaId,mimeType:String(info.mime_type||'').split(';')[0].trim().toLowerCase(),sha256:digest.toString('hex'),size,base64:body.toString('base64')});
  }finally{body.fill(0);}
 };
}
function operation({secrets,registry,download=createDownloader()}){return Object.freeze({provider:C.PROVIDER,effect:'read',persistResult:false,
 validate,authorize:input=>registry.authorize(input),project,
 async execute({payload,binding,secret,signal,assertActive}){
  const value=registry.assert(binding);
  if(payload.phoneId!==value.definition.phoneId||payload.authorizationId!==value.definition.authorizationId)fail('scope_denied');
  return download({...payload,token:secret,proof:secrets.proof(secret,binding.connectionRef),signal,assertActive:()=>{assertActive();registry.assert(binding);}});
 }});}
module.exports={READ,MAX,validate,project,mediaUrl,createDownloader,operation};
