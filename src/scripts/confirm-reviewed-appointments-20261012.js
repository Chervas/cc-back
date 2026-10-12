'use strict';
// Human-reviewed, dated correction. It uses the canonical state-only writer
// and deliberately never publishes triggers, messages or clinical completion.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const DAY = '2026-10-12';
const IDS = Object.freeze([78189,78196,78204,78207,78205,78190,78203,77808,77369,77796,
  77804,78175,77803,75843,77795,77802,78240,78094,78176,78223]);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = m => hash(JSON.stringify([m.id,m.conversation_id,m.direction,m.content,
  m.message_type,m.sent_at,m.metadata?.reaction || null,m.metadata?.wamid || null]));
const fail = code => { throw Object.assign(Error(code), { code }); };
function assertEvidence(approved, current, now = Date.now()) {
  if (!IDS.includes(approved.appointmentId) || !approved.messages?.length || !current.scopeMatches) fail('correction_scope_invalid');
  if (current.appointmentId !== approved.appointmentId || current.conversationId !== approved.conversationId
    || current.clinicId !== approved.clinicId || current.patientId !== approved.patientId) fail('correction_scope_changed');
  if (current.status === 'recordatorio_confirmado') return 'already_confirmed';
  if (current.status !== 'recordatorio_enviado' || current.updatedAt !== approved.updatedAt
    || current.start !== approved.start || current.end !== approved.end || Date.parse(current.start) <= now
    || !current.start.startsWith('2026-10-13T')) fail('correction_appointment_changed');
  if (current.noticeDigest !== approved.noticeDigest
    || JSON.stringify(current.messages.map(m => [m.id,m.digest])) !== JSON.stringify(approved.messages.map(m => [m.id,m.digest]))) {
    fail('correction_response_changed');
  }
  if (current.sameDayAppointments.length > 1 && !(approved.targetedReaction === true
    && current.messages.every(m => m.type === 'reaction' && m.reactionTargetsNotice))) fail('correction_multiple_appointments');
  if (current.automationState?.urgent || current.automationState?.status === 'active') fail('correction_processing_or_urgent');
  return 'confirm';
}
async function snapshot(db, approved, transaction) {
  const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
  const a = await db.CitaPaciente.findByPk(approved.appointmentId, options);
  const c = await db.Conversation.findByPk(approved.conversationId, options);
  const notice = await db.Message.findByPk(approved.noticeId, options);
  if (!a || !c || !notice || Number(notice.conversation_id) !== Number(c.id)) fail('correction_target_missing');
  const flow = await db.FlowExecutionV2.findByPk(Number(notice.metadata?.execution_id), options);
  if (!flow || Number(flow.clinic_id) !== Number(a.clinica_id)
    || flow.trigger_entity_type !== 'appointment' || Number(flow.trigger_entity_id) !== Number(a.id_cita)) fail('correction_notice_scope_invalid');
  const rows = await db.Message.findAll({ where: { conversation_id: c.id,
    id: { [db.Sequelize.Op.gt]: notice.id }, direction: 'inbound', message_type: { [db.Sequelize.Op.ne]: 'event' } },
    order: [['id','ASC']], ...options });
  const appointments = await db.CitaPaciente.findAll({ where: { clinica_id: a.clinica_id, paciente_id: a.paciente_id,
    inicio: { [db.Sequelize.Op.gte]: new Date('2026-10-12T22:00:00Z'), [db.Sequelize.Op.lt]: new Date('2026-10-13T22:00:00Z') },
    estado: { [db.Sequelize.Op.notIn]: ['cancelada','no_asistio'] } }, attributes: ['id_cita','estado'], ...options });
  const state = await db.ConversationAutomationState.findOne({ where: { conversation_id: c.id }, ...options });
  return { appointmentId: a.id_cita, conversationId: c.id, clinicId: a.clinica_id, patientId: a.paciente_id,
    status: a.estado, start: a.inicio.toISOString(), end: a.fin.toISOString(), updatedAt: a.updated_at.toISOString(),
    scopeMatches: c.channel === 'whatsapp' && Number(c.clinic_id) === Number(a.clinica_id) && Number(c.patient_id) === Number(a.paciente_id),
    noticeDigest: digest(notice), sameDayAppointments: appointments.map(x => ({id_cita:x.id_cita,estado:x.estado})),
    messages: rows.map(m => ({ id:m.id,digest:digest(m),type:m.message_type,
      reactionTargetsNotice: !!m.metadata?.reaction?.message_id && m.metadata.reaction.message_id === notice.metadata?.wamid })),
    automationState: state ? {status:state.status,urgent:!!state.possible_urgency,appointment:state.appointment_id,source:state.source_message_id} : null,
  };
}
async function applyOne(db, approved, { actorId, evidenceDir }) {
  const writer = require('../services/appointmentBookingCommand.service');
  const activity = require('../services/appointmentActivity.service');
  const reviews = require('../services/conversationAutomationState.service');
  const { Op } = db.Sequelize;
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    await require('../services/appointmentPatientLinks.service').load(db, approved.appointmentId, transaction, true);
    if (await require('../services/appointmentPatientLinks.service').load(db, approved.appointmentId, transaction)) fail('correction_linked_appointments_require_review');
    const current = await snapshot(db, approved, transaction);
    if (assertEvidence(approved, current) === 'already_confirmed') return {appointmentId:approved.appointmentId,alreadyConfirmed:true};
    const executions = await db.FlowExecutionV2.findAll({ where: { clinic_id: current.clinicId,
      trigger_entity_type:'appointment',trigger_entity_id:current.appointmentId,status:{[Op.in]:['running','waiting']} },
      transaction,lock:transaction.LOCK.UPDATE });
    if (executions.some(e => e.status === 'running')) fail('correction_execution_running');
    fs.writeFileSync(path.join(evidenceDir,'before-'+current.appointmentId+'.json'),JSON.stringify(current),{mode:0o600,flag:'wx'});
    const saved = await writer.mutateAppointmentBooking({ db,transaction,existingAppointmentId:current.appointmentId,
      appointmentValues:{estado:'recordatorio_confirmado',updated_by:actorId},stateOnly:true,
      persist:({existing,transaction:tx})=>existing.update({estado:'recordatorio_confirmado',updated_by:actorId},{transaction:tx}) });
    await activity.recordAppointmentStatusChange({ appointment:saved,previousStatus:current.status,newStatus:'recordatorio_confirmado',
      actorUserId:actorId,source:'agenda',transaction,metadata:{action:'human_reviewed_confirmation_reconciliation',approved_day:DAY,
        response_message_ids:current.messages.map(m=>m.id),notice_message_id:approved.noticeId,
        evidence_sha256:hash(JSON.stringify(current)),communications:'suppressed_no_trigger_or_message'} });
    const executionIds = executions.map(e=>e.id);
    for (const e of executions) await e.update({status:'cancelled',current_node_id:null,waiting_meta:null,wait_until:null,
      last_error:'human_confirmation_silent_reconciliation'},{transaction});
    if (executionIds.length) await db.JobRequest.update({status:'cancelled',error_message:'human_confirmation_silent_reconciliation'},
      {where:{type:'automations_v2_execute',status:{[Op.in]:['pending','queued','waiting']},[Op.and]:
        db.sequelize.where(db.sequelize.literal("CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id')) AS UNSIGNED)"),{[Op.in]:executionIds})},transaction});
    // Close only this appointment's reviewed response, never another question.
    if (!current.automationState || Number(current.automationState.appointment) === current.appointmentId) {
      await reviews.setState({clinicId:current.clinicId,conversationId:current.conversationId,appointmentId:current.appointmentId,
        appointmentStatus:'recordatorio_confirmado',sourceMessageId:current.messages.at(-1).id,intent:'confirmar_cita',
        status:'completed',stage:'completed',manualActionRequired:false,needsResponse:false,possibleUrgency:false,
        failureCode:null,completedAt:new Date()},{transaction,emit:false});
    }
    return {appointmentId:current.appointmentId,clinicId:current.clinicId,confirmed:true,silent:true,
      stoppedExecutions:executionIds.length};
  });
}
async function main({ apply=false, manifestFile, evidenceDir }={}) {
  const db = require('../../models');
  if (require('../lib/whatsappAppointmentEligibility').day(Date.now()) !== DAY
    || require('../services/jobRequests.service').getCurrentRuntimeNamespace() !== 'staging') fail('correction_runtime_invalid');
  const [database] = await db.sequelize.query('SELECT DATABASE() name');
  if (database[0]?.name !== 'clinicaclick') fail('correction_database_invalid');
  const stat = fs.statSync(manifestFile);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail('correction_manifest_private_required');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length > IDS.length
    || new Set(manifest.candidates.map(c=>c.appointmentId)).size !== manifest.candidates.length
    || Date.now()-Date.parse(manifest.at)>1800000 || Date.parse(manifest.at)>Date.now()+5000) fail('correction_manifest_invalid');
  if (apply && (!path.isAbsolute(evidenceDir || '') || !fs.statSync(evidenceDir).isDirectory()
    || fs.statSync(evidenceDir).mode & 0o077)) fail('correction_private_evidence_required');
  const actors = await db.Usuario.findAll({where:{email_usuario:'carlos@clinicaclick.com',estado_cuenta:'activo'},attributes:['id_usuario'],raw:true});
  if (actors.length!==1) fail('correction_actor_invalid');
  const actorId = actors[0].id_usuario;
  const report = {at:new Date().toISOString(),applied:apply,manifestSha256:hash(fs.readFileSync(manifestFile)),results:[]};
  for (const candidate of manifest.candidates) {
    try {
      if (!await require('../lib/access-policy').canUserAccessFeature({actorId,featureKey:'appointments.manage',clinicId:candidate.clinicId})) fail('correction_actor_denied');
      const current = await snapshot(db,candidate);
      const decision = assertEvidence(candidate,current);
      report.results.push(apply ? await applyOne(db,candidate,{actorId,evidenceDir}) : {appointmentId:candidate.appointmentId,decision});
    } catch (error) { report.results.push({appointmentId:candidate.appointmentId,reviewRequired:true,reason:error.code || error.name}); }
  }
  if (evidenceDir) fs.writeFileSync(path.join(evidenceDir,apply?'apply-report.json':'dry-run.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(report));return report;
}
if (require.main===module) main({apply:process.argv.includes('--apply'),manifestFile:process.argv.find(a=>a.startsWith('--manifest='))?.slice(11),
  evidenceDir:process.argv.find(a=>a.startsWith('--evidence='))?.slice(11)})
  .catch(e=>{console.error(JSON.stringify({error:e.code||e.name}));process.exitCode=1;})
  .finally(async()=>{await require('../../models').sequelize.close();const q=require.cache[require.resolve('../services/queue.service')];
    if(q)for(const queue of Object.values(q.exports.queues||{}))queue.disconnect?.();});
module.exports={assertEvidence,digest,IDS,DAY};
