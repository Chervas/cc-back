'use strict';

// Shared final guard: the same native appointment/visit locks already held by
// the foundation protect enqueue, materialization and dispatch/broker checks.
// This is not a selector for legacy rows or permission to create an intent.
const v = require('./appointment-visit-communication');
const r = require('./appointment-visit-runtime-contract');
const policy = require('./appointment-visit-reminder-policy');
const calendar = require('./availability-calendar');
const fail = suffix => v.fail('runtime_reminder_' + suffix);
async function assertReminderCurrent({ db, visit, owner, purpose, templateVersionId, window, communication = null, transaction, now }) {
  if (!['reminder_day_before', 'reminder_same_day'].includes(purpose) || !visit.runtime_enrollment) return;
  const enrollment = r.assertStoredEnrollment(visit), stageKey = purpose === 'reminder_day_before' ? 'attendance_day_before' : 'attendance_same_day';
  const selected = policy.selectedBinding(enrollment, Number(templateVersionId), stageKey), automation = require('../services/appointmentAutomationV2Runtime.service');
  const current = [];
  for (const row of await automation.resolveScheduledTemplatesForCita(owner, 'appointment_reminder_window', { transaction })) {
    const config = policy.policy(automation.getTemplateTriggerConfig(row));
    current.push(policy.binding({ templateVersionId: Number(row.id), stageKey: 'attendance_' + config.schedule_moment,
      schedulePolicy: config, fireGraceMs: automation.scheduledTriggerFireGraceMs() }));
  }
  if (v.canonical(policy.normalizeBindings(current)) !== v.canonical(policy.normalizeBindings(enrollment.reminder_bindings))) fail('selection_changed');
  const clinic = await db.Clinica.findByPk(Number(visit.clinic_id), { transaction });
  if (!clinic || calendar.resolveClinicTimezone(clinic) !== enrollment.time_zone) fail('timezone_changed');
  // Do not introduce Cita -> template-family locks during birth/movement:
  // dispatch's established order is family -> execution/job -> Cita. During
  // execution/transport the existing stop guard already owns the family; an
  // unbound future claim freezes evidence, not permission to send right now.
  const template = await db.AutomationFlowTemplateV2.findByPk(selected.template_version_id, { transaction });
  const definition = r.stageDefinition(enrollment, selected.template_version_id, stageKey);
  if (!template || template.is_active !== true || !template.published_at || r.graphHash(template) !== definition.manifest.graph_sha256) fail('graph_changed');
  let mutation = null;
  if (Number(visit.communication_revision) > 1) {
    if (!db.PatientOperationalEvent) fail('mutation_event_required');
    const events = await db.PatientOperationalEvent.findAll({ where: { clinic_id: Number(visit.clinic_id), patient_id: Number(visit.patient_id),
      event_type: r.MUTATION_EVENT, source: 'appointment_visit_runtime', metadata: { mutation: { visit_id: visit.id,
        communication_revision: Number(visit.communication_revision) } } }, order: [['id', 'DESC']], limit: 2, transaction });
    if (events.length !== 1) fail('mutation_event_required');
    mutation = r.captureMutationReceipt(events[0], visit);
    const receipt = r.mutationReceipt(mutation, visit);
    if (communication && (communication.runtime_stage?.mutation_event_id !== receipt.event_id
      || communication.runtime_stage?.mutation_event_sha256 !== receipt.event_sha256)) fail('mutation_event_required');
  }
  const expected = r.semanticWindow({ visit, templateVersionId: Number(templateVersionId), stageKey, mutation }).window;
  if (!window || v.canonical(expected) !== v.canonical(v.normalizeWindow({ key: window.key, starts_at: window.starts_at, ends_at: window.ends_at }))) fail('window_changed');
  if (communication && (communication.runtime_stage?.reminder_binding_sha256 !== v.hash(selected)
    || v.hash(communication.runtime_stage) !== communication.runtime_stage_sha256)) fail('binding_changed');
  // Scheduling is allowed while unconfirmed. The existing fire-time condition
  // is applied only when a due intent can obtain execution/delivery rights.
  if (+new Date(now) >= Date.parse(expected.starts_at) && selected.schedule_policy.exclude_if_not_confirmed
    && !automation.isAppointmentConfirmedForReminder(owner)) fail('appointment_not_confirmed');
}
module.exports = { assertReminderCurrent };
