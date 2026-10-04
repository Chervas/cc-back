'use strict';

// Operator-only source preservation. This is deliberately not a booking API
// option: a request/JSON object cannot manufacture the in-process permit.
// Imported errors are retained as non-shareable occupancy, not as a clinic-wide
// exemption from scheduling, patient, room or machinery constraints.
const { hash, norm, localToUtc } = require('./adapter');
const { normalizeBookingProfile } = require('../booking-profile');
const { equipmentIds } = require('../booking-equipment');
const { solveBookingProfile, occupancyForSolution, isFree } = require('../booking-profile-solver');
const { lockBookingResources } = require('../../services/appointmentBookingCommand.service');
const { resolveInstallationKeys, loadBookingContext } = require('../../services/appointmentBookingAvailability.service');
const { storedSourceRefresh } = require('./source-refresh');
const permits = new WeakMap();
const fail = () => { throw Error('SOURCE_BOOKING_PERMIT_INVALID'); };
const sha = v => /^[a-f0-9]{64}$/.test(v || '');
const positive = v => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const obj = v => typeof v === 'string' ? JSON.parse(v) : v;
const instant = v => new Date(v).toISOString();
function sealedAppointment(row) {
  const m = obj(row.import_metadata);
  return { clinic: Number(row.clinica_id), patient: Number(row.paciente_id), doctor: Number(row.doctor_id),
    room: Number(row.instalacion_id), treatment: row.tratamiento_id == null ? null : Number(row.tratamiento_id),
    source_reference: row.source_reference, source_system: row.source_system,
    contact: String(m?.source_contact_id || ''), start: instant(row.inicio), end: instant(row.fin),
    note: norm(row.nota || ''), state: row.estado };
}
function createSourceBookingPermit({ appointment, source, sourceAppointmentId, liveCapturedAt,
  sourceEvidenceSha256, equipmentIds: units = [], reviewedBy, reason, profile = null, now = Date.now() }) {
  const m = obj(appointment?.import_metadata), sealed = sealedAppointment(appointment);
  const legacyRefresh = !m?.source_account && storedSourceRefresh(appointment, m);
  if (![66,72].includes(sealed.clinic) || !['patient','doctor','room'].every(k => positive(sealed[k]))
    || sealed.source_system !== 'cliniccloud' || !sealed.source_reference
    || !(m?.source_account === 'cliniccloud-5880' || legacyRefresh?.source_account === 'cliniccloud-5880'
      && legacyRefresh.operator_review && legacyRefresh.source_appointment_id === String(sourceAppointmentId))
    || m?.source_appointment_id && String(m.source_appointment_id) !== String(sourceAppointmentId)
    || !positive(sourceAppointmentId) || !positive(sealed.contact)
    || !source || source.kind !== 'appointment' || source.status !== 'pendiente' || source.validation_errors?.length
    || source.source_external_id != null && String(source.source_external_id) !== String(sourceAppointmentId)
    || String(source.source_contact_id) !== sealed.contact || source.start_utc !== localToUtc(source.start_local)
    || source.end_utc !== localToUtc(source.end_local) || source.start_utc !== sealed.start || source.end_utc !== sealed.end
    || norm(source.details || '') !== sealed.note
    || !['pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado','cambio_solicitado'].includes(sealed.state)
    || !sha(sourceEvidenceSha256) || !String(reviewedBy || '').trim() || String(reason || '').trim().length < 20
    || !Number.isFinite(Date.parse(liveCapturedAt)) || now < Date.parse(liveCapturedAt) || now - Date.parse(liveCapturedAt) > 3600000
    || !['appointment_details','day_before','same_day'].every(k => m.notification_suppression?.[k] === true)
    || m.cliniccloud_reconciliation?.automation_policy !== 'hold'
    || ['voucher_id','lead_intake_id','hold_expires_at'].some(k => appointment[k]) || appointment.es_provisional
    || m.additional_staff || m.program_session
    || !Array.isArray(units) || units.length > 8 || units.some(id => !positive(id)) || new Set(units).size !== units.length) fail();
  const duration = (Date.parse(sealed.end) - Date.parse(sealed.start)) / 60000;
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) fail();
  let normalized = null;
  try { normalized = profile && normalizeBookingProfile(profile); } catch { fail(); }
  if (profile && (!normalized || normalized.phases.reduce((n,p) => n + p.duration_minutes,0) !== duration
    || normalized.phases[0].installation_ids.length !== 1 || normalized.phases[0].installation_ids[0] !== sealed.room
    || normalized.phases[0].professionals.ids.length !== 1 || normalized.phases[0].professionals.ids[0] !== sealed.doctor
    || normalized.phases.some(p => p.installation_ids.length !== 1 || p.professionals.ids.length !== 1)
    || hash(equipmentIds(normalized).sort((a,b)=>a-b)) !== hash([...units].sort((a,b)=>a-b)))) fail();
  const receipt = { version: 'cliniccloud-source-booking/1', source_account: 'cliniccloud-5880',
    source_appointment_id: String(sourceAppointmentId), source_contact_id: sealed.contact,
    source_sha256: hash(source), source_evidence_sha256: sourceEvidenceSha256,
    live_captured_at: liveCapturedAt, reviewed_by: reviewedBy, reason,
    preserved_start_at: sealed.start, preserved_end_at: sealed.end,
    policy: 'preserve_source_interval_report_conflicts', automation_policy: 'hold' };
  const token = Object.freeze({});
  permits.set(token, { sealed_sha256: hash(sealed), units: [...units], profile: normalized, receipt });
  return token;
}
function inspectSourceBookingPermit(token, appointment, now = Date.now()) {
  const permit = permits.get(token);
  if (!permit || hash(sealedAppointment(appointment)) !== permit.sealed_sha256
    || now < Date.parse(permit.receipt.live_captured_at) || now - Date.parse(permit.receipt.live_captured_at) > 3600000) fail();
  return structuredClone(permit);
}
function sourcePreservedContext(context, start, end) {
  const conflicts = [], outside = [];
  const window = { start: instant(start), end: instant(end) };
  const intersects = b => new Date(b.start) < end && start < new Date(b.end);
  const clean = (resources, kind) => new Map([...resources].map(([id,r]) => {
    if (kind !== 'equipment' && !isFree({ ...r, busy: [] },start,end)) outside.push({ resource_kind:kind, resource_id:id });
    for (const b of r.busy || []) if (intersects(b)) conflicts.push({ resource_kind:kind,resource_id:id,
      appointment_id:b.appointment_id || b.id_cita || null,start_at:instant(b.start),end_at:instant(b.end),
      kind:b.appointment_id || b.id_cita ? 'appointment_overlap' : 'schedule_block' });
    return [id,{ ...r,windows:[window],busy:[] }];
  }));
  const doctors = clean(context.doctors,'doctor'), installations = clean(context.installations,'installation');
  const equipment = context.equipment && clean(context.equipment,'equipment');
  for (const b of context.patientBusy || []) if (intersects(b)) conflicts.push({ resource_kind:'patient',
    resource_id:b.paciente_id || null,appointment_id:b.appointment_id || b.id_cita || null,
    start_at:instant(b.start),end_at:instant(b.end),kind:'appointment_overlap' });
  if (context.clinicWindows && !isFree({windows:context.clinicWindows},start,end)) outside.push({resource_kind:'clinic'});
  return {context:{...context,doctors,installations,equipment,clinicWindows:[window],patientBusy:[]},
    conflicts, outside_schedule:outside};
}
function sourceSolutionExceptions(context, solution) {
  const conflicts = [], outside_schedule = [];
  for (const row of occupancyForSolution(solution)) {
    const id = Number(row.resource_key.split(':')[1]),kind = row.resource_kind;
    const resources = kind === 'doctor' ? context.doctors : kind === 'installation' ? context.installations : context.equipment;
    const resource = resources?.get(id),start = new Date(row.start_at),end = new Date(row.end_at);
    if (!resource) fail();
    if (kind !== 'equipment' && !isFree({...resource,busy:[]},start,end)) outside_schedule.push({resource_kind:kind,resource_id:id});
    for (const b of resource.busy || []) if (new Date(b.start)<end && start<new Date(b.end)) conflicts.push({resource_kind:kind,
      resource_id:id,appointment_id:b.appointment_id || b.id_cita || null,start_at:instant(b.start),end_at:instant(b.end),
      kind:b.appointment_id || b.id_cita ? 'appointment_overlap' : 'schedule_block'});
  }
  const start = new Date(solution.start_at),end = new Date(solution.end_at);
  for (const b of context.patientBusy || []) if (new Date(b.start)<end && start<new Date(b.end)) conflicts.push({resource_kind:'patient',
    appointment_id:b.appointment_id || b.id_cita || null,start_at:instant(b.start),end_at:instant(b.end),kind:'appointment_overlap'});
  if (context.clinicWindows && !isFree({windows:context.clinicWindows},start,end)) outside_schedule.push({resource_kind:'clinic'});
  const unique = a => [...new Map(a.map(v=>[hash(v),v])).values()];
  return {conflicts:unique(conflicts),outside_schedule:unique(outside_schedule)};
}
async function mutateSourceImportedBooking({ db, existing, values, transaction, sourceImportPermit, persist }) {
  if (!transaction || transaction.options?.isolationLevel !== 'READ COMMITTED' || !existing?.id_cita || typeof persist !== 'function') fail();
  const permit = inspectSourceBookingPermit(sourceImportPermit,values);
  const clinic = await db.Clinica.findByPk(values.clinica_id,{transaction,lock:transaction.LOCK.SHARE});
  if (!clinic || Number(clinic.grupoClinicaId) !== 29) fail();
  const start = new Date(values.inicio),end = new Date(values.fin),duration = (end-start)/60000;
  const profile = permit.profile || normalizeBookingProfile({ version:2,phases:[{key:'appointment',label:'',
    duration_minutes:duration,installation_ids:[Number(values.instalacion_id)],
    professionals:{mode:'any',ids:[Number(values.doctor_id)],preferred_id:Number(values.doctor_id)},
    ...(permit.units.length ? {equipment_requirements:permit.units.map(id=>({equipment_ids:[id]}))} : {}) }] });
  const roomIds = [...new Set(profile.phases.flatMap(p=>p.installation_ids))];
  const mapping = await resolveInstallationKeys({db,clinic,installationIds:roomIds,transaction,enabled:true});
  const oldRows = await db.AppointmentBookingOccupancy.findAll({where:{appointment_id:existing.id_cita},transaction});
  await lockBookingResources({db,resourceKeys:[`patient:${values.paciente_id}`,
    ...profile.phases.flatMap(p=>p.professionals.ids.map(id=>`doctor:${id}`)),
    ...roomIds.map(id=>mapping.keys.get(id)),...permit.units.map(id=>`equipment:${id}`),...oldRows.map(r=>r.resource_key)],transaction});
  const original = await loadBookingContext({db,clinic,profile,start,end,transaction,ignoreAppointmentId:existing.id_cita,
    occupancyEnabled:true,installationMapping:mapping,patientId:values.paciente_id,equipmentEnabled:true,inheritEquipmentAttention:true});
  const preserved = sourcePreservedContext(original,start,end);
  const solution = solveBookingProfile({profile,start,...preserved.context});
  // Do not override missing equipment, room/staff eligibility or malformed
  // machine attention merely because the source is authoritative for time.
  if (!solution || instant(solution.end_at) !== instant(end)) throw Error('SOURCE_BOOKING_RESOURCES_REQUIRE_REVIEW');
  const m = {...obj(values.import_metadata)}, receipt = { ...permit.receipt,
    recorded_at:new Date().toISOString(),...sourceSolutionExceptions(original,solution) };
  receipt.receipt_sha256 = hash(receipt);
  m.cliniccloud_source_booking = receipt;
  // Compound visits render and reserve their source-duration phases. These are
  // snapshots of this imported visit, not activation of a clinical treatment.
  const frozen = solution.phases.some(p=>p.staff_attention) ? normalizeBookingProfile({...profile,version:3,
    phases:profile.phases.map((p,i)=>({...p,...(solution.phases[i].staff_attention?{staff_attention:solution.phases[i].staff_attention}:{})}))}) : profile;
  m.booking = {version:1,profile:frozen,phases:solution.phases,warnings:solution.warnings,priority_acknowledged:false};
  const saved = await persist({values:{...values,import_metadata:m},existing,transaction,solution});
  if (!saved?.id_cita) fail();
  await db.AppointmentBookingOccupancy.destroy({where:{appointment_id:saved.id_cita},transaction});
  const rows = occupancyForSolution(solution,mapping.keys);
  await db.AppointmentBookingOccupancy.bulkCreate(rows.map(r=>({...r,appointment_id:saved.id_cita})),{transaction});
  return saved;
}
module.exports = {createSourceBookingPermit,inspectSourceBookingPermit,sourcePreservedContext,sourceSolutionExceptions,mutateSourceImportedBooking};
