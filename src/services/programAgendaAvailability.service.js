'use strict';

// Read-only projection of an already scoped, server-owned plan. This module
// cannot accept a profile, release SQL occupancy or persist a reservation.
const { domainError } = require('../lib/treatmentPrograms.contract');
const { bookingRequest, materializeSession, seriesIssues } = require('../lib/program-booking');
const { normalizePreferences, allowedInterval } = require('../lib/program-booking-preferences');
const { cloneProgramContext } = require('../lib/program-schedule-confirmation');
const { solveBookingProfile } = require('../lib/booking-profile-solver');
const { solutionsForCalendar } = require('./appointmentBookingAvailability.service');
const { startConflict, appendStartInterval, incompatibleStart } = require('../lib/booking-grid-diagnostics');
const { formatLocal } = require('../lib/availability-calendar');
const { addDays, normalizeDateOnly } = require('../lib/personal-schedule-recurring');
const { localInstant } = require('../lib/program-reschedule');
const fail = (code, message, status = 400) => { throw domainError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const topFields = ['clinic_id', 'patient_id', 'expected_version', 'snapshot_sha256', 'plan_revision', 'active_key', 'sessions', 'preferences',
  'mode', 'replan_from_key', 'expected_plan_revision', 'reschedule_scope', 'reschedule_reason', 'grid'];

function normalizeGrid(payload) {
  if (!keys(payload, topFields) || !keys(payload.grid, ['dates', 'mode', 'column_ids', 'peer_instalacion_ids', 'peer_doctor_ids',
    'context_instalacion_id', 'context_doctor_id', 'preferred_instalacion_id', 'granularity_min', 'from_local', 'to_local'])) {
    fail('program_grid_invalid', 'Actualiza la disponibilidad de esta sesión.');
  }
  const grid = payload.grid;
  const ids = (value, required = false) => {
    if (value == null && !required) return [];
    if (!Array.isArray(value) || (required && !value.length) || value.length > 80 || value.some(id => !positive(id))
      || new Set(value).size !== value.length) fail('program_grid_invalid', 'Revisa los recursos visibles de esta agenda.');
    return value;
  };
  if (!Array.isArray(grid.dates) || !grid.dates.length || grid.dates.length > 7 || grid.dates.some(date => typeof date !== 'string' || normalizeDateOnly(date) !== date)
    || new Set(grid.dates).size !== grid.dates.length || !['doctor', 'installation'].includes(grid.mode)) {
    fail('program_grid_invalid', 'Elige entre uno y siete días válidos de la agenda.');
  }
  const sorted = [...grid.dates].sort();
  if (new Date(sorted.at(-1) + 'T12:00Z') - new Date(sorted[0] + 'T12:00Z') > 31 * 86400000) fail('program_grid_invalid', 'El rango visible no puede superar treinta y un días.');
  const step = grid.granularity_min ?? 5;
  if (!Number.isInteger(step) || step < 5 || step > 120 || step % 5) fail('program_grid_invalid', 'La precisión debe ser un múltiplo de cinco minutos entre cinco y ciento veinte.');
  for (const field of ['context_instalacion_id', 'context_doctor_id', 'preferred_instalacion_id']) {
    if (grid[field] != null && grid[field] !== 'todos' && !positive(grid[field])) fail('program_grid_invalid', 'Revisa el recurso de contexto.');
  }
  const clock = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (grid.from_local != null && !clock(grid.from_local) || grid.to_local != null && !clock(grid.to_local)
    || grid.from_local && grid.to_local && grid.from_local >= grid.to_local) fail('program_grid_invalid', 'Revisa el intervalo visible de la agenda.');
  const columns = ids(grid.column_ids, true), rooms = ids(grid.peer_instalacion_ids), doctors = ids(grid.peer_doctor_ids);
  if (grid.mode === 'doctor' && doctors.length || grid.mode === 'installation' && rooms.length) fail('program_grid_invalid', 'Revisa los recursos de la orientación elegida.');
  return { ...grid, column_ids: columns, peer_instalacion_ids: rooms, peer_doctor_ids: doctors, granularity_min: step };
}

function draftRows({ plan, eligible, payload, now }) {
  const supplied = payload.sessions;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(payload.active_key || '') || !Array.isArray(supplied) || !supplied.length || supplied.length > 30
    || supplied.length !== eligible.length || new Set(supplied.map(row => row?.key)).size !== supplied.length
    || supplied.some(row => !keys(row, ['key', 'start_at', 'placed', 'duration_minutes', 'phase_durations', 'selections', 'priority_acknowledged'])
      || typeof row.placed !== 'boolean' || !eligible.some(session => session.key === row.key) || row.placed && row.start_at == null)) {
    fail('program_grid_sessions_invalid', 'Conserva las sesiones del tramo elegido y selecciona la sesión activa.');
  }
  const placeholder = new Date(Math.ceil((+now + 60000) / 60000) * 60000).toISOString();
  const rows = eligible.map(session => {
    const input = supplied.find(row => row.key === session.key);
    const choice = bookingRequest({ request_key: 'program-grid-read', snapshot_sha256: plan.snapshot.sha256,
      sessions: [{ ...input, start_at: input.start_at ?? placeholder }] }).sessions[0];
    if (input.start_at != null && (+new Date(choice.start_at) <= +now || +new Date(choice.start_at) - now > 366 * 86400000)) {
      fail('program_grid_date_invalid', 'Las fechas provisionales deben ser futuras y estar dentro del próximo año.');
    }
    let materialized, template = session, legacyProfiles;
    if (plan.legacy) {
      const explicit = session.booking_profile.phases.every(phase => {
        const selected = choice.selections[phase.key];
        return selected && phase.professionals.ids.includes(selected.doctor_id) && phase.installation_ids.includes(selected.installation_id);
      });
      if (!explicit && session.key !== payload.active_key && input.start_at != null) {
        fail('agenda_origin_resources_required', 'Selecciona una sala y un profesional para esta sesión.', 422);
      }
      // Legacy has no configured priority. The native series writer uses the
      // explicit chosen professional; use that choice only in this read model,
      // without inventing a catalog priority or accepting new resource IDs.
      if (session.key === payload.active_key) {
        // "All" is a search, not a booking choice. Materialize the legacy
        // duration for each server-authorized candidate professional. Only the
        // candidate's own temporary profile reaches its solver call below.
        legacyProfiles = new Map(session.booking_profile.phases[0].professionals.ids.map(doctor => {
          const candidate = { ...session, booking_profile: { ...session.booking_profile,
            phases: session.booking_profile.phases.map(phase => ({ ...phase, professionals: { ...phase.professionals, preferred_id: doctor } })) } };
          return [doctor, materializeSession(candidate, choice)];
        }));
        materialized = legacyProfiles.values().next().value;
      } else if (explicit) template = { ...session, booking_profile: { ...session.booking_profile,
        phases: session.booking_profile.phases.map(phase => ({ ...phase, professionals: { ...phase.professionals,
          preferred_id: choice.selections[phase.key].doctor_id } })) } };
      else return { ...session, choice, start_at: null, end_at: null };
    }
    try { materialized ||= materializeSession(template, choice); }
    catch (error) {
      if (error.code !== 'program_duration_required' || session.key === payload.active_key || input.start_at != null) throw error;
      materialized = session;
    }
    for (const [key, selected] of Object.entries(choice.selections)) {
      const phase = materialized.booking_profile.phases.find(item => item.key === key);
      if (!phase || selected.installation_id != null && !phase.installation_ids.includes(selected.installation_id)
        || selected.doctor_id != null && (phase.professionals.mode === 'all' ? !phase.professionals.ids.includes(selected.doctor_id)
          : !phase.professionals.ids.includes(selected.doctor_id))) fail('program_selection_invalid', 'Los recursos elegidos no pertenecen a esta sesión.');
    }
    return { ...materialized, ...(legacyProfiles ? { legacyProfiles } : {}), choice, start_at: input.start_at == null ? null : choice.start_at,
      end_at: input.start_at == null ? null : new Date(+new Date(choice.start_at) + materialized.duration_minutes * 60000).toISOString() };
  });
  if (!rows.some(row => row.key === payload.active_key)) fail('program_grid_active_invalid', 'La sesión activa no pertenece al tramo elegido.');
  return rows;
}

