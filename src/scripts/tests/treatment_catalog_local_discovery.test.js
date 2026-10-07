'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');
const { individualBookingEligible } = require('../../lib/appointment-booking-catalog');

const source = fs.readFileSync(require.resolve('../../controllers/tratamientos.controller'), 'utf8');
const body = source.slice(source.indexOf('exports.getTratamientos ='), source.indexOf('// Crear tratamiento'));
const profile = { version: 1, phases: [{ key: 'main', label: 'Consulta', duration_minutes: 30,
    installation_ids: [7], professionals: { ids: [12], mode: 'any', preferred_id: 12 } }] };
const row = (id, values = {}) => ({ id_tratamiento: id, nombre: 'Consulta ' + id, clinica_id: 72,
    origen: 'clinica', disciplina: 'general', activo: true, clinical_config: { booking_profile: profile }, ...values });
function matches(row, where) {
    return Reflect.ownKeys(where).every(key => {
        if (key === Op.or) return where[key].some(condition => matches(row, condition));
        if (key === Op.and) return where[key].every(condition => matches(row, condition));
        const value = where[key];
        if (value && typeof value === 'object' && value[Op.in]) return value[Op.in].includes(row[key]);
        return row[key] === value;
    });
}
async function list(rows, query = {}) {
    const exports = {};
    let seenWhere;
    vm.runInNewContext(body, { exports, Op, asyncHandler: fn => fn,
        db: { Sequelize: { Op } }, Clinica: {},
        Tratamiento: { findAll: async ({ where }) => { seenWhere = where; return rows.filter(row => matches(row, where)); } },
        toIntOrNull: value => value == null ? null : Number(value),
        resolveGroupIdForClinicId: async () => 29,
        resolveClinicDisciplines: async () => ['estetica', 'psicologia'],
        expandTreatmentDisciplineCodes: value => Array.isArray(value) ? value : [value],
        catalogDto: row => row,
        require: name => name === '../lib/appointment-booking-catalog'
            ? { individualBookingEligible: (row, id, opts) => individualBookingEligible(row, id,
                { ...opts, capabilities: { simple: true, multi: true, relativeSteps: true } }) }
            : require(require('node:path').resolve(__dirname, '../../controllers', name)),
    });
    let result;
    await exports.getTratamientos({ query: { clinica_id: '72', ...query } }, { json: rows => { result = rows; } });
    return { result, where: seenWhere };
}
test('local active general consultations remain discoverable; other clinic and shared wrong-specialty rows do not', async () => {
    const rows = [row(1), row(2, { clinica_id: 66 }), row(3, { origen: 'sistema' }),
        row(4, { origen: 'sistema', disciplina: 'estetica' }),
        row(5, { origen: 'grupo', grupo_clinica_id: 29, disciplina: 'estetica' }),
        row(6, { origen: 'grupo', grupo_clinica_id: 99, disciplina: 'estetica' }), row(7, { activo: false })];
    assert.deepEqual((await list(rows)).result.map(row => row.id_tratamiento), [1, 4, 5]);
});
test('an explicitly requested specialty is still respected for the local catalogue', async () => {
    assert.deepEqual((await list([row(1), row(2, { disciplina: 'psicologia' })], { disciplina: 'psicologia' }))
        .result.map(row => row.id_tratamiento), [2]);
});
test('booking discovery does not activate drafts, historical references or continuation-only services', async () => {
    const rows = [row(1), row(2, { clinical_config: { catalog_status: 'draft' } }),
        row(3, { clinical_config: { booking_visibility: 'continuation_only' } }),
        row(4, { clinical_config: { catalog_status: 'obsolete' } })];
    assert.deepEqual((await list(rows, { booking: 'true' })).result.map(row => row.id_tratamiento), [1]);
});
