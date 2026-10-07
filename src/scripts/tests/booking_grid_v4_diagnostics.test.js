'use strict';
// Fictional resources only; no database, providers or real appointment writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { explainUnavailableStart, appendStartInterval } = require('../../lib/booking-grid-diagnostics');
const BASE = Date.parse('2030-01-07T09:30:00Z');
const time = minutes => new Date(BASE + minutes * 60000);
const continuous = { mode: 'continuous', patient_preparation_minutes: 0 };
const setup = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const attended = { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 };
const resource = (name, extra = {}) => ({ name, windows: [{ start: time(-30), end: time(180) }], busy: [], ...extra });
const phase = (key, offset, doctor, room, extra = {}) => ({ key, label: key, start_offset_minutes: offset, duration_minutes: 30,
    installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor }, ...extra });
function fixture(phases = [phase('extraction', 0, 5, 9), phase('application', 15, 6, 10)]) {
    return { profile: normalizeBookingProfile({ version: 4, phases }), start: time(0), selections: {}, additionalStaffIds: [],
        context: { doctors: new Map([5, 6, 7].map(id => [id, resource(`Profesional ficticio ${id}`, { clinic_id: 72, attention_visits: [] })])),
            installations: new Map([9, 10, 11, 12].map(id => [id, resource(`Sala ficticia ${id}`, { resource_key: `installation:${id}` })])),
            equipment: new Map([1, 2, 3, 4].map(id => [id, { id, name: `Máquina ficticia ${id}`, status: 'available',
                installation_ids: new Set([9, 10, 11, 12]), turnaround_minutes: 0, busy: [], attention_policy: continuous }])) } };
}
function rejected(f) {
    assert.equal(solveBookingProfile({ ...f.context, profile: f.profile, start: f.start, selections: f.selections, allowOverlap: f.allowOverlap }), null);
    const conflict = explainUnavailableStart(f);
    assert.equal(conflict.can_force, false);
    assert.equal(conflict.details.availability_semantics, 'appointment_start');
    return conflict;
}
test('a second-step occupation is explained at its actual offset, not as a clinic closure', () => {
    const f = fixture();
    f.context.doctors.get(6).busy.push({ start: time(30), end: time(40) });
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'resource_busy');
    assert.equal(conflict.details.phase_key, 'application');
    assert.equal(conflict.details.start_offset_minutes, 15);
    assert.equal(conflict.details.visit_duration_minutes, 45);
    assert.match(conflict.details.message, /Profesional ficticio 6/);
    assert.doesNotMatch(conflict.details.message, /clínica.*cerrada|clínica.*fuera de/i);
});
test('visit timetable uses max(offset + duration), not the first step or sum', () => {
    const f = fixture();
    f.context.clinicWindows = [{ start: time(0), end: time(40) }];
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'clinic_schedule');
    assert.equal(conflict.details.duration_minutes, 45);
    assert.match(conflict.details.message, /45 min.*todos sus pasos/);
});
test('array order does not become temporal order; late-step resources still report the correct phase', () => {
    const f = fixture([phase('application', 15, 6, 10), phase('extraction', 0, 5, 9)]);
    f.context.installations.get(9).busy.push({ start: time(0), end: time(10) });
    const conflict = rejected(f);
    assert.equal(conflict.details.phase_key, 'extraction');
    assert.equal(conflict.details.start_offset_minutes, 0);
});
test('aliased room occupations remain one physical resource in both solver and explanation', () => {
    const f = fixture();
    f.context.installations.get(9).resource_key = 'installation:shared';
    f.context.installations.get(11).resource_key = 'installation:shared';
    f.context.installations.get(11).busy.push({ start: time(0), end: time(30) });
    const conflict = rejected(f);
    assert.equal(conflict.resource_type, 'installation');
    assert.equal(conflict.details.reason_key, 'resource_busy');
    assert.equal(conflict.details.phase_key, 'extraction');
});
test('room eligibility is not turned into a timetable error', () => {
    const f = fixture();
    Object.assign(f.context.installations.get(10), { profesionales_permitidos: [5], windows: [] });
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'room_staff_incompatible');
    assert.equal(conflict.details.phase_key, 'application');
    assert.doesNotMatch(conflict.details.message, /horario|cerrada/);
});
test('machinery and its turnaround are checked at the phase offset, not the first start', () => {
    const f = fixture([phase('extraction', 0, 5, 9), phase('application', 15, 6, 10, { equipment_requirements: [{ equipment_ids: [1] }] })]);
    Object.assign(f.context.equipment.get(1), { turnaround_minutes: 5, busy: [{ start: time(46), end: time(55) }] });
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'equipment_busy');
    assert.equal(conflict.details.phase_key, 'application');
    assert.match(conflict.details.message, /Máquina ficticia 1.*30 min/);
});
test('start-only and start-continuous messages distinguish preparation from continuous care', () => {
    for (const policy of [setup, attended]) {
        const f = fixture([phase('technique', 0, 5, 9, { staff_attention: [policy] })]);
        f.context.doctors.get(5).busy.push({ start: time(0), end: time(15) });
        const conflict = rejected(f);
        assert.equal(conflict.details.reason_key, 'staff_intervention');
        assert.match(conflict.details.message, /5 min.*primeros 15 min/);
        assert.equal(/atención continua/.test(conflict.details.message), policy.mode === 'start_continuous');
        assert.doesNotMatch(conflict.details.message, /retirada/);
    }
});
test('joint failure explains why individually feasible interventions cannot fit together', () => {
    const f = fixture([9, 10, 11, 12].map((room, index) => phase(`technique_${index}`, 0, 5, room, { staff_attention: [setup] })));
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'joint_staff_interventions');
    assert.match(conflict.details.message, /pasos encajan por separado.*intervenciones no caben juntas/);
});
test('mandatory teams are checked in their v4 step, not across the whole envelope', () => {
    const f = fixture([phase('team', 0, 5, 9, { professionals: { mode: 'all', ids: [5, 7], preferred_id: null } }), phase('later', 30, 6, 10)]);
    f.context.doctors.get(7).busy.push({ start: time(10), end: time(15) });
    const conflict = rejected(f);
    assert.equal(conflict.resource_id, 7);
    assert.equal(conflict.details.phase_key, 'team');
    assert.equal(conflict.details.duration_minutes, 30);
});
test('a foreign appointment cannot disclose patient, treatment or snapshot in a diagnostic', () => {
    const f = fixture();
    f.context.doctors.get(6).busy.push({ start: time(20), end: time(40), appointment_id: 9001,
        diagnostic: { kind: 'other_clinic', time_range: '09:50–10:10', treatment_name: 'PRIVATE_TREATMENT', patient_name: 'PRIVATE_PATIENT', clinic_id: 123 },
        snapshot: { private: 'PRIVATE_SNAPSHOT' } });
    const conflict = rejected(f);
    assert.match(conflict.details.message, /otra clínica.*09:50/);
    assert.doesNotMatch(JSON.stringify(conflict), /PRIVATE|9001|123|snapshot|appointment_id|patient_name/);
});
test('different starts of verified visits yield the exact same-start rule rather than a generic busy label', () => {
    const f = fixture([phase('technique', 0, 5, 9, { staff_attention: [setup], preparation_sharing: { mode: 'same_start' } })]);
    f.context.doctors.get(5).attention_visits.push({ appointment_id: 9001, clinic_id: 72, start: time(-5), end: time(25), version: 4, verified: true, partial: true,
        phases: [{ key: 'private', start: time(-5), end: time(25), partial: true, preparation_sharing: { mode: 'same_start' }, start_window_minutes: 15 }] });
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'preparation_start_mismatch');
    assert.match(conflict.details.message, /no empiezan a la misma hora/);
    assert.doesNotMatch(JSON.stringify(conflict), /9001|private|attention_visits|appointment_id/);
});
test('unknown clinical checks are visible but never invented or forceable', () => {
    const f = fixture([phase('ems', 0, 5, 9, { staff_attention: [setup], attention_requirements_pending: [{ key: 'mid_check', label: 'Comprobación intermedia sin cuantificar' }] })]);
    assert.throws(() => solveBookingProfile({ ...f.context, profile: f.profile, start: f.start }), { code: 'pending_attention_requirements' });
    const conflict = explainUnavailableStart(f);
    assert.equal(conflict.details.reason_key, 'pending_attention_requirements');
    assert.equal(conflict.can_force, false);
    assert.doesNotMatch(conflict.details.message, /5 min|10 min|retirada/);
});
const alternative = (when = 'absence_only') => ({ mode: 'any', ids: [5, 6], preferred_id: 5, fallback_when: when });
test('busy primary is not absent: v4 reports the blocked substitution instead of imaginary joint capacity', () => {
    for (const explicitlySelected of [false, true]) {
        const f = fixture([phase('care', 0, 5, 9, { professionals: alternative() })]);
        Object.assign(f.context.doctors.get(5), { schedule_verified: true, absence_windows: [], busy: [{ start: time(0), end: time(30),
            diagnostic: { kind: 'appointment', time_range: '10:30–11:00', treatment_name: 'Técnica propia ficticia', full_interval: true } }] });
        if (explicitlySelected) f.selections.care = { doctor_id: 6 };
        const conflict = rejected(f);
        assert.equal(conflict.details.reason_key, 'professional_substitution_not_allowed');
        assert.equal(conflict.resource_id, 5);
        assert.equal(conflict.details.phase_key, 'care');
        assert.match(conflict.details.message, /Profesional ficticio 5.*ocupado.*Técnica propia ficticia/);
        assert.match(conflict.details.message, /sólo permite sustituir.*ausencia.*Una cita ocupada.*no autoriza/);
        assert.doesNotMatch(conflict.details.message, /recursos disponibles|recurso libre|está libre|cerrada/);
        f.profile.phases[0].professionals.fallback_when = 'unavailable';
        assert.deepEqual(solveBookingProfile({ ...f.context, profile: f.profile, start: f.start, selections: f.selections }).phases[0].doctor_ids, [6]);
    }
});
test('explicit alternate choice and overlap acknowledgement cannot invent an absence in the diagnostic', () => {
    const f = fixture([phase('care', 0, 5, 9, { professionals: alternative() })]);
    Object.assign(f.context.doctors.get(5), { schedule_verified: true, absence_windows: [] });
    f.selections.care = { doctor_id: 6 }; f.allowOverlap = true;
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'professional_substitution_not_allowed');
    assert.match(conflict.details.message, /no tiene una ausencia acreditada/);
    assert.doesNotMatch(conflict.details.message, /ocupado|libre|joint/);
});
test('unknown schedule or untyped vacation block remains unverified rather than enabling the replacement', () => {
    for (const primary of [{ windows: [], schedule_verified: false, absence_windows: [] },
        { schedule_verified: true, absence_windows: [], busy: [{ start: time(0), end: time(30), tipo: 'otro', motivo: 'Vacaciones' }] }]) {
        const f = fixture([phase('care', 0, 5, 9, { professionals: alternative() })]);
        Object.assign(f.context.doctors.get(5), primary);
        const conflict = rejected(f);
        assert.equal(conflict.details.reason_key, 'professional_substitution_not_allowed');
        assert.doesNotMatch(conflict.details.message, /motivo|Vacaciones|libre/);
    }
});
test('verified absence and configured non-working time actually permit the substitute in the canonical solver', () => {
    for (const primary of [{ windows: [{ start: time(60), end: time(180) }], schedule_verified: true, absence_windows: [] },
        { schedule_verified: true, absence_windows: [{ start: time(0), end: time(30) }], busy: [{ start: time(0), end: time(30) }] }]) {
        const f = fixture([phase('care', 0, 5, 9, { professionals: alternative() })]);
        Object.assign(f.context.doctors.get(5), primary);
        const solution = solveBookingProfile({ ...f.context, profile: f.profile, start: f.start });
        assert(solution); assert.deepEqual(solution.phases[0].doctor_ids, [6]);
        assert.equal(solution.warnings[0].fallback_reason, 'absence');
        f.context.doctors.get(6).busy.push({ start: time(0), end: time(30) });
        const conflict = rejected(f);
        assert.notEqual(conflict.details.reason_key, 'professional_substitution_not_allowed', 'The permitted substitute is now busy; the policy did not prohibit it');
    }
});
test('effective preparation and internal overlapping work explain why absence-only cannot add a substitute', () => {
    const f = fixture([phase('first', 0, 5, 9, { professionals: alternative(), staff_attention: [setup] }),
        phase('second', 0, 5, 10, { staff_attention: [attended] }), phase('third', 0, 5, 11, { staff_attention: [setup] }),
        phase('fourth', 0, 5, 12, { staff_attention: [setup] })]);
    Object.assign(f.context.doctors.get(5), { schedule_verified: true, absence_windows: [] });
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'professional_substitution_not_allowed');
    assert.match(conflict.details.message, /intervenciones no caben juntas.*sólo permite sustituir.*ausencia/);
    assert.doesNotMatch(conflict.details.message, /está libre|recursos disponibles/);
    f.profile.phases[0].professionals.fallback_when = 'unavailable';
    const solution = solveBookingProfile({ ...f.context, profile: f.profile, start: f.start });
    assert(solution); assert.deepEqual(solution.phases[0].doctor_ids, [6]);
});
test('substitution diagnostic never discloses foreign patient, treatment, appointment or snapshot evidence', () => {
    const f = fixture([phase('care', 0, 5, 9, { professionals: alternative() })]);
    Object.assign(f.context.doctors.get(5), { schedule_verified: true, absence_windows: [], busy: [{ start: time(0), end: time(30), appointment_id: 9001,
        diagnostic: { kind: 'other_clinic', time_range: '10:30–11:00', treatment_name: 'PRIVATE_TREATMENT', patient_name: 'PRIVATE_PATIENT', clinic_id: 123 },
        snapshot: { private: 'PRIVATE_SNAPSHOT' } }] });
    const conflict = rejected(f);
    assert.equal(conflict.details.reason_key, 'professional_substitution_not_allowed');
    assert.match(conflict.details.message, /otra clínica.*10:30/);
    assert.doesNotMatch(JSON.stringify(conflict), /PRIVATE|9001|123|snapshot|appointment_id|patient_name/);
});
test('legacy ANY diagnostics and substitution behavior do not adopt the v4 conditional policy', () => {
    const f = fixture([phase('care', 0, 5, 9, { professionals: alternative() })]);
    f.profile.version = 1; delete f.profile.phases[0].start_offset_minutes;
    f.context.doctors.get(5).busy.push({ start: time(0), end: time(30) });
    assert.deepEqual(solveBookingProfile({ ...f.context, profile: f.profile, start: f.start }).phases[0].doctor_ids, [6]);
    f.context.doctors.get(6).busy.push({ start: time(0), end: time(30) });
    const conflict = rejected(f);
    assert.notEqual(conflict.details.reason_key, 'professional_substitution_not_allowed');
});
test('merging start diagnostics never merges different failing steps', () => {
    const intervals = [], f = fixture();
    f.context.doctors.get(5).busy.push({ start: time(0), end: time(10) });
    const first = explainUnavailableStart(f);
    f.context.doctors.get(5).busy = [];
    f.context.doctors.get(6).busy.push({ start: time(20), end: time(40) });
    const second = explainUnavailableStart(f);
    const format = date => date.toISOString();
    appendStartInterval(intervals, time(0), time(5), first, 'UTC', format);
    appendStartInterval(intervals, time(5), time(10), second, 'UTC', format);
    assert.equal(intervals.length, 2);
});
