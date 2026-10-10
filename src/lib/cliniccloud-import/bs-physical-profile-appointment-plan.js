'use strict';

// A separate appointment contract: the catalog migration must remain catalog-
// only. This contract never relabels acts, changes a treatment ID, fabricates
// care or releases rooms. Version2 additionally honors the client's10Oct
// explicit note precedence: an EMS note can correct only the machine booking,
// using the SAME room and interval, after full capacity/compatibility checks.
const { hash, norm, localToUtc } = require('./adapter');
const { normalizeBookingProfile } = require('../booking-profile');
const { bookingSegments } = require('../appointment-booking-segments');
const { attentionVisitOrigin, attentionVisitConflict } = require('../booking-attention-origin');
const { assessStaffAttentionSteps } = require('../booking-attention');
const { occupancyForSolution } = require('../booking-profile-solver');
const { sharedPreparationRecipe } = require('../bs-operational-recipes');
const { equipmentFitsRoom } = require('../booking-equipment');
const { installationAllowsStaff } = require('../installation-professionals');
const calendar = require('../availability-calendar');
const VERSION = 'bs-piedad-appointment-plan/2';
const SNAPSHOT_VERSION = 'bs-piedad-appointment-snapshot/2';
const SOURCE_FILES = Object.freeze({
    calendar: 'dd6630407f5699cf094152a39ee7a23fff4a3b1fb356a526118e364ad0213591',
    history: 'fe29ac48bd2be10c409f13b6dbcd79f15ee03c274f5e09c72b36a3cd9aef906d',
});
const FIELD_WHITELIST = Object.freeze(['CitasPacientes.import_metadata.booking', 'CitasPacientes.import_metadata.piedad_preparation_migration',
    'AppointmentBookingOccupancies.doctor_intervals', 'AppointmentBookingOccupancies.authorized_ems_equipment_correction']);
