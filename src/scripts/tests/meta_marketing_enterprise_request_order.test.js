'use strict';
// Production request entrypoints + real scope authorization. No model index,
// SQL transport, credential material or broker operation is permitted.
const test=require('node:test'),assert=require('node:assert/strict');
const modelFile=require.resolve('../../../models');require.cache[modelFile]={id:modelFile,filename:modelFile,loaded:true,exports:{}};
const UUID=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
const closed=()=>{throw Error('ENTERPRISE_TRANSPORT_FORBIDDEN');};global.fetch=closed;require('node:net').Socket.prototype.connect=closed;
for(const family of ['Business','CredentialRenewal']){
  function fixture(){
    const state={sessions:0,hints:0,hydrations:0,enrollmentLocks:0,provider:0,writes:0,denyAt:0,trace:[]};
    const enrollment={enrollment_id:UUID(1),flow_id:UUID(2),scope_key:'clinic:95',app_id:'101'};
    const journal=family==='Business'?{handover_id:UUID(3),old_enrollment_id:UUID(1),scope_key:'clinic:95',app_id:'101'}
      :{renewal_id:UUID(3),enrollment_id:UUID(1),scope_key:'clinic:95',app_id:'101'};
    const matches=where=>Object.entries(where).every(([key,value])=>enrollment[key]===value);
    const models={sequelize:{transaction:async(_options,work)=>{const transaction={LOCK:{UPDATE:'UPDATE'}};try{return await work(transaction);}finally{transaction.finished='closed';}}},
      Clinica:{findAll:async options=>{assert(options.lock);state.trace.push('clinic');return[{id_clinica:95}];}},
      UsuarioClinica:{findAll:async options=>{assert(options.lock);return[{id_clinica:95}];}},
      MetaMarketingEnrollmentRequest:{findByPk:async(id,options)=>{if(options?.lock){state.enrollmentLocks++;state.trace.push('enrollment');}return id===UUID(1)?{...enrollment}:null;},findOne:async options=>matches(options.where)?{...enrollment}:null},
      MetaMarketingOAuthRequest:{},MetaMarketingBusinessHandover:{findByPk:async(id,options)=>{if(id===UUID(2))return null;if(options.lock){state.hydrations++;state.trace.push('journal');}else state.hints++;return id===UUID(3)?{...journal}:null;}}};
    if(family==='CredentialRenewal')models.MetaMarketingCredentialRenewal={findByPk:models.MetaMarketingBusinessHandover.findByPk};
    models.PlatformAuditEvent={sequelize:models.sequelize};
    const sessions={verifyReference:async(_reference,options)=>{assert.equal(options.requireEmail,true);assert(options.transaction);state.sessions++;state.trace.push('session');if(state.sessions===state.denyAt)throw Object.assign(Error('auth_invalid'),{code:'auth_invalid'});}};
    const service=require('../../services/metaMarketing'+family+'.service').createService({models,sessions,client:{execute:async()=>{state.provider++;closed();}},audit:{},drain:{},enabled:()=>true});
    return{state,service,input:{scopeKey:'clinic:95',actorId:225,sessionRef:UUID(4),sessionExpiresAt:new Date('2030-01-01')}};
  }
  test(family+' human request denies before hints and repeats fresh session after Enrollment prefix, before journal hydration',async()=>{
    for(const denyAt of [1,2]){
      const f=fixture();f.state.denyAt=denyAt;
      await assert.rejects(()=>f.service.reconcile(f.input,UUID(3)),{code:'meta_oauth_session_required'});
      assert.equal(f.state.hints,denyAt===1?0:1);assert.equal(f.state.enrollmentLocks,denyAt===1?0:1);
      assert.equal(f.state.hydrations,0);assert.equal(f.state.provider,0);assert.equal(f.state.writes,0);
      if(denyAt===2)assert(f.state.trace.indexOf('enrollment')<f.state.trace.lastIndexOf('session'));
    }
  });
}
