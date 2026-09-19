'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize'),fs=require('node:fs'),path=require('node:path');
const C=require('../../../services/metaMarketingEnrollment.contract');
module.exports=async({models,sql,sessions,service,callback,token,now,report,wire,f,mfa,advance,restart,auditView,app,server,base})=>{
  const qi=sql.getQueryInterface();await require('../../../../migrations/20260919080000-meta-marketing-enrollment-journal').up(qi);
  const delivery=require('../../../../migrations/20260919100000-meta-marketing-enrollment-delivery-markers');await delivery.up(qi);await delivery.down(qi);await delivery.up(qi);
  const owner=require('../../../../migrations/20260919090000-meta-marketing-enrollment-binding-owner');await owner.down(qi);await owner.up(qi);
  const due=require('../../../../migrations/20260919110000-meta-marketing-enrollment-due-index');await due.up(qi);await due.down(qi);await due.up(qi);
  for(const [name,file] of [['MetaMarketingEnrollmentRequest','metamarketingenrollmentrequest'],['MetaMarketingEnrollmentClaim','metamarketingenrollmentclaim'],['MetaMarketingEnrollmentIdentity','metamarketingenrollmentidentity']])models[name]=require('../../../../models/'+file)(sql,D);
  const R=models.MetaMarketingEnrollmentRequest,inputFor=async()=>{const claims=await sessions.verify(token());return {scopeKey:'group:5',actorId:claims.userId,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)};};
  let enabled=true,workerEnabled=true,lostReply=null,beforeWire=null,afterWire=null;const commands=[];
  const enrollment=require('../../../services/metaMarketingEnrollment.service').createService({models,sessions,oauth:service,now,enabled:()=>enabled,workerEnabled:()=>workerEnabled,
    client:{execute:async(command,budget)=>{commands.push({operation:command.operation,requestId:command.requestId});await beforeWire?.(command);const response=await wire.execute(command,budget);await afterWire?.(command);
      if(lostReply===command.operation){lostReply=null;throw Object.assign(Error('FICTITIOUS_LOST_RESPONSE'),{code:'broker_timeout'});}return response;}}});
  const input=await inputFor(),flow=await service.begin(input);await callback(flow);
  const reserved=await enrollment.reserve(input,flow.requestId,['meta-ad_account:301','meta-instagram_business:501']);
  const id=reserved.requestId,latest=()=>R.findByPk(id,{raw:true}),run=()=>enrollment.run({enrollmentId:id});
  if(process.env.META_ENROLLMENT_RUNTIME_CASE==='query_health'){
    const original=await latest(),future=new Date(+now()+86400000);
    for(let offset=0;offset<11000;offset+=250)await R.bulkCreate(Array.from({length:250},(_,n)=>({...original,
      enrollment_id:randomUUID(),flow_id:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),
      state:offset+n<10000?'revoked':'prepared',revoked_at:offset+n<10000?now():null,next_attempt_at:offset+n<10000?now():future})));
    const transaction=await sql.transaction();
    try{
      const bind={now:now().toISOString().slice(0,23).replace('T',' ')},query=require('../../../services/metaMarketingEnrollment.service').claimSql();
      const [plan]=await sql.query('EXPLAIN FORMAT=JSON '+query,{bind,transaction});
      const tree=JSON.parse(plan[0].EXPLAIN),text=JSON.stringify(tree);assert(text.includes('cc_meta_enroll_due'));assert(!text.includes('"using_filesort":true'));
      const at=Date.now(),[rows]=await sql.query(query,{bind,transaction});assert.deepEqual(rows.map(v=>v.enrollment_id),[id]);
      report.enrollmentQueue={terminalRows:10000,futureRows:1000,elapsedMs:Date.now()-at,plan:tree};
    }finally{await transaction.rollback();}
  }
  assert.equal(reserved.connected,false);assert.equal(await models.MetaConnectionAssignment.count(),0);assert.equal(await models.ClinicMetaAsset.count(),0);
  workerEnabled=false;assert.equal((await run()).skipped,true);assert.equal(commands.length,0);workerEnabled=true;
  beforeWire=()=>{throw Object.assign(Error('FICTITIOUS_CONTROL_UNAVAILABLE'),{code:'broker_unavailable'});};
  assert.equal((await run()).failed,1);beforeWire=null;assert.equal((await latest()).prepare_sent_at,null);advance(3000);
  const ready=await run();assert.equal(ready.failed,0,JSON.stringify(ready));const prepared=await latest();assert.equal(prepared.state,'prepared');assert(prepared.prepare_sent_at);
  await assert.rejects(delivery.down(qi),/Preserve Meta enrollment delivery/);
  assert.equal(commands.filter(v=>v.operation===C.E.OPERATIONS.prepare).length,1);
  advance(31000);const locked=await sql.transaction();
  try{await R.findByPk(id,{transaction:locked,lock:locked.LOCK.UPDATE});const at=Date.now();assert.equal((await enrollment.run()).advanced,0);assert(Date.now()-at<1500,'Real FOR UPDATE SKIP LOCKED must skip another owner without waiting for its transaction');}
  finally{await locked.rollback();}
  const confirmation=await enrollment.confirm(input,id,prepared.selection_digest);assert.equal(confirmation.state,'activate_pending');assert.equal(confirmation.connected,false);
  assert.equal((await enrollment.confirm(input,id,prepared.selection_digest)).state,'activate_pending');
  const events=async()=>models.PlatformAuditEvent.findAll({attributes:['body','result_part'],raw:true}).then(v=>v.map(r=>({...JSON.parse(r.body),part:r.result_part})).filter(v=>v.version===24));
  assert.deepEqual((await events()).map(v=>v.part).sort(),[1,2,3]);
  report.checks.push('Actual reserve/prepare/human confirmation with SQL session and broker HTTPS; durable send marker, three distinct human phases, no clinical grants before remote activation');
  report.checks.push('Disabled worker performs no I/O; failure before prepare delivery remains retryable; real locked MySQL row is skipped without waiting or acquiring a second lease');

  if(['uncertain','permission_race','foreign_primary','foreign_share','wa_grant'].includes(process.env.META_ENROLLMENT_RUNTIME_CASE)){
    const mode=process.env.META_ENROLLMENT_RUNTIME_CASE;
    if(mode==='uncertain')beforeWire=command=>{if(command.operation===C.E.OPERATIONS.activate)throw Object.assign(Error('FICTITIOUS_UNCERTAIN_DELIVERY'),{code:'broker_timeout'});};
    else if(mode==='permission_race')afterWire=async command=>{if(command.operation===C.E.OPERATIONS.activate)await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});};
    else if(mode==='wa_grant')await models.ClinicMetaAsset.create({metaConnectionId:(await latest()).meta_connection_id,assignmentScope:'clinic',clinicaId:88,assetType:'whatsapp_phone_number',metaAssetId:'701',isActive:true,waAccessToken:'FICTITIOUS_SHARED_WA_CREDENTIAL'});
    else{
      const [[counter]]=await sql.query("SELECT AUTO_INCREMENT AS nextId FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ClinicMetaAssets'");
      if(mode==='foreign_primary')await models.GrupoClinica.update({instagram_primary_asset_id:Number(counter.nextId)+1},{where:{id_grupo:6}});
      else await models.GroupAssetClinicAssignment.create({assetId:Number(counter.nextId),assetType:'meta.ad_account',grupoClinicaId:6,clinicaId:88});
    }
    assert.equal((await run()).failed,1);beforeWire=null;afterWire=null;advance(130000);
    if(mode==='uncertain'){
      assert.equal((await run()).failed,0);assert.equal((await latest()).state,'activate_pending');assert.equal((await latest()).last_error,'meta_enrollment_activation_uncertain');
      assert.equal(commands.filter(v=>v.operation===C.E.OPERATIONS.activate).length,1);await enrollment.cancel(input,id);
    }else assert.equal((await latest()).state,'revoke_pending');
    assert.equal(await models.ClinicMetaAsset.count(),mode==='wa_grant'?1:0);assert.equal(await models.MetaConnectionAssignment.count(),0);
    if(mode==='wa_grant'){const wa=await models.ClinicMetaAsset.findOne({where:{assetType:'whatsapp_phone_number'}});assert.equal(wa.isActive,true);assert.equal(wa.waAccessToken,'FICTITIOUS_SHARED_WA_CREDENTIAL');}
    enabled=false;await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});assert.equal((await run()).failed,0);assert.equal((await latest()).state,'revoked');
    assert.equal((await models.MetaMarketingOAuthRequest.findByPk(flow.requestId)).state,'cancel_pending');assert.equal((await service.run()).failed,0);assert.equal((await models.MetaMarketingOAuthRequest.findByPk(flow.requestId)).state,'cancelled');
    assert.deepEqual((await events()).map(v=>v.part).sort(),[1,2,3,5,6]);assert.equal(await models.MetaMarketingEnrollmentClaim.count(),3);
    report.checks.push(mode==='uncertain'?'Unknown delivery with broker still prepared never reactivates automatically or claims clinical success; cancellation remains available after gate closure/logout':
      mode==='permission_race'?'Permission loss after actual remote activation rolls back all clinical writes and queues independent withdrawal; cancellation finishes after logout with no connected audit event':
      'Final writer rejects '+mode+' without clinical grants, preserving existing data; remote selection and source candidate are both retired through control after logout');
    report.enrollmentRuntime={scenario:mode,commands,activationCalls:commands.filter(v=>v.operation===C.E.OPERATIONS.activate).length};
    return;
  }

  lostReply=C.E.OPERATIONS.activate;assert.equal((await run()).failed,1);assert.equal((await latest()).state,'activate_pending');assert((await latest()).activate_sent_at);
  assert.equal(await models.ClinicMetaAsset.count(),0);assert.equal(await models.MetaConnectionAssignment.count(),0);await restart();advance(130000);
  models.PlatformAuditEvent.addHook('beforeCreate','qa-activation-audit-failure',row=>{if(JSON.parse(row.body).reason==='meta_enrollment_activated')throw Error('FICTITIOUS_FINAL_AUDIT_FAILURE');});
  try{assert.equal((await run()).failed,1);assert.equal((await latest()).state,'activate_pending');assert.equal(await models.ClinicMetaAsset.count(),0);assert.equal(await models.MetaMarketingBrokerBinding.count(),0);assert.equal(await models.MetaConnectionAssignment.count(),0);}
  finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-activation-audit-failure');}
  advance(130000);const success=await run();assert.equal(success.failed,0,JSON.stringify(success));const active=await latest();assert.equal(active.state,'active');
  assert.equal(commands.filter(v=>v.operation===C.E.OPERATIONS.activate).length,1);
  const mappings=await models.ClinicMetaAsset.findAll({raw:true});assert.equal(mappings.length,2);assert(mappings.every(v=>v.clinicaId===null&&v.grupoClinicaId===5&&v.assignmentScope==='group'&&v.pageAccessToken===null&&v.waAccessToken===null&&v.additionalData===null));
  assert.equal(await models.MetaConnectionAssignment.count(),1);assert.equal(await models.MetaMarketingEnrollmentClaim.count(),3);
  assert.equal((await models.GrupoClinica.findByPk(5)).facebook_primary_asset_id,null);
  await assert.rejects(owner.down(qi),/Preserve enrollment ownership/);
  assert.deepEqual((await events()).map(v=>v.part).sort(),[1,2,3,4]);
  report.checks.push('Lost activation response and actual broker restart recover by status without another activate; failed final audit rolls back mappings/grant/bindings and subsequent status commits one canonical group row per asset');

  const readerKey=path.join(f.dir,'reader-live.pem');fs.writeFileSync(readerKey,f.reader.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const broker=require('../../../services/metaMarketingBrokerReader.service'),scope=require('../../../services/metaMarketingBrokerScope.service');
  const reader=broker.createMetaMarketingBroker({client:broker.createConfiguredMetaMarketingClient({env:{META_MARKETING_BROKER_ORIGIN:'https://127.0.0.1:'+f.config.port,
    META_MARKETING_BROKER_AUDIENCE:f.policy.audience,META_MARKETING_BROKER_KEY_ID:'qa-reader',META_MARKETING_BROKER_KEY_FILE:readerKey,META_MARKETING_BROKER_CA_FILE:f.config.tlsCertFile}}),
    ...scope.createMetaMarketingScopeRepository(()=>models),enabled:()=>true});
  const mappingId=mappings.find(v=>v.assetType==='ad_account').id;
  const read=async()=>reader.read(await reader.prepare(mappingId),require('../../../../services/integrations-broker/src/meta-marketing-contract').ASSET,{authorize:async captured=>{
    const fresh=await sessions.verify(token());assert.equal(fresh.userId,91002);assert.deepEqual(captured.clinicIds,[59,71]);}});
  assert.equal((await read()).id,'act_301');
  await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});await mfa();assert.equal((await enrollment.status(await inputFor(),id)).connected,true);assert.equal((await read()).id,'act_301');
  const foreign=await models.Clinica.findByPk(88);await foreign.update({grupoClinicaId:5});
  try{await assert.rejects(reader.prepare(mappingId));}finally{await foreign.update({grupoClinicaId:6});}
  const sibling=mappings.find(v=>v.assetType==='instagram_business');await models.MetaMarketingBrokerBinding.update({state:'blocked'},{where:{mapping_id:sibling.id}});
  try{await assert.rejects(reader.prepare(mappingId));}finally{await models.MetaMarketingBrokerBinding.update({state:'active'},{where:{mapping_id:sibling.id}});}
  const share=await models.GroupAssetClinicAssignment.create({assetId:sibling.id,assetType:'meta.instagram_business',grupoClinicaId:6,clinicaId:88});
  try{await assert.rejects(reader.prepare(mappingId));}finally{await share.destroy();}
  const claim=await models.MetaMarketingEnrollmentClaim.findByPk('meta-facebook_page:401');await claim.destroy();
  try{await assert.rejects(reader.prepare(mappingId));}finally{await models.MetaMarketingEnrollmentClaim.create({asset_ref:'meta-facebook_page:401',enrollment_id:id,created_at:now()});}
  assert.equal((await read()).id,'act_301');
  report.checks.push('Actual signed CRM asset read after final commit; new MFA session preserves confirmed connection, but added group member, sibling block, foreign share and missing IG parent claim deny the whole selection before broker access');

  enabled=false;const cancelled=await enrollment.cancel(await inputFor(),id);assert.equal(cancelled.state,'revoke_pending');assert.equal(cancelled.connected,false);
  assert.equal(await models.ClinicMetaAsset.count({where:{isActive:true}}),0);assert.equal(await models.MetaConnectionAssignment.count(),1);
  await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});advance(1);const withdrawn=await run();assert.equal(withdrawn.failed,0,JSON.stringify(withdrawn));assert.equal((await latest()).state,'revoked');
  assert.equal((await models.MetaMarketingOAuthRequest.findByPk(flow.requestId)).state,'cancel_pending');assert.equal((await service.run()).failed,0);assert.equal((await models.MetaMarketingOAuthRequest.findByPk(flow.requestId)).state,'cancelled');
  assert.equal(await models.MetaMarketingEnrollmentClaim.count(),3);assert.equal(await models.MetaMarketingEnrollmentIdentity.count(),1);
  assert.deepEqual((await events()).map(v=>v.part).sort(),[1,2,3,4,5,6]);await assert.rejects(reader.prepare(mappingId));
  const [[retired]]=await sql.query('SELECT delivery_due_at FROM MetaMarketingEnrollmentRequests WHERE enrollment_id=$id',{bind:{id}});assert.equal(retired.delivery_due_at,null);
  if(report.enrollmentQueue)report.checks.push('Actual claim uses a due-time range without filesort among 10,000 terminal and 1,000 future requests; global worker skips a locked due row and confirmed retirement leaves the due range');
  report.checks.push('Fresh authorized cancellation immediately blocks local assets without deleting shared connection grants; independent worker confirms revoke after logout and gate closure, retaining all six phases and physical ownership');
  report.enrollmentRuntime={commands,activeMappings:2,canonicalGroup:true,activationCalls:commands.filter(v=>v.operation===C.E.OPERATIONS.activate).length};
  await mfa();await auditView.verify(token());
  if(process.env.META_OAUTH_CRM_VISUAL==='1')await require('./meta_enrollment_visual.fixture')({app,server,token,auditView,base,report});
};
