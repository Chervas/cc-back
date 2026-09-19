'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
module.exports = async ({ models, sql, report, broker, mapping, context, input, repository, delivery, deliveryIdentity, activeSince, now }) => {
  const migration = require('../../../../migrations/20260918235000-index-google-receipt-review');
  await migration.up(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
  models.PlatformAuditEvent = require('../../../../models/platformauditevent')(sql,D); await models.PlatformAuditEvent.sync();
  models.UsuarioClinica = sql.define('UsuarioClinica', { id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING }, { timestamps:false });
  await models.UsuarioClinica.sync();
  const role = require('../../../lib/role-helpers').MARKETING_WRITE_ROLES[0];
  await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91002,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
  // The real shared-account ACL must include the sibling clinic.
  await models.GroupAssetClinicAssignment.findOrCreate({where:{assetType:'google.ads_account',assetId:mapping.id,clinicaId:71},defaults:{grupoClinicaId:5}});
  context = await broker.prepare(mapping);
  const events = require('../../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const env = { GOOGLE_ADS_BROKER_ENABLED:'true',GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED:'true',GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED:'true',
    GOOGLE_ADS_BROKER_AUDIENCE:deliveryIdentity.audience,GOOGLE_ADS_BROKER_KEY_ID:deliveryIdentity.keyId,GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE:activeSince };
  let sessionValid = true, allowed = true, remoteCalls = 0, hook, afterAppend, auditFailure, state = 'SUCCESS';
  const sessions = { verifyReference:async()=>{if(!sessionValid)throw Object.assign(Error('PRIVATE'),{status:401});},
    bearer: value=>value, verify: async()=>({sessionVersion:1,userId:91002,jti:actor.sessionRef,exp:actor.expiresAt/1000}) };
  const audit = { health:(...args)=>events.health(...args), append:async(value,options)=>{
    if(auditFailure===value.stage)throw Error('PRIVATE'); const result=await events.append(value,options); await afterAppend?.(value); return result;
  } };
  const wrapped = { ...broker, conversion:async(account,ctx,family,payload,options)=>{
    assert.equal(family,'reconcile'); assert.equal(await options.beforeExecute(),true);
    assert.equal(Object.keys(payload).join(','),'submissionId');
    const admitted=await models.PlatformAuditEvent.findOne({where:{correlation_id:options.requestId,stage:'attempted'},raw:true});assert(admitted);
    remoteCalls++; await hook?.();
    const row=await models.GoogleConversionSubmission.findByPk(payload.submissionId,{raw:true});
    const raw = {submissionId:row.submission_id,requestId:row.provider_request_id,requestStatusPerDestination:[{destination:{
      operatingAccount:{accountType:'GOOGLE_ADS',accountId:mapping.customerId},loginAccount:{accountType:'GOOGLE_ADS',accountId:mapping.loginCustomerId},
      productDestinationId:row.conversion_action_id},requestStatus:state,eventsIngestionStatus:{recordCount:'1'}}]};
    return {...raw,...require('../../../../services/integrations-broker/src/google-data-manager-contract').statusResult(raw,{customerId:mapping.customerId,loginCustomerId:mapping.loginCustomerId,destination:{conversionActionId:row.conversion_action_id}})};
  } };
  const actor={userId:91002,sessionRef:randomUUID(),expiresAt:Math.floor(now()/1000)*1000+3600000};
  const ctx={actor,scopeKey:'group:5',runtime:{deliveryMode:'broker',broker:wrapped,brokerContext:context,account:mapping},beforeExecute:async()=>allowed};
  const create = ()=>require('../../../services/googleConversionReceiptReview.service').createGoogleConversionReceiptReview({models,sessions,audit,env,now});
  let service=create(); const run=(family,value,requestId=randomUUID(),c=ctx)=>service.execute(c,family,value,{requestId});
  const check=id=>run('check',{submissionId:id});
  const record=async(sent=true)=>{const value={...await input(),context};return sent?delivery.submit(value):repository.reserve(value);};
  const local=await record(false); const sent=await record();
  const localResult=await check(local.submissionId);assert.equal(localResult.mode,'not_sent');assert.equal(remoteCalls,0);
  report.checks.push('manual review of prepared receipt never dispatches; user read attempt and completion are durable in real SQL');
  await models.Clinica.update({estado_clinica:false},{where:{id_clinica:71}});
  const id=randomUUID(), done=await run('check',{submissionId:sent.submissionId},id);assert.equal(done.item.state,'succeeded');assert.equal(remoteCalls,1);
  assert.deepEqual(Object.keys(done.item).sort(),['submissionId','eventName','conversionActionId','state','createdAt','updatedAt','canCheck'].sort());
  service=create(); await assert.rejects(run('check',{submissionId:sent.submissionId},id),{code:'google_receipt_request_conflict'});assert.equal(remoteCalls,1);
  assert.equal((await check(sent.submissionId)).mode,'stored');assert.equal(remoteCalls,1);
  await models.Clinica.update({estado_clinica:true},{where:{id_clinica:71}});
  report.checks.push('explicit manual read remains allowed during clinical pause; result is persisted, survives service restart, cannot replay UUID, and terminal read is local');
  const auditBefore=await models.PlatformAuditEvent.count();env.GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED='false';
  await assert.rejects(check(local.submissionId),{code:'broker_cohort_disabled'});env.GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED='true';
  sessionValid=false;await assert.rejects(check(local.submissionId),{code:'google_receipt_session_required'});sessionValid=true;
  allowed=false;await assert.rejects(check(local.submissionId),{code:'scope_denied'});allowed=true;
  await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_usuario:91002,id_clinica:71}});
  await assert.rejects(check(local.submissionId),{code:'scope_denied'});
  await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_usuario:91002,id_clinica:71}});
  assert.equal(await models.PlatformAuditEvent.count(),auditBefore);
  report.checks.push('disabled cohort, revoked managed session, scope denial and missing sibling-clinic membership all stop before read admission');
  const uncertain=await record();const prior=remoteCalls;
  auditFailure='attempted';await assert.rejects(check(uncertain.submissionId),{code:'audit_unavailable'});assert.equal(remoteCalls,prior);
  auditFailure='completed';const failedId=randomUUID();await assert.rejects(run('check',{submissionId:uncertain.submissionId},failedId),{code:'audit_unavailable'});
  assert.equal((await models.GoogleConversionSubmission.findByPk(uncertain.submissionId)).state,'accepted');
  assert.equal(await models.PlatformAuditEvent.count({where:{correlation_id:failedId}}),1);auditFailure=null;
  assert.equal((await check(uncertain.submissionId)).item.state,'succeeded');
  report.checks.push('attempt capture failure prevents remote read; completion failure rolls back CRM receipt and leaves one durable unresolved attempt; explicit later read recovers');
  const raced=await record();hook=()=>{sessionValid=false;};
  await assert.rejects(check(raced.submissionId),{code:'google_receipt_session_required'});hook=null;sessionValid=true;
  assert.equal((await models.GoogleConversionSubmission.findByPk(raced.submissionId)).state,'accepted');
  hook=()=>models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_usuario:91002,id_clinica:71}});
  await assert.rejects(check(raced.submissionId),{code:'scope_denied'});hook=null;
  await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_usuario:91002,id_clinica:71}});
  afterAppend=v=>{if(v.stage==='completed')allowed=false;};
  await assert.rejects(check(raced.submissionId),{code:'scope_denied'});afterAppend=null;allowed=true;
  assert.equal((await models.GoogleConversionSubmission.findByPk(raced.submissionId)).state,'accepted');
  report.checks.push('session and membership revocation during remote read, plus permission loss during completion audit, suppress result and roll back local changes');
  hook=()=>{env.GOOGLE_ADS_BROKER_KEY_ID='different';};await assert.rejects(check(raced.submissionId),{code:'broker_configuration_invalid'});hook=null;env.GOOGLE_ADS_BROKER_KEY_ID=deliveryIdentity.keyId;
  hook=()=>{throw Object.assign(Error('PRIVATE'),{code:'outcome_unknown'});};await assert.rejects(check(raced.submissionId),{code:'outcome_unknown'});hook=null;
  report.checks.push('delivery key changes and missing broker proof never adopt a receipt or fall back to resend');
  const terminalRace=await record(); const racingRow=await models.GoogleConversionSubmission.findByPk(terminalRace.submissionId,{raw:true});
  state='PROCESSING';hook=async()=>{
    const raw={requestStatusPerDestination:[{destination:{operatingAccount:{accountType:'GOOGLE_ADS',accountId:mapping.customerId},
      loginAccount:{accountType:'GOOGLE_ADS',accountId:mapping.loginCustomerId},productDestinationId:racingRow.conversion_action_id},
      requestStatus:'SUCCESS',eventsIngestionStatus:{recordCount:1}}]};
    await repository.reconcile({account:mapping,context,attemptId:racingRow.attempt_id,submissionId:racingRow.submission_id},
      {submissionId:racingRow.submission_id,requestId:racingRow.provider_request_id,...require('../../../../services/integrations-broker/src/google-data-manager-contract').statusResult(raw,
        {customerId:mapping.customerId,loginCustomerId:mapping.loginCustomerId,destination:{conversionActionId:racingRow.conversion_action_id}})});
  };
  assert.equal((await check(terminalRace.submissionId)).item.state,'succeeded');hook=null;state='SUCCESS';
  report.checks.push('an automatic terminal result arriving during manual provider latency is never downgraded by a late PROCESSING response');
  for(let i=0;i<23;i++)await record(false);
  const beforeReads=remoteCalls;const seen=[];let cursor=null;let pages=0;
  do { const p=await run('list',{cursor});assert(p.items.length<=20);seen.push(...p.items.map(v=>v.submissionId));cursor=p.nextCursor;pages++; } while(cursor);
  assert(pages>=2);assert(await models.GoogleConversionSubmission.count()>seen.length);assert.equal(new Set(seen).size,seen.length);assert(seen.includes(local.submissionId));assert.equal(remoteCalls,beforeReads);
  const statements=[];models.GoogleConversionSubmission.addHook('beforeFind','review-projection',opts=>{if(opts.limit===21){assert.equal(opts.raw,true);assert.equal(opts.attributes.includes('provider_request_id'),false);opts.logging=s=>statements.push(s);}});
  await run('list',{cursor:null});models.GoogleConversionSubmission.removeHook('beforeFind','review-projection');
  assert(statements.some(s=>s.includes('FORCE INDEX (`cc_google_receipt_review`)')&&s.includes('LIMIT 21')&&!s.includes('OFFSET')));
  const select=statements.find(s=>s.includes('SELECT')).replace(/^Executing \([^)]*\): /,'');
  const [explain]=await sql.query('EXPLAIN '+select);assert.equal(explain[0].key,'cc_google_receipt_review');assert(!explain[0].Extra?.includes('filesort'));
  require('node:fs').writeFileSync(require('node:path').join(report.root,'google-receipt-review-explain.json'),JSON.stringify(explain,null,2),{mode:0o600});
  report.checks.push('real SQL keyset pagination is bounded to 21 index rows, has no OFFSET/filesort or broker reads, and no duplicate receipt across pages');
  await assert.rejects(run('list',{cursor:{createdAt:'bad',submissionId:randomUUID()}}),{code:'invalid_request'});
  await assert.rejects(check(randomUUID()),{code:'google_receipt_not_found'});
  const listId=randomUUID();await run('list',{cursor:null},listId);await assert.rejects(run('list',{cursor:null},listId),{code:'google_receipt_request_conflict'});
  const {requested,createRouter}=require('../../../routes/googleConversionReceipts.routes');
  const body={group_id:5,customer_id:mapping.customerId,request_id:randomUUID(),cursor:null};
  for(const patch of [{provider_request_id:'forged'},{clinic_id:59},{request_id:'bad'}])assert.throws(()=>requested({body:{...body,...patch},query:{}},'list'));
  const router=createRouter({models,sessions,resolveRuntime:async()=>ctx.runtime,review:service});
  const http=async(path,body)=>{let status,headers={};return new Promise((resolve,reject)=>router.handle({method:'POST',url:path,originalUrl:path,headers:{authorization:'fictitious'},body,query:{}},
    {set:(k,v)=>{headers[k]=v;},status(v){status=v;return this;},json(v){resolve({status,headers,body:v});}},reject));};
  const response=await http('/list',{...body,request_id:randomUUID()});assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'private, no-store');assert.equal(response.body.success,true);
  const denied=await http('/list',{...body,clinic_id:59});assert.equal(denied.status,400);assert.deepEqual(denied.body,{success:false,error:'invalid_request'});
  report.checks.push('Express route resolves managed scope, returns private no-store DTO, rejects forged IDs, query fields, mixed scopes and duplicate list requests');
  const all=await models.PlatformAuditEvent.findAll({raw:true});assert(all.length>10);all.forEach(v=>assert.equal(require('../../../../services/platform-audit/src/event').unpack(v).event.version,19));
  const dump=JSON.stringify(all);for(const secret of ['FICTITIOUS-CLICK','FICTITIOUS-PRIVATE-DETAIL','fictitious-receipt-','accessToken','userIdentifiers'])assert(!dump.includes(secret));
  report.receiptReview={remoteReads:remoteCalls,auditEvents:all.length,auditBodyBytes:all.reduce((n,v)=>n+Buffer.byteLength(v.body),0),maxAuditBodyBytes:Math.max(...all.map(v=>Buffer.byteLength(v.body))),listedReceipts:seen.length,pages};
};
