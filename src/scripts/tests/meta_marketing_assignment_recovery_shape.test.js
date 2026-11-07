'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module');require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const filename=path.resolve(__dirname,'../../services/metaMarketingEnrollmentAuthority.service.js'),actual=createRequire(filename);
function fixture(group=29){
 const clinicIds=group===28?[1,70]:[66,72],clinics=clinicIds.map(id_clinica=>({id_clinica,grupoClinicaId:group}));
 const grants=group===28?[
  {id:11,scopeKey:'clinic:1',assignmentScope:'clinic',clinicaId:1,grupoClinicaId:28,metaConnectionId:158,status:'disconnected'},
  {id:17,scopeKey:'group:28',assignmentScope:'group',clinicaId:null,grupoClinicaId:28,metaConnectionId:158,status:'active'}
 ]:[{id:13,scopeKey:'clinic:66',assignmentScope:'clinic',clinicaId:66,grupoClinicaId:null,metaConnectionId:158,status:'active'},
  {id:18,scopeKey:'group:29',assignmentScope:'group',clinicaId:null,grupoClinicaId:29,metaConnectionId:158,status:'active'},
  {id:29,scopeKey:'clinic:72',assignmentScope:'clinic',clinicaId:72,grupoClinicaId:29,metaConnectionId:158,status:'active'}];
 const row={scope_key:'group:'+group,clinic_ids:JSON.stringify(clinicIds)},proof={version:2,scopeKey:'group:'+group,clinicIds,sourceConnectionId:158};
 const models={Clinica:{findAll:async()=>clinics},MetaConnectionAssignment:{findAll:async()=>grants},GrupoClinica:{findAll:async()=>[{id_grupo:group}]}};
 const loaded={exports:{}};const requireClosed=name=>{
  if(name==='./metaMarketingOAuthScope.service')return {createScope:()=>({})};
  if(name==='./platformAudit.repository')return {createRepository:()=>({})};
  assert(!/models(?:\/index)?$|app\.js|dotenv/.test(name));return actual(name);
 };
 const source=fs.readFileSync(filename,'utf8').replace('return {reserve,assertPending};','return {reserve,assertPending,assignments};');
 vm.runInNewContext(source,{require:requireClosed,module:loaded,exports:loaded.exports,process,JSON,structuredClone},{filename});
 const authority=loaded.exports.createAuthority({models,sessions:{},oauth:{},recoveryGuard:{}});
 return {clinics,grants,row,proof,run:value=>authority.assignments(row,172,{LOCK:{UPDATE:'UPDATE'}},value)};
}
test('actual assignments accepts only the consistent pinned V2 clinic/group legacy shape without changing any grant',async()=>{
 const f=fixture(),before=JSON.stringify(f.grants),digest=await f.run(f.proof);
 assert.match(digest,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(f.grants),before);
});
test('non-recovery, V1, foreign scope/source/group, inactive or duplicated redundant grants still reject',async()=>{
 for(const mutate of [f=>f.proof=null,f=>f.proof.version=1,f=>f.proof.scopeKey='group:28',f=>f.proof.clinicIds=[72],
  f=>f.proof.sourceConnectionId=999,f=>f.grants[2].grupoClinicaId=28,f=>f.grants[2].metaConnectionId=999,
  f=>f.grants[2].scopeKey='clinic:66',f=>f.grants[2].status='inactive',f=>f.grants[1].clinicaId=72,
  f=>{f.grants[0]={...f.grants[2],id:30};}]){
  const f=fixture();mutate(f);await assert.rejects(f.run(f.proof),{code:'meta_enrollment_scope_changed',httpStatus:409});
 }
});
test('Root-pinned Arriaga shape preserves the disconnected WhatsApp clinic grant and rejects unreviewed variants',async()=>{
 const f=fixture(28),before=JSON.stringify(f.grants);assert.match(await f.run(f.proof),/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(f.grants),before);assert.equal(f.grants[0].status,'disconnected');
 for(const mutate of [p=>p.proof=null,p=>p.proof.version=1,p=>p.proof.sourceConnectionId=999,
  p=>p.grants[0].metaConnectionId=999,p=>p.grants[0].grupoClinicaId=29,p=>p.clinics[0].grupoClinicaId=29,
  p=>p.grants.push({...p.grants[0],id:30}),...['revoked','reauthorization_required','unknown'].map(status=>p=>p.grants[0].status=status)]){
  const p=fixture(28);mutate(p);await assert.rejects(p.run(p.proof),{code:'meta_enrollment_scope_changed',httpStatus:409});
 }
});
test('canonical legacy grants retain existing non-recovery/V1 checks',async()=>{
 for(const proof of [null,{version:1,scopeKey:'group:29',clinicIds:[66,72],sourceConnectionId:158}]){
  const f=fixture();f.grants[2].grupoClinicaId=null;
  if(proof)await f.run(proof);else await assert.rejects(f.run(null),{code:'meta_enrollment_assignment_review',httpStatus:409});
 }
});
