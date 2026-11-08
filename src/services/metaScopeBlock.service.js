'use strict';
const { Op } = require('sequelize');
const RETIRE_FIELDS={recovery:['recovery_id','scope_key','clinic_ids','app_id','flow_id','enrollment_id','snapshot_digest','state'],business:['handover_id','scope_key','clinic_ids','app_id','old_enrollment_id','new_enrollment_id','state','retired_at']};
const validatedRetirements=new WeakMap();
const id = value => /^[1-9][0-9]{0,9}$/.test(String(value)) && Number(value) <= 2147483647 ? Number(value) : null;
function unavailable() { throw Object.assign(Error('meta_security_state_unavailable'), { code: 'meta_security_state_unavailable', httpStatus: 503 }); }
async function blocked(scope, { models = require('../../models'), transaction, purpose = 'meta' } = {}) {
  try {
    if (!['meta', 'whatsapp'].includes(purpose)) unavailable();
    const keys = [];
    const options = { raw: true, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) };
    if (scope?.assignmentScope === 'clinic' && id(scope.clinicId)) {
      keys.push('clinic:' + id(scope.clinicId));
      const clinic = await models.Clinica.findByPk(id(scope.clinicId), { ...options, attributes: ['grupoClinicaId'] });
      if (!clinic) unavailable();
      if (id(clinic.grupoClinicaId)) keys.push('group:' + id(clinic.grupoClinicaId));
    } else if (scope?.assignmentScope === 'group' && id(scope.groupId)) {
      keys.push('group:' + id(scope.groupId));
      const clinics = await models.Clinica.findAll({ ...options, where: { grupoClinicaId: id(scope.groupId) }, attributes: ['id_clinica'] });
      for (const clinic of clinics) { if (!id(clinic.id_clinica)) unavailable(); keys.push('clinic:' + id(clinic.id_clinica)); }
    } else unavailable();
    // Unprefixed tombstones always block every Meta integration, including WA.
    // An explicitly reviewed `meta:` tombstone preserves the non-WA block
    // when a customer reauthorizes WhatsApp independently. OAuth itself never
    // removes or narrows a tombstone; new disconnections remain universal.
    if (purpose === 'meta') keys.push(...keys.map(key => 'meta:' + key));
    return !!await models.MetaScopeBlock.findOne({ ...options, attributes: ['scope_key'], where: { scope_key: { [Op.in]: keys } } });
  } catch { unavailable(); }
}
function scopeKeyOf(scope){return scope?.assignmentScope==='group'&&id(scope.groupId)?'group:'+id(scope.groupId):scope?.assignmentScope==='clinic'&&id(scope.clinicId)?'clinic:'+id(scope.clinicId):null;}
const rowTuple=(row,fields)=>JSON.stringify(fields.map(field=>row?.[field] instanceof Date?row[field].toISOString():row?.[field]));
async function prepareRetirement({scope,clinicIds,models=require('../../models')}){
  const scopeKey=scopeKeyOf(scope);if(!scopeKey||!Array.isArray(clinicIds)||clinicIds.some(value=>!id(value)))unavailable();
  const selected=[...new Set(clinicIds.map(Number))].sort((a,b)=>a-b);
  const recovery=await require('./metaMarketingLegacyRecovery.service').createRecovery({models}).prepareRetirement({scope,clinicIds:selected});
  const business=await require('./metaMarketingBusinessSource.service').createSource({models}).prepareRetirement({scope,clinicIds:selected});
  const keys=[scopeKey,...selected.map(value=>'clinic:'+value),...recovery.rows.map(row=>row.scope_key),...business.rows.map(row=>row.scope_key)];
  const enrollmentIds=[...recovery.rows.map(row=>row.enrollment_id),...business.rows.flatMap(row=>[row.old_enrollment_id,row.new_enrollment_id])].filter(Boolean);
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,unavailable});
  const prefixes=await order.prepareScopes(keys,enrollmentIds);
  return {scopeKey,clinicIds:selected,recovery,business,prefixes};
}
async function lockRetirement(prepared,transaction,{models=require('../../models')}={}){
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,unavailable});
  await order.lockScopes(prepared.prefixes,transaction);
}
async function validateRetirement(prepared,transaction,{models=require('../../models')}={}){
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,unavailable});
  await order.validateScopes(prepared.prefixes,transaction);
  const affected=new Set(prepared.clinicIds);if(prepared.scopeKey.startsWith('clinic:'))affected.add(Number(prepared.scopeKey.split(':')[1]));
  const keys=prepared.prefixes.scopes.map(item=>item.scopeKey);
  const accepted={};
  for(const kind of ['recovery','business']){
    const plan=prepared[kind],fields=RETIRE_FIELDS[kind],rows=[];
    if(kind==='recovery'&&plan.skipped){accepted[kind]={ids:[],skipped:true,reason:plan.reason};continue;}
    const Model=kind==='recovery'?models.MetaMarketingRecovery:models.MetaMarketingBusinessHandover;
    if(Model){
      const table=kind==='recovery'?'MetaMarketingRecoveries':'MetaMarketingBusinessHandovers';
      const index=kind==='recovery'?'cc_meta_recovery_scope_state':'cc_meta_business_latest';
      const state=kind==='recovery'?"`state` IN ('prepared','flow_bound','active')":"`state`='active' AND `retired_at` IS NULL";
      // Force the scope-leading existing index. A global JSON/OR locking scan
      // can lock unrelated scopes even when the SQL predicate later rejects
      // their rows. The universe includes all inherited clinic scopes plus
      // every affected historical group discovered before the transaction.
      for(const scopeKey of keys){
        let current;try{[current]=await models.sequelize.query('SELECT '+fields.map(field=>'`'+field+'`').join(',')+' FROM `'+table+'` FORCE INDEX (`'+index+'`) WHERE `scope_key`=$scopeKey AND '+state+' ORDER BY `'+fields[0]+'` LIMIT 1001 FOR UPDATE NOWAIT',
          {bind:{scopeKey},transaction,logging:false});}
        catch(error){if((error?.original?.code||error?.parent?.code||error?.code)==='ER_LOCK_NOWAIT')order.changed();throw error;}
        if(current.length>1000)unavailable();rows.push(...current);
      }
    }
    const selected=rows.filter(row=>{let members;try{members=JSON.parse(row.clinic_ids);if(!Array.isArray(members)||members.some(value=>!id(value)))unavailable();}catch{unavailable();}return row.scope_key===prepared.scopeKey||members.some(value=>affected.has(Number(value)));});
    const normalized=values=>values.map(row=>rowTuple(row,fields)).sort();
    if(JSON.stringify(normalized(selected))!==JSON.stringify(normalized(plan.rows)))order.changed();
    accepted[kind]={ids:selected.map(row=>row[fields[0]])};
  }
  validatedRetirements.set(prepared,{transaction,accepted});
}
function retirementRows(prepared,kind,transaction,{scope,clinicIds}){
  const verified=validatedRetirements.get(prepared);
  if(!verified||verified.transaction!==transaction||transaction.finished||!RETIRE_FIELDS[kind]||scopeKeyOf(scope)!==prepared.scopeKey
    ||JSON.stringify([...new Set(clinicIds.map(Number))].sort((a,b)=>a-b))!==JSON.stringify(prepared.clinicIds))unavailable();
  return verified.accepted[kind];
}
async function preserve({ scope, connectionId, actorId, clinicIds, models = require('../../models'), transaction, preparedContext }) {
  if (!transaction || !id(connectionId) || !id(actorId)) unavailable();
  const scopeKey = scope?.assignmentScope === 'group' && id(scope.groupId) ? 'group:' + id(scope.groupId)
    : scope?.assignmentScope === 'clinic' && id(scope.clinicId) ? 'clinic:' + id(scope.clinicId) : null;
  if (!scopeKey || !Array.isArray(clinicIds) || clinicIds.some(value => !id(value))) unavailable();
  if(models.MetaMarketingRecovery||models.MetaMarketingBusinessHandover){retirementRows(preparedContext,'recovery',transaction,{scope,clinicIds});retirementRows(preparedContext,'business',transaction,{scope,clinicIds});}
  for (const key of [...new Set([scopeKey, ...clinicIds.map(value => 'clinic:' + id(value))])].sort()) {
    await models.MetaScopeBlock.findOrCreate({ where: { scope_key: key },
      defaults: { scope_key: key, reason: 'scope_disconnected', connection_id: Number(connectionId), actor_user_id: Number(actorId), created_at: new Date() }, transaction });
  }
  // A repeated withdrawal still retires a newer non-WA generation, even when
  // findOrCreate preserves the same old tombstone and timestamp. The existing
  // enrollment outbox owns remote revocation; shared WhatsApp stays untouched.
  await require('./metaMarketingLegacyRecovery.service').createRecovery({ models })
    .retireForScope({ scope, clinicIds, preparedContext }, transaction);
  await require('./metaMarketingBusinessSource.service').createSource({models})
    .retireForScope({scope,clinicIds,preparedContext},transaction);
  const repo = require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const health = await repo.health(new Date(), { includeUnresolved: false, transaction });
  if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) unavailable();
  const { randomUUID } = require('node:crypto');
  await repo.append({ version: 14, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: new Date().toISOString(),
    action: 'integration.meta.scope_block', stage: 'completed', outcome: 'success', reason: 'scope_disconnected',
    actor: { type: 'user', id: String(actorId) }, scope: { type: scope.assignmentScope, id: scopeKey.split(':')[1] },
    connectionId: String(connectionId), capturePolicy: 'meta-containment-v1' }, { transaction });
}
module.exports = { blocked, preserve,prepareRetirement,lockRetirement,validateRetirement,retirementRows };
