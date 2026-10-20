'use strict';

// A program exception is deliberately narrower than the ordinary manual
// restriction dialog: only an explicitly chosen clinician's working hours may
// be extended. No occupancy, absence, room, machine, access or clinical rule is
// relaxed, and automatic searches never call this helper.
const { createHash, timingSafeEqual } = require('node:crypto');
const { solveBookingProfile } = require('./booking-profile-solver');
const { assessment } = require('./booking-restriction-confirmation');
const canonicalHash = require('./cliniccloud-import/adapter').hash;

function cloneProgramContext(context) {
  const copyResources = map => new Map([...(map || new Map())].map(([id, value]) => [id, { ...value,
    busy: [...(value.busy || [])],
    ...(value.attention_visits ? { attention_visits: [...value.attention_visits] } : {}),
    ...(value.absence_windows ? { absence_windows: [...value.absence_windows] } : {}),
  }]));
  return { ...context, doctors: copyResources(context.doctors), installations: copyResources(context.installations),
    ...(context.equipment ? { equipment: copyResources(context.equipment) } : {}), patientBusy: [...(context.patientBusy || [])] };
}

function explicitProgramStaff(profile, selections = {}) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)
    || Object.keys(selections).some(key => !profile.phases.some(phase => phase.key === key))) return null;
  const ids = new Set();
  for (const phase of profile.phases) {
    const choice = selections[phase.key];
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)
      || Object.keys(choice).some(key => !['doctor_id', 'installation_id'].includes(key))
      || !Number.isSafeInteger(choice.installation_id) || !phase.installation_ids.includes(choice.installation_id)) return null;
    if (phase.professionals.mode === 'all') {
      if (choice.doctor_id != null && !(phase.professionals.ids.length === 1 && choice.doctor_id === phase.professionals.ids[0])) return null;
      phase.professionals.ids.forEach(id => ids.add(id));
    } else {
      if (!Number.isSafeInteger(choice.doctor_id) || !phase.professionals.ids.includes(choice.doctor_id)) return null;
      ids.add(choice.doctor_id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function programScheduleContext(context, doctorIds, start, end) {
  return { ...context, doctors: new Map([...context.doctors].map(([id, resource]) => [id, doctorIds.includes(id)
    ? { ...resource, windows: [...(resource.windows || []), { start, end }] } : resource])) };
}

function programScheduleAssessment({ profile, context, start, end, selections = {}, additionalStaffIds = [],
  clinicId, clinicName = '', treatmentId, treatmentName = '', patientId, appointmentId = null, actorId, previous = null }) {
  const doctorIds = explicitProgramStaff(profile, selections);
  if (!doctorIds?.length || doctorIds.some(id => !context.doctors.has(id))) return null;
  const relaxed = programScheduleContext(context, doctorIds, start, end);
  const solution = solveBookingProfile({ profile, ...relaxed, start: new Date(start), selections });
  if (!solution || +new Date(solution.end_at) !== +new Date(end)
    || context.patientBusy.some(row => +new Date(row.start) < +new Date(end) && +new Date(row.end) > +new Date(start))) return null;
  const result = assessment({ profile, context, start, selections, additionalStaffIds, clinicId, clinicName,
    treatmentId, treatmentName, patientId, appointmentId, actorId, previous, canonicalSolution: solution });
  if (!result.canConfirm || !result.acknowledgement || !result.restrictions.length
    || result.restrictions.some(row => row.code !== 'STAFF_OUT_OF_HOURS' || !doctorIds.includes(row.doctor?.id))) return null;
  return { solution, doctorIds, restrictions: result.restrictions, acknowledgement: result.acknowledgement };
}

function programScheduleBatchReceipt({ plan, request, actorId, exceptions }) {
  const rows = [...exceptions].map(([key, value]) => ({ key, acknowledgement: value.acknowledgement,
    doctor_ids: value.doctorIds, solution: value.solution })).sort((a, b) => a.key.localeCompare(b.key));
  return createHash('sha256').update(JSON.stringify({ schema: 'program-staff-schedule/1', actor_id: Number(actorId),
    clinic_id: Number(plan.voucher.clinic_id), patient_id: Number(plan.voucher.patient_id), voucher_id: plan.voucher.public_id,
    snapshot_sha256: plan.snapshot.sha256, plan_revision: require('./program-replan').planRevision(plan),
    request_sha256: request.request_sha256, exceptions: canonicalHash(rows) })).digest('hex');
}

function programScheduleReceiptMatches(expected, supplied) {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

module.exports = { cloneProgramContext, explicitProgramStaff, programScheduleContext, programScheduleAssessment,
  programScheduleBatchReceipt, programScheduleReceiptMatches };