const RECIPES = Object.freeze({ 5: [1948, 1949], 11: [1957], 14: [1964, 1965] });
const object = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => hash(a) === hash(b);
const fail = code => { throw Error(code); };
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d /.test(value) ? value.replace(' ', 'T') + 'Z' : value;
const ms = value => Date.parse(timestamp(value));
const iso = value => new Date(ms(value)).toISOString();
const overlaps = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
function materializeAppointment(row) {
    return { ...clone(row), import_metadata: clone(object(row.import_metadata) ?? null) };
}
function occupancySignature(rows) {
    return rows.map(row => [row.phase_key, row.resource_kind, row.resource_key,
        row.installation_id == null ? null : Number(row.installation_id), row.doctor_id == null ? null : Number(row.doctor_id), iso(row.start_at), iso(row.end_at)])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function currentRowHash(row) { return hash(materializeAppointment(row)); }
function appointmentDataHash(row) {
    const { updated_at, ...data } = materializeAppointment(row); return hash(data);
}
function competingReservationEvidence(snapshot, row, { resourceKeys = [], excludedAppointmentIds = [], plannedOccupancies = [] } = {}) {
    const own = snapshot.occupancies.filter(item => Number(item.appointment_id) === Number(row.id_cita));
    const keys = new Set([...own.map(item => item.resource_key), ...resourceKeys]);
    const excluded = new Set(excludedAppointmentIds.map(Number));
    const spanRows = [...own, ...plannedOccupancies];
    const span = { start: new Date(Math.min(ms(row.inicio), ...spanRows.map(item => ms(item.start_at)))).toISOString(),
        end: new Date(Math.max(ms(row.fin), ...spanRows.map(item => ms(item.end_at)))).toISOString() };
    const matching = snapshot.appointments.filter(item => Number(item.id_cita) !== Number(row.id_cita) && !excluded.has(Number(item.id_cita))
        && item.estado !== 'cancelada' && (overlaps(span, { start: timestamp(item.inicio), end: timestamp(item.fin) })
            && (Number(item.doctor_id) === 221 || Number(item.paciente_id) === Number(row.paciente_id))
            || snapshot.occupancies.some(o => Number(o.appointment_id) === Number(item.id_cita) && keys.has(o.resource_key)
                && overlaps(span, { start: timestamp(o.start_at), end: timestamp(o.end_at) }))));
    const ids = new Set(matching.map(item => Number(item.id_cita)));
    return { appointments: matching.map(materializeAppointment).sort((a, b) => a.id_cita - b.id_cita),
        occupancies: snapshot.occupancies.filter(item => ids.has(Number(item.appointment_id))).sort((a, b) => a.id - b.id) };
}
function scopeCheck(snapshot) {
    const { snapshot_sha256, ...body } = snapshot || {};
    if (snapshot?.version !== SNAPSHOT_VERSION || hash(body) !== snapshot_sha256 || snapshot.target !== 'crm'
        || !same(snapshot.scope, { group_id: 29, clinic_ids: [72], doctor_ids: [221], source_systems: ['cliniccloud', null, ''], future_only: true,
            manual_created_since: new Date(Date.parse(snapshot.captured_at) - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' '), client_note_priority_authorized_on: '2026-10-10' })
        || snapshot.clinics?.length !== 2 || snapshot.clinics.some(row => Number(row.grupoClinicaId) !== 29)
        || calendar.resolveClinicTimezone(snapshot.clinics.find(row => Number(row.id_clinica) === 72)) !== 'Europe/Madrid'
        || snapshot.engines?.length !== 4 || snapshot.engines.some(row => row.ENGINE !== 'InnoDB') || snapshot.triggers?.length)
        fail('BS_APPOINTMENT_SNAPSHOT_OR_SCOPE_INVALID');
}
function sourceIndex(calendarSource, historySource) {
    if (historySource?.data?.source_account !== 'cliniccloud-5880' || historySource.data.full_history !== true
        || !Array.isArray(calendarSource?.data?.captures)) fail('BS_APPOINTMENT_ORIGINAL_SOURCE_INVALID');
    const byId = new Map();
    for (const capture of calendarSource.data.captures) {
        if (!Array.isArray(capture.response)) fail('BS_APPOINTMENT_ORIGINAL_SOURCE_INVALID');
        for (const row of capture.response) {
            const id = String(row.id), previous = byId.get(id);
            if (previous && !same(previous, row)) fail('BS_APPOINTMENT_ORIGINAL_SOURCE_DUPLICATE_CHANGED');
            byId.set(id, row);
        }
    }
    return { byId, histories: historySource.data.results };
}
function reviewedTreatment(row, id) {
    const r = row.import_metadata?.import_treatment_resolution;
    return r?.version === 1 && r.mode === 'treatment' && Number(r.treatment_id) === id
        && Number(r.appointment_id) === Number(row.id_cita) && Number(r.patient_id) === Number(row.paciente_id)
        && Number(r.clinic_id) === 72 && Number.isSafeInteger(r.actor_id) && r.actor_id > 0
        && /^[a-f0-9]{64}$/.test(r.request_hash || '') && typeof r.reason === 'string';
}
function noteTechnique(value) {
    const text = norm(value);
    if (!/(^|[^A-Z0-9])(EMS|EMMS)([^A-Z0-9]|$)/.test(text)) return null;
    // Do not treat a refusal or several explicit acts as a single EMS act.
    if (/(^|[^A-Z])(NO|SIN|CANCELAR|CANCELADO)\s+(EMS|EMMS)\b/.test(text)
        || /\b(PRESO|PRESOTERAPIA|INDIBA|EXION|CYCLONE|CARBOXITERAPIA)\b/.test(text)) return 'ambiguous';
    return 'ems';
}
function originalMatches(row, index) {
    const m = row.import_metadata || {}, delta = m.cliniccloud_delta?.source;
    const contact = String(m.source_contact_id || delta?.source_contact_id || m.raw?.idContacto || '');
    if (m.source_appointment_id) return [index.byId.get(String(m.source_appointment_id))].filter(Boolean);
    if (delta) return [...index.byId.values()].filter(raw => String(raw.extendedProps?.idContacto) === contact
        && String(raw.start).replace(' ', 'T') === delta.start_local && String(raw.end).replace(' ', 'T') === delta.end_local);
    return [];
}
function notePriorityEvidence(row, snapshot, index) {
    const local = noteTechnique(row.nota);
    if (local === 'ambiguous') return { reason: 'note_contains_negated_or_multiple_techniques' };
    if (local === 'ems') return { note_source: 'clinicaclick_current', note_sha256: hash(row.nota),
        version: 'client-note-precedence/1', client_authorization_date: '2026-10-10', policy_only_no_treatment_reclassification: true };
    if (row.source_system === 'cliniccloud') {
        const matches = originalMatches(row, index);
        if (matches.length === 1 && noteTechnique(matches[0].extendedProps?.detalles) === 'ems') {
            // A later local explicit non-EMS technique must never be replaced
            // by an older EMS source note. Such corrections need individual review.
            if (/\b(PRESO|PRESOTERAPIA|INDIBA|EXION|CYCLONE|CARBOXITERAPIA)\b/.test(norm(row.nota))) return { reason: 'local_note_supersedes_original_ems_requires_review' };
            return { note_source: 'cliniccloud_original', note_sha256: hash(matches[0].extendedProps.detalles),
                version: 'client-note-precedence/1', client_authorization_date: '2026-10-10', policy_only_no_treatment_reclassification: true };
        }
    }
    return null;
}
function sourceEvidence(row, index, unitId, notePriority = null) {
    const m = row.import_metadata || {}, delta = m.cliniccloud_delta?.source;
    if (row.source_system == null || row.source_system === '') {
        if (!notePriority || notePriority.note_source !== 'clinicaclick_current' || !Number(row.created_by)) return { reason: 'manual_ems_creator_or_note_not_accredited' };
        return { recipe_id: 1948, note_priority: notePriority, original_appointment_identity_sha256: hash({ id: row.id_cita,
            patient: row.paciente_id, clinic: row.clinica_id, start: row.inicio, end: row.fin, creator: row.created_by, created_at: row.created_at }),
            manual_creation_original_fields_preserved: true, equivalence: null };
    }
    if (m.source_account !== 'cliniccloud-5880' || m.cliniccloud_source_refreshes) return { reason: 'source_account_or_refresh_unreviewed' };
    const contact = String(m.source_contact_id || delta?.source_contact_id || m.raw?.idContacto || '');
    if (!/^[1-9]\d*$/.test(contact)) return { reason: 'original_contact_identity_missing' };
    let matches;
    if (m.source_appointment_id) matches = [index.byId.get(String(m.source_appointment_id))].filter(Boolean);
    else if (delta) matches = [...index.byId.values()].filter(raw => String(raw.extendedProps?.idContacto) === contact
        && String(raw.start).replace(' ', 'T') === delta.start_local && String(raw.end).replace(' ', 'T') === delta.end_local);
    else return { reason: 'original_visit_identity_missing' };
    if (matches.length !== 1) return { reason: 'original_visit_missing_or_ambiguous' };
    const raw = matches[0], ep = raw.extendedProps || {};
    if (String(ep.idContacto) !== contact || ms(localToUtc(String(raw.start).replace(' ', 'T'))) !== ms(row.inicio)
        || ms(localToUtc(String(raw.end).replace(' ', 'T'))) !== ms(row.fin)
        || delta && (norm(ep.agenda) !== delta.agenda_key || norm(ep.servicio_nombre) !== delta.service_key))
        return { reason: 'original_visit_geometry_or_identity_changed' };
    const patients = index.histories.filter(item => String(item.id) === contact && item.status === 200);
    const histories = patients.flatMap(item => item.data || []).filter(item => String(item.idCita) === String(raw.id));
    const exactHistory = patients.length === 1 && histories.length === 1 && String(histories[0].idContacto) === contact
        && Array.isArray(histories[0].conceptos) && histories[0].conceptos.length;
    if (!exactHistory && !notePriority) return { reason: 'original_full_history_not_unique' };
    const names = exactHistory ? histories[0].conceptos.map(concept => norm(concept.asunto)) : [];
    const service = norm(ep.servicio_nombre);
    if (!names.includes(service) && !notePriority) return { reason: 'original_calendar_history_disagree' };
    let recipeId;
    if (unitId === 11) {
        const literal = service === norm('PRESOTERAPIA CORPORAL 1 SESIÓN');
        // A previously reviewed single PRESO act may have a broader copied
        // source title. Its exact per-appointment resolution, not a free-text
        // note, is the evidence. Never assign the new catalog ID to this visit.
        const reviewed = Number(row.tratamiento_id) === 623 && reviewedTreatment(row, 623)
            && /presoterapia/i.test(m.import_treatment_resolution.reason)
            && /solo|sólo|sin mesoterapia|descarta la mesoterapia/i.test(m.import_treatment_resolution.reason);
        if (Number(row.tratamiento_id) !== 623 || !literal && !reviewed) return { reason: 'presotherapy_single_act_not_accredited' };
        recipeId = 1957;
    } else if (unitId === 5) {
        // The old concept alone is insufficient. The client's explicit note
        // override supplies the technical act without relabeling its catalog ID.
        if (!notePriority && (!/^(EMSHAPE|EMS |EMMS |ELECTROESTIMULACION)/.test(service) || /CYCLONE|INDIBA|MESOTERAPIA/.test(service)))
            return { reason: 'original_ems_technique_contradiction' };
        recipeId = /PELVICO/.test(service) ? 1949 : 1948;
    } else if (unitId === 14) {
        if (service !== norm('INDIBA CORPORAL') || /FACIAL|DEEP\s*CARE|CAPILAR/.test(service)) return { reason: 'indiba_body_single_act_not_accredited' };
        recipeId = 1964; // Policy only, identical to1965; no sale/price/diagnosis mapping.
    } else return { reason: 'technique_outside_approved_recipe_scope' };
    return { recipe_id: recipeId, source_appointment_id: String(raw.id), original_calendar_row_sha256: hash(raw),
        original_history_row_sha256: exactHistory ? hash(histories[0]) : null, source_identity_sha256: hash({ contact, id: String(raw.id), start: iso(row.inicio), end: iso(row.fin) }),
        ...(notePriority ? { note_priority: notePriority, broader_original_title_not_used_to_override_client_note: true } : {}),
        equivalence: unitId === 11 ? { confirmed_client_date: '2026-10-07', historical_treatment_id: 623,
            policy_recipe_id: 1957, room_id: 82, equipment_id: 11, commercial_or_clinical_reclassification: false } : null,
        reviewed_component_resolution_sha256: reviewedTreatment(row, Number(row.tratamiento_id)) ? hash(m.import_treatment_resolution) : null };
}
function resourceContext(snapshot, row) {
    const date = calendar.formatDateLocal(new Date(ms(row.inicio)), 'Europe/Madrid'), dow = calendar.dayIndexFromLocalDate(date);
    const r = snapshot.resources;
    const link = r.professionals.find(item => Number(item.doctor_id) === 221 && Number(item.clinica_id) === 72);
    const horarios = r.doctor_hours.filter(item => Number(item.doctor_clinica_id) === Number(link?.id)).map(item => ({ ...item,
        activo: !!item.activo, excepciones: r.doctor_hour_exceptions.filter(e => Number(e.doctor_horario_id) === Number(item.id)) }));
    const doctorWindows = calendar.buildDoctorAvailabilityContext({ doctorId: 221, clinicaId: 72,
        dc: link ? { ...link, horarios } : null, dow, fechaLocal: date, timeZone: 'Europe/Madrid' }).docWins;
    const room = r.installations.find(item => Number(item.id) === Number(row.instalacion_id));
    const canonicalRoom = Number(r.physical_aliases.find(item => Number(item.installation_id) === Number(row.instalacion_id))?.canonical_installation_id || row.instalacion_id);
    const roomWindows = calendar.buildWindowsFromHorarios(r.room_hours.filter(item => Number(item.instalacion_id) === Number(row.instalacion_id)).map(item => ({ ...item, activo: !!item.activo })), dow, date, 'Europe/Madrid');
    const clinicWindows = calendar.buildWindowsFromHorarios(r.clinic_hours.filter(item => Number(item.clinica_id) === 72).map(item => ({ ...item, activo: !!item.activo })), dow, date, 'Europe/Madrid');
    const activeAppointments = snapshot.appointments.filter(item => Number(item.id_cita) !== Number(row.id_cita) && item.estado !== 'cancelada');
    const ids = new Set(activeAppointments.map(item => Number(item.id_cita)));
    const occupancies = snapshot.occupancies.filter(item => ids.has(Number(item.appointment_id)));
    const busy = occupancies.filter(item => item.resource_key === 'doctor:221').map(item => ({ start: timestamp(item.start_at), end: timestamp(item.end_at), appointment_id: Number(item.appointment_id) }));
    const attentionVisits = activeAppointments.filter(item => Number(item.doctor_id) === 221
        || occupancies.some(o => Number(o.appointment_id) === Number(item.id_cita) && o.doctor_id === 221)).map(item => attentionVisitOrigin({
            appointment: { ...item, inicio: timestamp(item.inicio), fin: timestamp(item.fin),
                booking_attention_snapshot: object(item.import_metadata)?.booking, booking_legacy_attention_snapshot: object(item.import_metadata)?.booking }, doctorId: 221, occupancies: occupancies.map(o => ({ ...o, start_at: timestamp(o.start_at), end_at: timestamp(o.end_at) })) }));
    // Appointments with no occupancy remain full legacy reservations, as in the
    // operational availability loader. Partial legacy source evidence remains
    // unverified and never licenses sharing through an old permission flag.
    for (const item of activeAppointments.filter(item => Number(item.doctor_id) === 221
        && !occupancies.some(o => Number(o.appointment_id) === Number(item.id_cita)))) busy.push({ start: timestamp(item.inicio), end: timestamp(item.fin), appointment_id: Number(item.id_cita) });
    const blocks = r.doctor_blocks.map(item => ({ ...item, fecha_inicio: timestamp(item.fecha_inicio), fecha_fin: timestamp(item.fecha_fin),
        excepciones: r.doctor_block_exceptions.filter(e => Number(e.doctor_bloqueo_id) === Number(item.id)) }));
    busy.push(...calendar.buildDoctorBloqueoRowsForDate(blocks, date, 'Europe/Madrid').map(item => ({ start: item.fecha_inicio, end: item.fecha_fin })));
    return { room, canonicalRoom, roomWindows, clinicWindows, occupancies, activeAppointments,
        doctor: { windows: doctorWindows, busy, attention_visits: attentionVisits, clinic_id: 72 }, link };
}
function eligibility(row, snapshot) {
    const manual = row.source_system == null || row.source_system === '';
    if (Number(row.clinica_id) !== 72 || Number(row.doctor_id) !== 221 || row.source_system !== 'cliniccloud' && !manual) return 'outside_scope';
    if (manual && (ms(row.created_at) < ms(snapshot.scope.manual_created_since) || noteTechnique(row.nota) !== 'ems')) return 'manual_outside_authorized_week_or_ems_note';
    if (ms(row.inicio) <= Date.parse(snapshot.captured_at)) return 'past_or_started_interval';
    if (!['pendiente', 'reprogramada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado'].includes(row.estado)) return 'excluded_appointment_state';
    if (['arrived_at', 'arrived_by', 'care_started_at', 'care_started_by', 'care_completed_at', 'care_completed_by', 'care_schedule_start'].some(key => row[key] != null)
        || Number(row.care_legacy_attendance) === 1 || snapshot.care_events.some(event => Number(event.appointment_id) === Number(row.id_cita))) return 'care_or_arrival_already_recorded';
    const m = row.import_metadata || {};
    if (row.es_provisional || row.hold_expires_at || row.lead_intake_id || row.voucher_id || m.additional_staff || m.program_session
        || m.piedad_preparation_migration || m.booking?.profile?.version === 4) return 'complex_hold_or_already_migrated_reservation';
    if (!manual && (m.cliniccloud_reconciliation?.automation_policy !== 'hold'
        || !['same_day', 'day_before', 'appointment_details'].every(key => m.notification_suppression?.[key] === true))) return 'source_automation_hold_not_accredited';
    if (!manual && (![2, 3].includes(m.booking?.profile?.version) || m.booking?.phases?.length !== 1)) return 'legacy_single_phase_snapshot_required';
    return null;
}
function propose(row, snapshot, index) {
    let reason = eligibility(row, snapshot); if (reason) return { reason };
    const notePriority = notePriorityEvidence(row, snapshot, index); if (notePriority?.reason) return notePriority;
    const duration = (ms(row.fin) - ms(row.inicio)) / 60000;
    const manual = row.source_system == null || row.source_system === '';
    const beforeBooking = row.import_metadata?.booking || (manual ? { version: 1, profile: { version: 1, phases: [{ key: 'appointment', label: '',
        duration_minutes: duration, installation_ids: [Number(row.instalacion_id)], professionals: { mode: 'any', ids: [221], preferred_id: 221 } }] },
        phases: [{ key: 'appointment', label: '', start_at: iso(row.inicio), end_at: iso(row.fin), installation_id: Number(row.instalacion_id),
            doctor_ids: [221], staff_time_scope: 'phase' }] } : null);
    if (!beforeBooking || beforeBooking.phases?.length !== 1) return { reason: 'legacy_single_phase_snapshot_required' };
    const actual = beforeBooking.phases[0], oldUnitId = actual.equipment?.[0]?.id, unitId = notePriority ? 5 : oldUnitId;
    if (!RECIPES[unitId] || (actual.equipment?.length || 0) > 1 || !oldUnitId && !manual) return { reason: 'technique_outside_approved_recipe_scope' };
    if (!bookingSegments({ ...row, import_metadata: { ...row.import_metadata, booking: beforeBooking }, inicio: timestamp(row.inicio), fin: timestamp(row.fin) }).length
        || actual.doctor_ids?.length !== 1 || actual.doctor_ids[0] !== 221 || actual.installation_id !== Number(row.instalacion_id)
        || actual.staff_time_scope !== 'phase') return { reason: 'old_snapshot_geometry_or_staff_invalid' };
    const evidence = sourceEvidence(row, index, unitId, notePriority); if (evidence.reason) return evidence;
    const recipe = snapshot.treatments.find(item => Number(item.id_tratamiento) === evidence.recipe_id);
    const recipeProfile = object(recipe?.clinical_config)?.booking_profile;
    const policy = { mode: unitId === 14 ? 'start_continuous' : 'start_only', start_minutes: 5, start_window_minutes: 15 };
    if (!recipe || Number(recipe.activo) !== 1 || recipeProfile?.version !== 4 || recipeProfile.phases?.length !== 1
        || !same(recipeProfile.phases[0].staff_attention, [policy]) || !same(recipeProfile.phases[0].preparation_sharing, { mode: 'same_start' })
        || !recipeProfile.phases[0].installation_ids.includes(Number(row.instalacion_id))
        || !recipeProfile.phases[0].professionals.ids.includes(221)
        || !recipeProfile.phases[0].equipment_requirements?.some(g => g.equipment_ids.includes(unitId))) return { reason: 'approved_active_recipe_drift' };
    if (!Number.isInteger(duration) || duration < 15) return { reason: 'original_duration_cannot_fit_preparation_window' };
    const profile = sharedPreparationRecipe({ phases: [{ ...beforeBooking.profile.phases[0], duration_minutes: duration,
        equipment_requirements: [{ equipment_ids: [unitId] }] }] }, { continuousAfterPreparation: unitId === 14 });
    const context = resourceContext(snapshot, row), span = { start: timestamp(row.inicio), end: timestamp(row.fin) };
    const oldOccupancies = snapshot.occupancies.filter(item => Number(item.appointment_id) === Number(row.id_cita));
    const oldExpected = occupancyForSolution({ phases: [actual] }, new Map([[Number(row.instalacion_id), `installation:${context.canonicalRoom}`]]));
    if (!same(occupancySignature(oldExpected), occupancySignature(oldOccupancies))) return { reason: 'old_snapshot_occupancy_mismatch' };
    if (!context.link || !Number(context.link.activo) || !Number(context.link.recibe_citas) || !context.room || !Number(context.room.activo)
        || !installationAllowsStaff(context.room, [221])) return { reason: 'current_staff_room_assignment_not_verified' };
    const unit = snapshot.resources.equipment.find(item => Number(item.id) === unitId);
    const unitMembership = snapshot.resources.equipment_memberships.some(item => Number(item.equipment_id) === unitId && Number(item.clinic_id) === 72);
    const roomPolicy = snapshot.resources.equipment_room_policies.find(item => Number(item.installation_id) === Number(row.instalacion_id));
    if (!unitMembership || !equipmentFitsRoom({ ...unit, fixed_resource_key: `installation:${Number(unit?.home_installation_id)}` },
        { resource_key: `installation:${context.canonicalRoom}`, equipment_policy: roomPolicy })
        || !Number.isInteger(Number(unit.turnaround_minutes)) || Number(unit.turnaround_minutes) !== 0
        || oldUnitId && (!Number.isInteger(actual.equipment[0].turnaround_minutes) || actual.equipment[0].turnaround_minutes !== 0)
        || oldUnitId === unitId && Number(unit.turnaround_minutes) !== actual.equipment[0].turnaround_minutes
        || oldUnitId !== unitId && Number(unit.turnaround_minutes) !== 0) return { reason: 'physical_machine_compatibility_or_buffer_drift' };
    if (!calendar.inAnyWindow(context.clinicWindows, new Date(ms(row.inicio)), new Date(ms(row.fin)))
        || !calendar.inAnyWindow(context.roomWindows, new Date(ms(row.inicio)), new Date(ms(row.fin)))) return { reason: 'clinic_or_room_hours_not_verified' };
    const physical = oldOccupancies.filter(item => item.resource_kind !== 'doctor');
    const plannedPhysical = [...physical.filter(item => item.resource_kind !== 'equipment'),
        { resource_kind: 'equipment', resource_key: `equipment:${unitId}`, start_at: actual.start_at, end_at: actual.end_at }];
    if (plannedPhysical.some(item => context.occupancies.some(other => item.resource_key === other.resource_key
        && overlaps({ start: timestamp(item.start_at), end: timestamp(item.end_at) }, { start: timestamp(other.start_at), end: timestamp(other.end_at) })))) return { reason: 'existing_physical_room_or_machine_collision' };
    const canonicalKey = id => Number(snapshot.resources.physical_aliases.find(alias => Number(alias.installation_id) === Number(id))?.canonical_installation_id || id);
    const roomBlocks = snapshot.resources.room_blocks.filter(item => canonicalKey(item.instalacion_id) === context.canonicalRoom);
    // The operational room-block model has recurrence but no exception model.
    // Do not pretend the original timestamps describe a recurring occurrence.
    // Until room recurrence has an exact canonical expansion, fail closed.
    if (roomBlocks.some(item => ![null, undefined, 'none'].includes(item.recurrente))) return { reason: 'recurring_physical_room_block_requires_review' };
    if (roomBlocks.some(item => overlaps(span, { start: timestamp(item.fecha_inicio), end: timestamp(item.fecha_fin) }))) return { reason: 'existing_room_block' };
    if (context.activeAppointments.some(item => Number(item.paciente_id) === Number(row.paciente_id)
        && overlaps(span, { start: timestamp(item.inicio), end: timestamp(item.fin) }))) return { reason: 'existing_patient_overlap' };
    const conflict = attentionVisitConflict(context.doctor, { phase: profile.phases[0], visitStart: timestamp(row.inicio),
        ...span, policies: [policy] });
    if (conflict) return { reason: conflict.code };
    const decision = assessStaffAttentionSteps({ resource: context.doctor, steps: [{ key: actual.key, ...span, policies: [policy] }] });
    if (decision.status !== 'planned') return { reason: `staff_preparation_${decision.status}` };
    const phase = { ...clone(actual), equipment: [{ id: unitId, name: unit.name, turnaround_minutes: Number(unit.turnaround_minutes) }],
        start_offset_minutes: 0, staff_attention: [policy], preparation_sharing: { mode: 'same_start' },
        staff_intervals: decision.steps[0].staff_intervals, staff_time_scope: 'phase' };
    const booking = { ...clone(beforeBooking), profile: normalizeBookingProfile(profile), phases: [phase],
        attention_requirements_pending: [], capacity_fully_verified: true };
    const after = materializeAppointment(row);
    after.import_metadata = { ...(after.import_metadata || {}), booking };
    after.import_metadata.piedad_preparation_migration = { version: 1, policy: 'five_minutes_within_first_fifteen_same_start',
        policy_recipe_id: evidence.recipe_id, preserved_original_treatment_id: row.tratamiento_id, source_evidence: evidence,
        old_booking_sha256: hash(row.import_metadata?.booking || null), new_booking_sha256: hash(booking), snapshot_sha256: snapshot.snapshot_sha256,
        approved_policy_date: '2026-10-07', notifications_dispatched: false, source_identity_changed: false };
    const newOccupancies = occupancyForSolution({ phases: [phase] }, new Map([[Number(row.instalacion_id), `installation:${context.canonicalRoom}`]]));
    if (!same(occupancySignature(physical.filter(item => item.resource_kind !== 'equipment')),
        occupancySignature(newOccupancies.filter(item => item.resource_kind === 'installation')))
        || oldUnitId !== unitId && (unitId !== 5 || !notePriority)) fail('BS_APPOINTMENT_UNAUTHORIZED_PHYSICAL_RESERVATION_CHANGED');
    if (!bookingSegments({ ...after, inicio: timestamp(after.inicio), fin: timestamp(after.fin) }).length) fail('BS_APPOINTMENT_NEW_SNAPSHOT_INVALID');
    const origin = attentionVisitOrigin({ appointment: { ...after, inicio: timestamp(after.inicio), fin: timestamp(after.fin), booking_attention_snapshot: booking },
        doctorId: 221, occupancies: newOccupancies.map(item => ({ ...item, appointment_id: Number(row.id_cita) })) });
    if (!origin.verified) fail('BS_APPOINTMENT_NEW_ORIGIN_NOT_VERIFIED');
    const body = { appointment_id: Number(row.id_cita), clinic_id: 72, doctor_id: 221, equipment_id: unitId, policy_recipe_id: evidence.recipe_id,
        before: materializeAppointment(row), after, before_row_sha256: currentRowHash(row), target_data_sha256: appointmentDataHash(after),
        before_occupancies: clone(oldOccupancies), after_occupancies: newOccupancies,
        before_occupancy_sha256: hash(oldOccupancies), physical_occupancy_signature: occupancySignature(physical),
        after_physical_occupancy_signature: occupancySignature(newOccupancies.filter(item => item.resource_kind !== 'doctor')),
        equipment_correction: oldUnitId === unitId ? null : { client_authorization_date: '2026-10-10', note_priority: notePriority,
            old_equipment_id: oldUnitId || null, new_equipment_id: 5, preserved_room_id: Number(row.instalacion_id), preserved_full_visit_interval: true },
        competing_reservation_evidence_sha256: hash(competingReservationEvidence(snapshot, row)),
        resource_keys: [...new Set([...oldOccupancies.map(item => item.resource_key), ...newOccupancies.map(item => item.resource_key), `patient:${Number(row.paciente_id)}`])].sort(),
        released_doctor_minutes: oldOccupancies.filter(item => item.resource_kind === 'doctor').reduce((n, item) => n + (ms(item.end_at) - ms(item.start_at)) / 60000, 0)
            - newOccupancies.filter(item => item.resource_kind === 'doctor').reduce((n, item) => n + (ms(item.end_at) - ms(item.start_at)) / 60000, 0) };
    return { operation: { ...body, operation_sha256: hash(body) } };
}
function buildPiedadAppointmentPlan({ snapshot, calendarSource, historySource, sourceFileHashes }) {
    scopeCheck(snapshot);
    if (!same(sourceFileHashes, SOURCE_FILES)) fail('BS_APPOINTMENT_PINNED_ORIGINAL_FILES_CHANGED');
    const index = sourceIndex(calendarSource, historySource), operations = [], records = [];
    for (const input of snapshot.targets) {
        const row = materializeAppointment(input), decision = propose(row, snapshot, index);
        if (decision.operation) operations.push(decision.operation);
        records.push({ appointment_id: Number(row.id_cita), clinic_id: Number(row.clinica_id),
            status: decision.operation ? 'ready' : 'blocked', reason: decision.reason || null,
            policy_recipe_id: decision.operation?.policy_recipe_id || null, existing_profile_version: row.import_metadata?.booking?.profile?.version || null });
    }
    const plannedIds = operations.map(op => op.appointment_id);
    for (const op of operations) {
        op.competing_reservation_evidence_sha256 = hash(competingReservationEvidence(snapshot, op.before,
            { resourceKeys: op.resource_keys, excludedAppointmentIds: plannedIds, plannedOccupancies: [...op.before_occupancies, ...op.after_occupancies] }));
        const { operation_sha256, ...body } = op; op.operation_sha256 = hash(body);
    }
    assertFinalCapacity(snapshot, operations);
    const byReason = records.filter(row => row.reason).reduce((result, row) => ({ ...result, [row.reason]: (result[row.reason] || 0) + 1 }), {});
    const body = { version: VERSION, target: 'crm', database: snapshot.database, snapshot_sha256: snapshot.snapshot_sha256,
        captured_at: snapshot.captured_at, scope: snapshot.scope, source_file_hashes: sourceFileHashes, field_whitelist: FIELD_WHITELIST,
        resource_snapshot_sha256: hash({ clinics: snapshot.clinics, resources: snapshot.resources, treatments: snapshot.treatments }),
        operations, records, summary: { future_imported_candidates: snapshot.targets.length, ready: operations.length,
            blocked: records.length - operations.length, blocked_by_reason: byReason, historical_appointments_excluded: snapshot.historical_counts.reduce((n, row) => n + Number(row.total), 0),
            capilar_future_candidates: snapshot.targets.filter(row => Number(row.clinica_id) === 66).length,
            released_doctor_minutes: operations.reduce((n, op) => n + op.released_doctor_minutes, 0),
            manual_ems_candidates: snapshot.targets.filter(row => row.source_system !== 'cliniccloud').length,
            authorized_ems_equipment_corrections: operations.filter(op => op.equipment_correction).length,
            patient_or_room_times_or_treatment_ids_changed: 0, messages_or_financial_events: 0 } };
    return { ...body, plan_sha256: hash(body) };
}
function assertFinalCapacity(snapshot, operations) {
    const byId = new Map(operations.map(op => [op.appointment_id, op]));
    const final = { ...snapshot, appointments: snapshot.appointments.map(row => byId.get(Number(row.id_cita))?.after || row),
        occupancies: [...snapshot.occupancies.filter(row => !byId.has(Number(row.appointment_id))),
            ...operations.flatMap(op => op.after_occupancies.map(row => ({ ...row, appointment_id: op.appointment_id })))] };
    const activeIds = new Set(final.appointments.filter(row => row.estado !== 'cancelada').map(row => Number(row.id_cita)));
    for (const op of operations) {
        const ownPhysical = final.occupancies.filter(row => Number(row.appointment_id) === op.appointment_id && row.resource_kind !== 'doctor');
        if (ownPhysical.some(row => final.occupancies.some(other => Number(other.appointment_id) !== op.appointment_id
            && activeIds.has(Number(other.appointment_id)) && row.resource_key === other.resource_key
            && overlaps({ start: row.start_at, end: row.end_at }, { start: timestamp(other.start_at), end: timestamp(other.end_at) }))))
            fail('BS_APPOINTMENT_FINAL_BATCH_PHYSICAL_COLLISION');
    }
    for (const op of operations) {
        const context = resourceContext(final, op.after), phase = op.after.import_metadata.booking.phases[0];
        const conflict = attentionVisitConflict(context.doctor, { phase, visitStart: timestamp(op.after.inicio),
            start: timestamp(op.after.inicio), end: timestamp(op.after.fin), policies: phase.staff_attention });
        if (conflict || phase.staff_intervals.some(interval => !calendar.inAnyWindow(context.doctor.windows,
            new Date(interval.start_at), new Date(interval.end_at)) || context.doctor.busy.some(busy => overlaps(
                { start: interval.start_at, end: interval.end_at }, busy)))) fail('BS_APPOINTMENT_FINAL_BATCH_ATTENTION_COLLISION');
    }
    return true;
}
function verifyPiedadAppointmentPlan(plan, inputs) {
    const rebuilt = buildPiedadAppointmentPlan(inputs);
    if (!same(plan, rebuilt)) fail('BS_APPOINTMENT_PLAN_NOT_EXACTLY_REPRODUCIBLE');
    return true;
}
module.exports = { VERSION, SOURCE_FILES, FIELD_WHITELIST, RECIPES, buildPiedadAppointmentPlan, verifyPiedadAppointmentPlan,
    materializeAppointment, currentRowHash, appointmentDataHash, occupancySignature, timestamp, eligibility, sourceEvidence, resourceContext,
    competingReservationEvidence, assertFinalCapacity, noteTechnique };
