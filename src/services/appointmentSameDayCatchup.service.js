'use strict';
const db = require('../../models');
const runtime = require('./appointmentAutomationV2Runtime.service');
const eligibility = require('../lib/whatsappAppointmentEligibility');
const { Op } = db.Sequelize;
const supported = template => !!(template?.clinic_id && template.trigger_type === 'appointment_reminder_window'
  && runtime.getTemplateTriggerConfig(template).schedule_moment === 'same_day'
  && runtime.getTemplateTriggerConfig(template).custom_time === '08:00'
  && runtime.getTemplateTriggerConfig(template).schedule_time_mode === 'custom'
  && !template.nodes?.some(node => /consent|review|resena/.test(node.type || '')));
async function alreadyMaterialized(appointment, template) {
  const [executions] = await db.sequelize.query("SELECT id,context FROM FlowExecutionsV2 WHERE clinic_id=:clinicId AND trigger_entity_type='appointment' AND trigger_entity_id=:appointmentId AND trigger_type='appointment_reminder_window' AND created_at>=:since ORDER BY id DESC LIMIT 101", {
    replacements: { clinicId: appointment.clinica_id, appointmentId: appointment.id_cita, since: new Date(Date.now() - 26 * 3600000) } });
  if (executions.length > 100 || executions.some(e => {
    const c = typeof e.context === 'string' ? JSON.parse(e.context) : e.context;
    return c?.trigger?.schedule_moment === 'same_day' && new Date(c.appointment?.inicio).getTime() === new Date(appointment.inicio).getTime();
  })) return true;
  const selections = (template.nodes || []).filter(n => n.type === 'action/send_whatsapp').flatMap(n => {
    const c = n.config || {}; return [c, ...Object.values(c.language_routing?.variants || {})];
  });
  const ids = selections.flatMap(c => {
    return [c.template_id, c.fallback_template_id];
  }).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  const catalogs = selections.flatMap(c => [c.catalog_template_id, c.fallback_catalog_template_id])
    .map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  if (catalogs.length) {
    const instances = await db.WhatsappTemplate.findAll({ where: { catalog_template_id: { [Op.in]: catalogs } },
      attributes: ['id'], limit: 1001, raw: true });
    if (instances.length > 1000) return true;
    ids.push(...instances.map(row => Number(row.id)));
  }
  if (!ids.length) return true; // Without a materializable template identity, fail closed.
  const [messages] = await db.sequelize.query("SELECT m.createdAt,m.metadata FROM Messages m JOIN Conversations c ON c.id=m.conversation_id WHERE c.clinic_id=:clinicId AND c.patient_id=:patientId AND m.direction='outbound' AND m.message_type='template' AND m.createdAt>=:since AND (m.status IN ('pending','sending','sent','delivered','read') OR JSON_EXTRACT(m.metadata,'$.wamid') IS NOT NULL) LIMIT 201", {
    replacements: { clinicId: appointment.clinica_id, patientId: appointment.paciente_id, since: new Date(Date.now() - 26 * 3600000) } });
  return messages.length > 200 || messages.some(m => {
    const metadata = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata || {};
    return ids.includes(Number(metadata.template_id)) && eligibility.day(new Date(m.createdAt)) === eligibility.day(Date.now());
  });
}
async function eligible(appointment, template) {
  if (!supported(template) || Number(appointment.clinica_id) !== Number(template.clinic_id)) return false;
  const due = runtime.catchUpEligible(appointment, template);
  if (!due || appointment.es_provisional || await eligibility.patientImportHeld(appointment.paciente_id)
    || await require('./appointmentPatientLinks.service').follower(db, appointment.id_cita)
    || await require('./appointmentVisitManaged.service').current().managedVisit(appointment)
    || await alreadyMaterialized(appointment, template)) return false;
  return due;
}
async function prepare(template, { enqueue = false, userId } = {}) {
  if (!supported(template)) return { available: false, count: 0 };
  const appointments = await db.CitaPaciente.findAll({ where: { clinica_id: template.clinic_id,
    inicio: { [Op.gt]: new Date(), [Op.lt]: new Date(Date.now() + 24 * 3600000) } }, order: [['inicio', 'ASC']], limit: 501, raw: true });
  if (appointments.length > 500) throw Error('same_day_catchup_requires_review');
  let count = 0;
  for (const appointment of appointments) {
    if (!await eligible(appointment, template)) continue;
    if (enqueue) await require('./jobRequests.service').enqueueUniqueJobRequest({ type: 'appointment_same_day_catchup',
      payload: { template_version_id: template.id, clinicId: template.clinic_id, appointment_id: appointment.id_cita,
        start_at: new Date(appointment.inicio).toISOString(), approved_at: new Date().toISOString(), user_id: userId },
      priority: 'high', origin: 'explicit_same_day_activation',
      dedupeScope: 'same-day:' + template.clinic_id + ':' + appointment.id_cita + ':' + new Date(appointment.inicio).getTime() });
    count++;
  }
  return { available: true, count, enqueued: enqueue, clinical_scope: template.clinic_id };
}
async function run(payload) {
  const template = await db.AutomationFlowTemplateV2.findByPk(Number(payload.template_version_id));
  const appointment = await db.CitaPaciente.findByPk(Number(payload.appointment_id), { raw: true });
  if (!appointment || !template || Number(template.clinic_id) !== Number(payload.clinicId)
    || new Date(appointment.inicio).getTime() !== Date.parse(payload.start_at)
    || eligibility.day(new Date(payload.approved_at)) !== eligibility.day(Date.now())) return { skipped: true, reason: 'catchup_scope_or_slot_changed' };
  const due = await eligible(appointment, template);
  if (!due) return { skipped: true, reason: 'catchup_no_longer_eligible' };
  return runtime.enqueueExecutionForTemplate(appointment, template, { event_name: template.trigger_type,
    window_identifier: runtime.buildScheduledWindowIdentifier({ triggerType: template.trigger_type,
      triggerConfig: runtime.getTemplateTriggerConfig(template), scheduledFor: due }), user_id: payload.user_id,
    user_name: 'explicit_same_day_activation', user_role: 'system' });
}
module.exports = { supported, eligible, prepare, run, alreadyMaterialized };
