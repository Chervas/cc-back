'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{createHash}=require('node:crypto');
const M=require('../src/whatsapp-inbound-media');
const bytes=Buffer.from('synthetic media'),sha=createHash('sha256').update(bytes).digest('hex');
function setup(change={}){
 const calls=[];
 const request=(url,options,cb)=>{const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
  calls.push({url,options});const res=new PassThrough();res.destroy=()=>{};res.headers={};res.statusCode=change.status||200;cb(res);
  res.end(calls.length===1?JSON.stringify({id:'123',url:'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123',file_size:bytes.length,sha256:sha,mime_type:'audio/ogg',...change.info}):bytes);
 });return req;};
 return {calls,download:M.createDownloader({request,lookup:async()=>[{address:change.address||'31.13.1.1',family:4}]})};
}
const input=()=>({mediaId:'123',phoneId:'456',token:Buffer.from('synthetic-token'),proof:'a'.repeat(64),assertActive:()=>{}});
test('downloads only selected phone media, checks integrity and returns neither URL nor credential',async()=>{
 const f=setup(),result=await f.download(input());assert.equal(result.base64,bytes.toString('base64'));
 assert.equal(f.calls[0].url.searchParams.get('phone_number_id'),'456');assert.equal(f.calls.length,2);
 assert(!JSON.stringify(result).includes('synthetic-token'));assert(!JSON.stringify(result).includes('https:'));
 assert.equal(f.calls[1].options.headers.authorization,'Bearer synthetic-token');
});
test('rejects redirects, foreign/private origins, wrong media, oversized payload and digest mismatch',async()=>{
 for(const change of [{status:302},{address:'127.0.0.1'},{info:{url:'https://evil.invalid/media'}},{info:{url:'https://lookaside.fbsbx.com@evil.invalid/media'}},{info:{id:'999'}},{info:{file_size:M.MAX+1}},{info:{sha256:'b'.repeat(64)}}])await assert.rejects(setup(change).download(input()));
});
test('scoped request cannot supply arbitrary URL or override token; revoked binding prevents reading',async()=>{
 const p={authorizationId:'a1234567-1234-4234-8234-123456789abc',phoneId:'456',mediaId:'123'};
 M.validate(p);for(const more of [{source:'https://evil.invalid'},{token:'unsafe'},{mediaId:'../123'}])assert.throws(()=>M.validate({...p,...more}));
 let downloaded=false;const op=M.operation({secrets:{proof:()=>''},registry:{assert:()=>{throw Error('revoked');}},download:()=>{downloaded=true;}});
 assert.equal(op.persistResult,false);await assert.rejects(op.execute({payload:p}));assert.equal(downloaded,false);
});