async function assertGridScope(db, plan, grid) {
  const clinicId = Number(plan.clinic.id_clinica), value = id => positive(id) ? [id] : [];
  const doctors = [...new Set([...(grid.mode === 'doctor' ? grid.column_ids : grid.peer_doctor_ids), ...value(grid.context_doctor_id)])];
  const rooms = [...new Set([...(grid.mode === 'installation' ? grid.column_ids : grid.peer_instalacion_ids),
    ...value(grid.context_instalacion_id), ...value(grid.preferred_instalacion_id)])];
  const [staff, installations] = await Promise.all([
    doctors.length ? db.DoctorClinica.findAll({ where: { clinica_id: clinicId, doctor_id: { [db.Sequelize.Op.in]: doctors } },
      attributes: ['doctor_id', 'activo', 'recibe_citas'], skipSharedScheduleProjection: true }) : [],
    rooms.length ? db.Instalacion.findAll({ where: { clinica_id: clinicId, id: { [db.Sequelize.Op.in]: rooms } }, attributes: ['id', 'activo'] }) : [],
  ]);
  if (doctors.some(id => !staff.some(row => Number(row.doctor_id) === id)) || rooms.some(id => !installations.some(row => Number(row.id) === id))) {
    fail('program_grid_resource_scope', 'Un recurso visible ya no pertenece a esta clínica.', 404);
  }
  return { doctors: new Set(staff.filter(row => [true, 1].includes(row.activo) && [true, 1].includes(row.recibe_citas)).map(row => Number(row.doctor_id))),
    rooms: new Set(installations.filter(row => [true, 1].includes(row.activo)).map(row => Number(row.id))) };
}

