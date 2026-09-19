'use strict';
const {randomUUID}=require('node:crypto'),{Op}=require('sequelize');
const R=require('./metaMarketingRevocation.contract');
const S=require('./metaMarketingBrokerScope.service');
const {fromRevocation}=require('../../services/platform-audit/src/meta-disconnect-event');
const {createRepository}=require('./platformAudit.repository');
const bounded=rows=>{if(!Array.isArray(rows)||rows.length>1000)R.fail();return rows;};
const conflict=()=>{throw Object.assign(Error('meta_revocation_shared_scope'),{code:'meta_revocation_shared_scope',httpStatus:409});};
const same=(a,b,keys)=>keys.every(k=>String(a[k])===String(b[k]));
const SAFE=new Set(['invalid_request','invalid_signature','scope_denied','operation_denied','connection_blocked','asset_revoked',
  'request_replayed','idempotency_conflict','outcome_unknown','rate_limited','audit_unavailable','broker_timeout','broker_unavailable',
  'broker_response_invalid','broker_configuration_invalid','meta_revocation_unavailable']);
const safe=error=>SAFE.has(error?.code)?error.code:'meta_revocation_unavailable';

// Caller owns the transaction and current, locked session/whole-scope authorization.
// No network I/O; intents, local exclusions and human audit commit together.
async function enqueue({models,transaction,scopeKey,clinicIds,actorId,sessionRef,now=new Date(),enabled=process.env.META_MARKETING_REVOCATION_ENABLED}){
  if(!transaction||enabled!=='true'||!S.positive(actorId)||!R.UUID.test(sessionRef))R.fail();
  const requested=R.scopeKey(scopeKey),allowed=R.ids(clinicIds),scopeType=requested.split(':')[0],scopeId=Number(requested.split(':')[1]);
  const lock={transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false,limit:1001};
  const initial=bounded(await models.MetaMarketingBrokerBinding.findAll({...lock,attributes:S.BINDING_FIELDS,where:{scope_key:requested},order:[['mapping_id','ASC']]})).map(S.binding);
  const history=bounded(await models.MetaMarketingBrokerRevocation.findAll({...lock,where:{scope_key:requested},order:[['tuple_hash','ASC']]})).map(R.validate);
  const refs=[...new Set([...initial.map(r=>r.asset_ref),...history.map(r=>r.asset_ref)])].sort();
  if(!refs.length)return {pending:0,confirmed:0};if(refs.length>200)R.fail();
  const records=bounded(await models.MetaMarketingBrokerBinding.findAll({...lock,attributes:S.BINDING_FIELDS,where:{asset_ref:{[Op.in]:refs}},order:[['mapping_id','ASC']]})).map(S.binding);
  const previous=bounded(await models.MetaMarketingBrokerRevocation.findAll({...lock,where:{asset_ref:{[Op.in]:refs}},order:[['tuple_hash','ASC']]})).map(R.validate);
  if(records.some(r=>r.scope_key!==requested||!allowed.includes(r.tenant_clinic_id))
    ||previous.some(r=>r.scope_key!==requested||R.storedIds(r.clinic_ids).some(id=>!allowed.includes(id))))conflict();
  const resources=refs.map(S.asset),registeredIds=R.ids([...records.map(r=>r.mapping_id),...previous.flatMap(r=>R.storedIds(r.mapping_ids))],true);
  const rows=bounded(await models.ClinicMetaAsset.findAll({...lock,attributes:S.MAPPING_FIELDS,order:[['id','ASC']],where:{[Op.or]:[
    ...resources.map(r=>({assetType:r.kind,metaAssetId:{[Op.in]:r.kind==='ad_account'?[r.id,'act_'+r.id]:[r.id]}})),
    ...(registeredIds.length?[{id:{[Op.in]:registeredIds}}]:[])]}}));
  const mappings=rows.map(S.mapping),allIds=R.ids([...registeredIds,...mappings.map(r=>r.mappingId)],true);
  const clinics=bounded(await models.Clinica.findAll({...lock,attributes:['id_clinica','grupoClinicaId'],where:scopeType==='group'?{grupoClinicaId:scopeId}:{id_clinica:scopeId},order:[['id_clinica','ASC']]}));
  if(JSON.stringify(R.ids(clinics.map(r=>r.id_clinica)))!==JSON.stringify(allowed))conflict();
  for(const row of mappings){
    if(row.active&&(row.assignmentScope==='group'&&(scopeType!=='group'||row.groupId!==scopeId)
      ||row.clinicId!==null&&!allowed.includes(row.clinicId)||row.groupId!==null&&clinics.some(c=>Number(c.grupoClinicaId)!==row.groupId)))conflict();
    const record=records.find(r=>r.mapping_id===row.mappingId);
    const old=previous.find(r=>R.storedIds(r.mapping_ids).includes(row.mappingId));
    if(record&&(record.asset_ref!==row.assetRef||record.meta_connection_id!==row.connectionId))R.fail();
    if(!record&&row.active&&(!old||old.asset_ref!==row.assetRef||Number(old.meta_connection_id)!==row.connectionId))R.fail();
  }
  const shares=allIds.length?bounded(await models.GroupAssetClinicAssignment.findAll({...lock,attributes:['assetType','assetId','clinicaId','grupoClinicaId'],
    where:{assetId:{[Op.in]:allIds},assetType:{[Op.in]:resources.map(r=>'meta.'+r.kind)}},order:[['id','ASC']]})):[];
  if(shares.some(r=>!allowed.includes(Number(r.clinicaId))||!allIds.includes(Number(r.assetId))
    ||!S.positive(r.grupoClinicaId)||clinics.some(c=>Number(c.grupoClinicaId)!==Number(r.grupoClinicaId))))conflict();
  for(const [kind,field] of [['facebook_page','facebook_primary_asset_id'],['instagram_business','instagram_primary_asset_id']]){
    const mappingIds=R.ids([...records.filter(r=>S.asset(r.asset_ref).kind===kind).map(r=>r.mapping_id),
      ...previous.filter(r=>S.asset(r.asset_ref).kind===kind).flatMap(r=>R.storedIds(r.mapping_ids)),...mappings.filter(r=>r.kind===kind).map(r=>r.mappingId)],true);
    if(!mappingIds.length)continue;
    const groups=bounded(await models.GrupoClinica.findAll({...lock,attributes:['id_grupo'],where:{[field]:{[Op.in]:mappingIds}},order:[['id_grupo','ASC']]}));
    for(const group of groups){
      if(scopeType==='group'&&Number(group.id_grupo)!==scopeId)conflict();
      const members=bounded(await models.Clinica.findAll({...lock,attributes:['id_clinica'],where:{grupoClinicaId:group.id_grupo},order:[['id_clinica','ASC']]}));
      if(!members.length||members.some(c=>!allowed.includes(Number(c.id_clinica))))conflict();
    }
  }
  const tuples=new Map(previous.map(r=>[r.tuple_hash,R.identity(r)]));
  for(const record of records){
    const value=R.identity({...record,tuple_hash:R.tupleHash(record)}),prior=tuples.get(value.tuple_hash);
    if(prior&&!same(prior,value,R.IDENTITY))R.fail();tuples.set(value.tuple_hash,value);
  }
  if(tuples.size>200)R.fail();
  const intents=[...tuples.values()].sort((a,b)=>a.tuple_hash.localeCompare(b.tuple_hash)).map(value=>{
    const old=previous.find(r=>r.tuple_hash===value.tuple_hash);
    const mappingIds=R.ids([...records.filter(r=>R.tupleHash(r)===value.tuple_hash).map(r=>r.mapping_id),...(old?R.storedIds(old.mapping_ids):[])]);
    if(old&&(JSON.stringify(mappingIds)!==old.mapping_ids||JSON.stringify(allowed)!==old.clinic_ids))R.fail();
    return old||R.validate({...value,scope_key:requested,clinic_ids:JSON.stringify(allowed),mapping_ids:JSON.stringify(mappingIds),
      request_id:randomUUID(),actor_user_id:Number(actorId),requested_at:now,next_attempt_at:now,state:'pending'});
  });
  const additions=intents.filter(r=>!previous.some(p=>p.tuple_hash===r.tuple_hash)),audit=createRepository(models.PlatformAuditEvent);
  if(additions.length){
    const health=await audit.health(now,{transaction,includeUnresolved:false});
    if(!Number.isSafeInteger(health.pending)||health.pending+additions.length>10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)R.fail();
    for(const row of additions){await models.MetaMarketingBrokerRevocation.create(row,{transaction,logging:false});await audit.append(fromRevocation(row,'attempted',now,sessionRef),{transaction});}
  }
  if(records.length)await models.MetaMarketingBrokerBinding.update({state:'blocked'},{where:{mapping_id:{[Op.in]:records.map(r=>r.mapping_id)}},transaction,logging:false});
  // Keep the shared Meta connection/assignment and every WhatsApp mapping intact.
  if(allIds.length)await models.ClinicMetaAsset.update({isActive:false},{where:{id:{[Op.in]:allIds},assetType:{[Op.in]:resources.map(r=>r.kind)}},transaction,logging:false});
  return {pending:intents.filter(r=>r.state==='pending').length,confirmed:intents.filter(r=>r.state==='confirmed').length};
}
function createRevocationRepository(models){
  const model=models.MetaMarketingBrokerRevocation,audit=createRepository(models.PlatformAuditEvent);
  return {
    claim:now=>models.sequelize.transaction(async transaction=>{
      const row=await model.findOne({where:{state:'pending',next_attempt_at:{[Op.lte]:now},[Op.or]:[{lease_until:null},{lease_until:{[Op.lt]:now}}]},
        transaction,lock:transaction.LOCK.UPDATE,skipLocked:true,order:[['requested_at','ASC'],['tuple_hash','ASC']],logging:false});
      if(!row)return null;
      await row.update({lease_token:randomUUID(),lease_until:new Date(now.getTime()+120000),attempts:Math.min(1000000000,Number(row.attempts)+1)},{transaction,logging:false});return row.get({plain:true});
    }),
    confirm:(claim,now)=>models.sequelize.transaction(async transaction=>{
      const row=await model.findByPk(claim.tuple_hash,{transaction,lock:transaction.LOCK.UPDATE,logging:false});
      if(!row||row.state!=='pending'||row.lease_token!==claim.lease_token||new Date(row.lease_until).getTime()<=now.getTime())return false;
      if(!same(row,claim,R.FIELDS)||new Date(row.requested_at).getTime()!==new Date(claim.requested_at).getTime())R.fail();
      await audit.append(fromRevocation(R.validate(row.get({plain:true})),'completed',now),{transaction});
      await row.update({state:'confirmed',confirmed_at:now,lease_token:null,lease_until:null,last_error:null},{transaction,logging:false});return true;
    }),
    retry:async(row,code,now)=>model.update({lease_token:null,lease_until:null,last_error:SAFE.has(code)?code:'meta_revocation_unavailable',
      next_attempt_at:new Date(now.getTime()+Math.min(3600000,1000*2**Math.min(Number(row.attempts),12)))},
      {where:{tuple_hash:row.tuple_hash,state:'pending',lease_token:row.lease_token},logging:false}),
    health:async()=>({pending:await model.count({where:{state:'pending'},logging:false})}),
  };
}
function createRevocationWorker({repository,client,enabled=()=>process.env.META_MARKETING_REVOCATION_WORKER_ENABLED==='true',now=()=>new Date()}){
  let running=false;
  return {async run({closing=()=>false}={}){
    if(!enabled()||running||closing())return {status:'completed',skipped:true,reason:'meta_revocation_worker_disabled_or_busy'};
    running=true;let confirmed=0,failed=0;
    try{
      const deadline=now().getTime()+30000;
      for(let n=0;n<20&&now().getTime()<deadline&&!closing();n++){
        const row=await repository.claim(now());if(!row)break;
        try{
          R.validate(row);const remaining=deadline-now().getTime();if(remaining<=0)throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});
          const result=await client.execute({requestId:row.request_id,operation:R.REVOKE,tenantRef:'clinic:'+row.tenant_clinic_id,connectionRef:row.connection_ref,assetRef:row.asset_ref,payload:{}},{timeoutMs:Math.min(10000,remaining)});
          if(result?.requestId!==row.request_id||!result.data||Object.keys(result.data).join(',')!=='revoked'||result.data.revoked!==true)throw Object.assign(Error('broker_response_invalid'),{code:'broker_response_invalid'});
          if(!await repository.confirm(row,now()))R.fail();confirmed++;
        }catch(error){failed++;await repository.retry(row,safe(error),now());}
      }
      return {status:failed?'failed':'completed',retryable:false,confirmed,failed,...await repository.health()};
    }catch(error){return {status:'failed',retryable:false,confirmed,failed,error:safe(error)};}finally{running=false;}
  }};
}
let worker;
module.exports={enqueue,createRevocationRepository,createRevocationWorker,safe,async assertLegacyDisconnectAllowed(models,connectionId){
  const connection=await models.MetaConnection.findByPk(connectionId,{attributes:['credentials_external'],raw:true,logging:false});
  if(Number(connection?.credentials_external)===1)throw Object.assign(Error('meta_marketing_scoped_revocation_required'),{code:'meta_marketing_scoped_revocation_required',httpStatus:409});
},async run(options){
  if(process.env.META_MARKETING_REVOCATION_WORKER_ENABLED!=='true'||process.env.RUNTIME_ROLE==='gateway')return {status:'completed',skipped:true,reason:'meta_revocation_worker_disabled'};
  worker||=createRevocationWorker({repository:createRevocationRepository(require('../../models')),
    client:require('./metaMarketingRevocationClient.service').client});return worker.run(options);
}};
