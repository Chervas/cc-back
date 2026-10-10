'use strict';

// Pure owned resources and actual production services. Never imports the app's
// model index or opens SQL/HTTP/provider connections.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../../lib/booking-profile');
const { resolveLocalInstant } = require('../../../lib/voucher-schedule-calendar');

function referenceCalendarService() {
  const filename = require.resolve('../../../services/appointmentBookingAvailability.service');
  let source = fs.readFileSync(filename, 'utf8');
  const optimized = "      const localTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;\n      if (localTime < fromLocal || (toLocal && localTime >= toLocal)) continue;\n      // A bound excludes a start before any resource/solver work. Do not pay\n      // the DST conversion cost for hours outside the requested visible range.\n      let candidate;\n      try { candidate = resolveInstant(localDate, `${localTime}:00`, timeZone); }\n      catch (error) { if (error.code === 'voucher_schedule_dst_conflict') continue; throw error; }";
  const previous = "      let candidate;\n      try { candidate = resolveInstant(localDate, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, timeZone); }\n      catch (error) { if (error.code === 'voucher_schedule_dst_conflict') continue; throw error; }\n      const localTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;\n      if (localTime < fromLocal || (toLocal && localTime >= toLocal)) continue;";
  assert.equal(source.split(optimized).length, 2, 'Reference reverses exactly the range-before-clock optimization');
  source = source.replace(optimized, previous);
  const isolated = new Module(filename, module);
  isolated.filename = filename; isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated._compile(source, filename);
  return isolated.exports;
}

function calendarFixture({ dates = ['2030-01-07'], timeZone = 'Europe/Madrid', version = 4,
  phases = 1, roomCount = 2, doctorCount = 2, dense = false, equipment = false, allStaff = false } = {}) {
  const roomIds = Array.from({ length: roomCount }, (_, i) => 101 + i);
  const doctorIds = Array.from({ length: doctorCount }, (_, i) => 1 + i);
  const windows = dates.map(date => ({ start: resolveLocalInstant(date, '09:00:00', timeZone),
    end: resolveLocalInstant(date, '20:00:00', timeZone) }));
  const resource = name => ({ name, windows, schedule_windows: windows, busy: [], absence_windows: [],
    attention_visits: [], schedule_verified: true, profesionales_permitidos: doctorIds });
  const context = { timeZone, clinicWindows: windows, patientBusy: [], personalBlocks: [],
    doctors: new Map(doctorIds.map(id => [id, resource(`Profesional ficticio ${id}`)])),
    installations: new Map(roomIds.map(id => [id, { ...resource(`Sala ficticia ${id}`), resource_key: `installation:${id}` }])) };
  if (equipment) context.equipment = new Map([[401, { id: 401, name: 'Unidad ficticia', status: 'available',
    turnaround_minutes: 5, installation_ids: new Set(roomIds), busy: [], attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 } }]]);
  const raw = { version, phases: Array.from({ length: phases }, (_, index) => ({ key: `care${index}`, label: `Paso ficticio ${index}`,
    duration_minutes: index ? 15 : 30, ...(version === 4 ? { start_offset_minutes: index * 15 } : {}),
    installation_ids: roomIds, professionals: allStaff ? { mode: 'all', ids: doctorIds, preferred_id: null }
      : { mode: 'any', ids: doctorIds, preferred_id: doctorIds[0], fallback_when: 'unavailable' },
    ...(equipment ? { equipment_requirements: [{ equipment_ids: [401] }] } : {}) })) };
  if (dense) for (const date of dates) for (const id of doctorIds) for (let i = 0; i < 6; i++) {
    context.doctors.get(id).busy.push({ start: resolveLocalInstant(date, `${String(10 + i).padStart(2, '0')}:00:00`, timeZone),
      end: resolveLocalInstant(date, `${String(10 + i).padStart(2, '0')}:20:00`, timeZone), can_share: false,
      diagnostic: { kind: 'appointment', treatment_name: 'Tratamiento ficticio', installation_name: 'Sala ficticia', full_interval: true } });
  }
  return { dates, roomIds, doctorIds, profile: normalizeBookingProfile(raw), context,
    pairs: roomIds.flatMap(installation_id => (allStaff ? [null] : doctorIds).map(doctor_id => ({ care0: {
      ...(doctor_id != null ? { doctor_id } : {}), installation_id } }))) };
}

function calendarProjection(search, fixture, options = {}) {
  const values = [];
  for (const date of fixture.dates) for (const selections of fixture.pairs) {
    const unavailable = [];
    const slots = search({ profile: fixture.profile, context: fixture.context, date, stepMinutes: 5, limit: 500,
      now: new Date('2020-01-01T00:00:00Z'), allowConfirmedOverlap: true, selections, ...options,
      onUnavailable: (start, conflict) => unavailable.push({ start_utc: start.toISOString(), conflict }) });
    values.push({ date, selections, slots, unavailable });
  }
  return values;
}

module.exports = { referenceCalendarService, calendarFixture, calendarProjection };