async function availabilityGrid({ db, plan, payload, eligible, revision, actorId, now, contextFor, addVirtualBusy,
  supportIds = () => [], supportAvailable = () => true }) {
  const grid = normalizeGrid(payload);
  if (typeof payload.snapshot_sha256 !== 'string' || payload.snapshot_sha256 !== plan.snapshot.sha256
    || typeof payload.plan_revision !== 'string' || payload.plan_revision !== revision) {
    fail('program_grid_plan_changed', 'Las sesiones o el tratamiento han cambiado. Actualiza la planificación.', 409);
  }
  const preferences = normalizePreferences(payload.preferences), rows = draftRows({ plan, eligible, payload, now });
  const active = rows.find(row => row.key === payload.active_key);
  const phase = active.booking_profile.version === 4
    ? active.booking_profile.phases.reduce((first, item) => item.start_offset_minutes < first.start_offset_minutes ? item : first)
    : active.booking_profile.phases[0];
  const scopeGrid = plan.legacy && grid.mode === 'installation' && !positive(grid.context_doctor_id) && !grid.peer_doctor_ids.length
    ? { ...grid, peer_doctor_ids: phase.professionals.ids } : grid;
  const scope = await assertGridScope(db, plan, scopeGrid);
  const fixed = id => positive(id) ? id : null;
  function columnPairs(id) {
    const doctor = grid.mode === 'doctor' ? id : fixed(grid.context_doctor_id);
    const room = fixed(grid.context_instalacion_id) || (grid.mode === 'installation' ? id : fixed(grid.preferred_instalacion_id));
    const peers = grid.mode === 'doctor' && !room ? grid.peer_instalacion_ids : grid.mode === 'installation' && !doctor
      ? grid.peer_doctor_ids.length ? grid.peer_doctor_ids : plan.legacy ? phase.professionals.ids : [] : [];
    return { doctor, room, peers, pairs: peers.length ? peers.map(peer => [doctor || peer, room || peer]) : [[doctor, room]] };
  }
  const pairKey = (doctor, room) => `${phase.professionals.mode === 'all' ? 'team' : doctor || ''}:${room || ''}`;
  const solverPairs = new Set(grid.column_ids.flatMap(id => columnPairs(id).pairs)
    .filter(([doctor, room]) => (!doctor || scope.doctors.has(doctor)) && (!room || scope.rooms.has(room))
      && !incompatibleStart({ ...active.booking_profile, phases: [phase] }, doctor, room)).map(([doctor, room]) => pairKey(doctor, room)));
  const minutes = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const visibleMinutes = (grid.to_local ? minutes(grid.to_local) : 1440) - (grid.from_local ? minutes(grid.from_local) : 0);
  // Incompatible/inactive columns produce one constant interval. Budget only
  // the canonical solver calls, so "All rooms/professionals" remains usable.
  if (grid.dates.length * solverPairs.size * Math.ceil(visibleMinutes / grid.granularity_min) > 50000) {
    fail('program_grid_too_large', 'Reduce los días o recursos visibles para revisar esta sesión.');
  }
  const sorted = [...grid.dates].sort();
  const from = localInstant(sorted[0] + 'T00:00', plan.timeZone), through = localInstant(addDays(sorted.at(-1), 1) + 'T00:00', plan.timeZone);
  const timed = rows.filter(row => row.start_at && row.key !== active.key);
  const lower = new Date(Math.min(+from, ...timed.map(row => +new Date(row.start_at))));
  const upper = new Date(Math.max(+through, ...timed.map(row => +new Date(row.end_at))));
  if (+upper - lower > 367 * 86400000) fail('program_grid_too_large', 'Las fechas provisionales abarcan demasiado tiempo.');
  const ignored = eligible.filter(row => row.scheduling_status === 'reserved').map(row => Number(row.appointment.id_cita));
  const base = await contextFor(plan, rows.filter(row => row.duration_minutes != null), lower, upper, null, false, ignored);
  const context = cloneProgramContext(base);
  for (const sibling of timed.sort((a, b) => a.position - b.position)) {
    const solution = solveBookingProfile({ profile: sibling.booking_profile, ...context, start: new Date(sibling.start_at), selections: sibling.choice.selections });
    if (!solution || !supportAvailable(context, solution, supportIds(sibling))
      || context.patientBusy.some(busy => +new Date(busy.start) < +new Date(sibling.end_at) && +new Date(busy.end) > +new Date(sibling.start_at))) {
      fail('program_grid_sibling_unavailable', 'Una propuesta conservada requiere revisión antes de calcular esta sesión.', 409);
    }
    addVirtualBusy(context, solution, supportIds(sibling), sibling.booking_profile);
  }
  const cached = new Map();
  function pair(date, doctorId, roomId) {
    const mismatch = doctorId && !scope.doctors.has(doctorId)
      ? startConflict('resource_not_enabled', 'Este profesional no recibe citas o su asignación está inactiva.', 'staff', doctorId, active.duration_minutes)
      : roomId && !scope.rooms.has(roomId)
        ? startConflict('resource_not_enabled', 'Esta instalación está inactiva.', 'installation', roomId, active.duration_minutes)
        : incompatibleStart({ ...active.booking_profile, phases: [phase] }, doctorId, roomId);
    if (mismatch) {
      const unavailable = [];
      appendStartInterval(unavailable, localInstant(date + 'T' + (grid.from_local || '00:00'), plan.timeZone),
        grid.to_local ? localInstant(date + 'T' + grid.to_local, plan.timeZone) : localInstant(addDays(date, 1) + 'T00:00', plan.timeZone),
        mismatch, plan.timeZone, formatLocal);
      return { slots: [], unavailable };
    }
    const cacheKey = date + ':' + pairKey(doctorId, roomId);
    if (cached.has(cacheKey)) return cached.get(cacheKey);
    const profile = active.legacyProfiles?.get(doctorId)?.booking_profile || active.booking_profile;
    const choices = { ...active.choice.selections, [phase.key]: { ...(active.choice.selections[phase.key] || {}),
      ...(phase.professionals.mode === 'any' && doctorId ? { doctor_id: doctorId } : {}), ...(roomId ? { installation_id: roomId } : {}) } };
    const failures = new Map();
    const slots = solutionsForCalendar({ profile, context, date, stepMinutes: grid.granularity_min, now,
      selections: choices, additionalStaffIds: supportIds(active), limit: 500, fromLocal: grid.from_local || '00:00', toLocal: grid.to_local || null,
      allowConfirmedOverlap: false, allowRestrictionProposals: false,
      onUnavailable: (instant, reason) => failures.set(+instant, reason) }).filter(solution => {
      const series = plan.sessions.map(original => original.key === active.key ? { ...active, start_at: solution.start_at, end_at: solution.end_at }
        : rows.find(row => row.key === original.key) || original);
      const issues = seriesIssues(series, plan.snapshot.cadence, plan.timeZone);
      const reason = issues[0] ? startConflict(issues[0].code, issues[0].message, 'clinic', null, active.duration_minutes)
        : !allowedInterval(preferences, solution.start_at, solution.end_at, plan.timeZone)
          ? startConflict('program_preference_excluded', 'La fecha queda fuera de las preferencias de esta planificación.', 'clinic', null, active.duration_minutes) : null;
      if (reason) failures.set(+new Date(solution.start_at), reason);
      return !reason;
    });
    const unavailable = [], rangeEnd = grid.to_local ? localInstant(date + 'T' + grid.to_local, plan.timeZone)
      : localInstant(addDays(date, 1) + 'T00:00', plan.timeZone);
    for (const [time, reason] of [...failures].sort(([a], [b]) => a - b)) appendStartInterval(unavailable, new Date(time),
      new Date(Math.min(time + grid.granularity_min * 60000, +rangeEnd)), reason, plan.timeZone, formatLocal);
    const result = { slots, unavailable }; cached.set(cacheKey, result); return result;
  }
  const output = [];
  for (const date of grid.dates) for (const id of grid.column_ids) {
    const { doctor, room, peers } = columnPairs(id);
    const common = { day_id: date, column_id: String(id), ok: true };
    if (peers.length) {
      const results = peers.map(peer => [peer, pair(date, doctor || peer, room || peer)]);
      const kind = grid.mode === 'doctor' ? 'instalacion' : 'doctor';
      output.push({ ...common, ['slots_by_' + kind]: Object.fromEntries(results.map(([key, value]) => [key, value.slots])),
        ['unavailable_by_' + kind]: Object.fromEntries(results.map(([key, value]) => [key, value.unavailable])) });
    } else {
      const result = pair(date, doctor, room); output.push({ ...common, slots: result.slots, unavailable_intervals: result.unavailable });
    }
  }
  return { clinica_id: Number(plan.clinic.id_clinica), dates: grid.dates, mode: grid.mode, duracion_min: active.duration_minutes,
    granularity_min: grid.granularity_min, columns: grid.column_ids.map(String), personal_blocks: context.personalBlocks || [], rows: output,
    active_key: active.key, snapshot_sha256: plan.snapshot.sha256, plan_revision: revision, timezone: plan.timeZone,
    ...(plan.source ? { source: plan.source } : {}) };
}

module.exports = { availabilityGrid, normalizeGrid };
