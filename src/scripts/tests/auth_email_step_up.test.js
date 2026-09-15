'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const events=[];const user={id_usuario:123,email_usuario:'qa@example.invalid',password_usuario:'FICTITIOUS_HASH',estado_cuenta:'activo'};
 const config={mode:'enforce',password:true,available:true};const controller={exports:{}};
 const deps={'dotenv':{config(){}},'bcryptjs':{compare:async(p,h)=>config.password&&p==='FICTITIOUS_PASSWORD'&&h===user.password_usuario},
 '../../models':{Usuario:{findByPk:async id=>{events.push(['user',id]);return id===123?user:null;}}},
 '../services/accessSession.service':{activeUser:u=>u?.estado_cuenta==='activo'},
 '../lib/blocked-auth-emails':{isBlockedAuthEmail:()=>false},
 '../services/authEmailChallenge.service':{mode:()=>config.mode,rejectedCredentials:async()=>events.push(['denied']),begin:async u=>{
  if(!config.available)throw Object.assign(Error('private_error'),{code:'auth_email_unavailable'});
  events.push(['challenge',u.id_usuario]);return {mfaRequired:true};}}};
 vm.runInNewContext(fs.readFileSync('src/controllers/auth.controllers.js','utf8'),{module:controller,exports:controller.exports,console:{error(){}},require:n=>deps[n]||{}});
 const call=async(body={password:'FICTITIOUS_PASSWORD'},userId=123)=>{const res={set(){return this;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
 await controller.exports.beginEmailStepUp({body,userData:{userId}},res);return res;};return{events,user,config,call};
}
test('step-up rechecks only the authenticated account password and always requests email',async()=>{
 const f=fixture();const r=await f.call();assert.equal(r.statusCode,202);assert.deepEqual(f.events,[['user',123],['challenge',123]]);assert.equal(r.body.mfaRequired,true);assert(!r.body.token);
});
test('wrong password, inactive account or another actor cannot obtain a code',async()=>{
 for(const kind of ['password','inactive','actor']){const f=fixture();if(kind==='password')f.config.password=false;if(kind==='inactive')f.user.estado_cuenta='inactivo';
 const r=await f.call(undefined,kind==='actor'?456:123);assert.equal(r.statusCode,400);assert.equal(r.body.error,'auth_password_rejected');assert(!f.events.some(v=>v[0]==='challenge'));}
});
test('the request cannot choose an account, trust cookie or arbitrary extra input',async()=>{
 for(const body of [{password:'FICTITIOUS_PASSWORD',userId:456},{password:'FICTITIOUS_PASSWORD',trustDevice:true},{password:''},{password:123},[],null]){
 const f=fixture();const r=await f.call(body);assert.equal(r.statusCode,400);assert.equal(f.events.length,0);}
});
test('missing MFA enforcement and unavailable durable email fail closed',async()=>{
 const f=fixture();f.config.mode='off';assert.equal((await f.call()).statusCode,503);assert.equal(f.events.length,0);
 f.config.mode='enforce';f.config.available=false;const r=await f.call();assert.equal(r.statusCode,503);assert(!JSON.stringify(r.body).includes('private_error'));
});
