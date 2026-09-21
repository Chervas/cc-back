'use strict';

// Physical placement only. Clinical identity, procedure, professional, times,
// status and automation stay unchanged. No activation of rooms or profiles.
const { hash } = require('./adapter');
const { normalizedRow } = require('./appointments-apply');
const { sourceReference } = require('./week-appointments');
const VERSION = 'cliniccloud-cabin-assignments/1';
const fail = message => { throw Error(message); };
function operationFor({ before: raw, source, cabin, catalogRow, reason, projectedConflicts = [] }) {
  const before = normalizedRow(raw), metadata = before.import_metadata;
  if (before.source_system !== 'cliniccloud' || ![66,72].includes(before.clinica_id)
    || before.estado !== 'pendiente' || before.es_provisional || before.hold_expires_at
    || before.voucher_id || metadata.booking || metadata.program_session) fail('CABIN_APPOINTMENT_NOT_SIMPLE_IMPORTED_PENDING');
  const baseline = metadata.cliniccloud_delta?.source;
  if (!baseline || before.source_reference !== sourceReference(source)
    || sourceReference(baseline) !== before.source_reference
    || String(metadata.source_contact_id) !== source.source_contact_id
    || before.inicio !== source.start_utc || before.fin !== source.end_utc
    || (before.nota || '') !== (source.details || '')
    || before.estado !== source.status || hash(baseline) !== hash(Object.fromEntries(Object.keys(baseline).map(k=>[k,source[k]])))) fail('CABIN_SOURCE_BASELINE_CHANGED');
  if (source.start_local.slice(0,10) < '2026-09-21' || source.start_local.slice(0,10) > '2026-09-27') fail('CABIN_OUTSIDE_REVIEWED_WEEK');
  const suppression = metadata.notification_suppression;
  if (metadata.cliniccloud_reconciliation?.automation_policy !== 'hold'
    || !['appointment_details','day_before','same_day'].every(k => suppression?.[k] === true)) fail('CABIN_HOLD_REQUIRED');
  if (!Number.isSafeInteger(cabin.id) || cabin.id <= 0 || cabin.clinica_id !== before.clinica_id
    || cabin.activo !== 0 || cabin.capacidad !== 1 || !/^Mapa físico documental BS 2026\./.test(cabin.descripcion || '')) fail('CABIN_DOCUMENTARY_INACTIVE_ROOM_REQUIRED');
  if (catalogRow.clinic_id !== before.clinica_id || catalogRow.kind !== 'treatment'
    || catalogRow.installation_resolution?.length !== 1 || catalogRow.installation_resolution[0].confirmed_id !== cabin.id) fail('CABIN_SINGLE_DOCUMENTED_LOCATION_REQUIRED');
  if (!String(reason || '').trim() || projectedConflicts.length) fail('CABIN_REVIEW_OR_SOURCE_CONFLICT');
  if (before.instalacion_id === cabin.id) fail('CABIN_ALREADY_ASSIGNED');
  const body = { appointment_id: before.id_cita, before, before_sha256:hash(before), cabin, cabin_sha256:hash(cabin),
    source, catalog_source_key: catalogRow.source_catalog_key, catalog_provenance: catalogRow.provenance, reason };
  return { ...body, operation_sha256:hash(body) };
}
function preparePackage({ operations, catalogPlanHash, sourcePlanHash, reviewedBy, createdAt = new Date().toISOString() }) {
  if (!operations.length || operations.length > 100 || new Set(operations.map(o=>o.appointment_id)).size !== operations.length
    || !reviewedBy || ![catalogPlanHash,sourcePlanHash].every(h=>/^[a-f0-9]{64}$/.test(h))) fail('CABIN_REVIEW_INVALID');
  const body = { version:VERSION, target:'crm', group_id:29, created_at:createdAt, reviewed_by:reviewedBy,
    catalog_plan_sha256:catalogPlanHash, source_plan_sha256:sourcePlanHash, operations,
    allowed_columns:['instalacion_id','import_metadata','updated_at'], activates_rooms:false, sends_messages:false, automation_policy:'hold' };
  return { ...body, package_sha256:hash(body) };
}
function verifyPackage(pkg) {
  const {package_sha256,...body}=pkg;
  if (hash(body)!==package_sha256 || pkg.version!==VERSION || pkg.target!=='crm' || pkg.group_id!==29
    || pkg.activates_rooms!==false || pkg.sends_messages!==false || pkg.automation_policy!=='hold'
    || hash(pkg.allowed_columns)!==hash(['instalacion_id','import_metadata','updated_at'])
    || !pkg.operations?.length || pkg.operations.length>100 || new Set(pkg.operations.map(o=>o.appointment_id)).size!==pkg.operations.length) fail('CABIN_PACKAGE_INVALID');
  for(const operation of pkg.operations) {
    const {operation_sha256,...op}=operation;
    if(hash(op)!==operation_sha256 || hash(op.before)!==op.before_sha256 || hash(op.cabin)!==op.cabin_sha256) fail('CABIN_OPERATION_CHANGED');
    const rebuilt=operationFor({ before:op.before, source:op.source, cabin:op.cabin, reason:op.reason,
      catalogRow:{clinic_id:op.cabin.clinica_id,kind:'treatment',installation_resolution:[{confirmed_id:op.cabin.id}],source_catalog_key:op.catalog_source_key,provenance:op.catalog_provenance} });
    if(hash(rebuilt)!==hash(operation))fail('CABIN_OPERATION_CHANGED');
  }
}
function patchFor(current, operation, pkg, now) {
  return { instalacion_id:operation.cabin.id, updated_at:new Date(Math.floor(now/1000)*1000).toISOString(),
    import_metadata:{...current.import_metadata, cliniccloud_cabin_assignment:{version:1,package_sha256:pkg.package_sha256,
      operation_sha256:operation.operation_sha256,previous_installation_id:current.instalacion_id,installation_id:operation.cabin.id,
      catalog_provenance:operation.catalog_provenance,reason:operation.reason,reviewed_by:pkg.reviewed_by,applied_at:new Date(now).toISOString(),automation_policy:'hold'}} };
}
async function executeAssignments({ pkg, store, journal, now = ()=>Date.now() }) {
  verifyPackage(pkg);
  if(!journal?.append)fail('CABIN_DURABLE_JOURNAL_REQUIRED');
  const result={assigned:0,replayed:0,deferred:0,rooms_activated:0,messages_sent:0};
  for(const op of pkg.operations){
    if(Date.parse(pkg.created_at)>now() || now()-Date.parse(pkg.created_at)>7200000 || !Number.isFinite(Date.parse(pkg.created_at)))fail('CABIN_PACKAGE_EXPIRED');
    let outcome;
    await store.transaction(async tx=>{
      const current=normalizedRow(await tx.read(op.appointment_id,true));
      const marker=current.import_metadata.cliniccloud_cabin_assignment;
      if(marker?.package_sha256===pkg.package_sha256&&marker.operation_sha256===op.operation_sha256){outcome={phase:'cabin_replayed',id:op.appointment_id};return;}
      if(hash(current)!==op.before_sha256)fail('CABIN_APPOINTMENT_CHANGED');
      const reasons=await tx.validate(op);
      if(reasons.length){outcome={phase:'cabin_deferred',id:op.appointment_id,reasons};return;}
      const patch=patchFor(current,op,pkg,now()),after={...current,...patch};
      await journal.append({phase:'cabin_prepared',id:op.appointment_id,before:current,after,operation_sha256:op.operation_sha256});
      await tx.update(op.appointment_id,patch);
      if(hash(normalizedRow(await tx.read(op.appointment_id)))!==hash(after))fail('CABIN_AFTER_WRITE_MISMATCH');
      outcome={phase:'cabin_committed',id:op.appointment_id,after_sha256:hash(after)};
    });
    await journal.append(outcome);
    if(outcome.phase==='cabin_committed')result.assigned++;else if(outcome.phase==='cabin_replayed')result.replayed++;else result.deferred++;
  }
  return result;
}
module.exports={VERSION,operationFor,preparePackage,verifyPackage,patchFor,executeAssignments};
