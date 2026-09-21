'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const servicePath = path.resolve(__dirname, '../../services/consentimientos.service.js');

function harness() {
    const calls = [], Op = { or: Symbol('or'), in: Symbol('in') };
    const stored = [{ id: 8, tratamiento_id: 4, clinica_id: 3 }];
    const db = { Sequelize: { Op }, TreatmentConsentRequirement: {
        destroy: async options => { calls.push(['destroy', options]); },
        bulkCreate: async rows => { calls.push(['create', rows]); },
        findAll: async options => { calls.push(['read', options]); return stored; },
    } };
    const nativeRequire = createRequire(servicePath), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
        require: name => name === '../../models' ? db : nativeRequire(name),
        module, exports: module.exports, __dirname: path.dirname(servicePath),
        process: { env: {} }, Buffer, console,
    });
    return { service: module.exports, calls, stored, Op };
}

test('saving a treatment requirement returns its clinic-scoped persisted list', async () => {
    const h = harness();
    const result = await h.service.saveTreatmentRequirements('4', { clinic_id: 3,
        requirements: [{ clinic_template_id: 5, required: true, blocking_policy: 'hard' }] });
    assert.equal(result, h.stored);
    assert.equal(h.calls[0][1].where.tratamiento_id, 4);
    assert.equal(h.calls[0][1].where.clinica_id, 3);
    assert.equal(h.calls[1][1][0].clinica_id, 3);
    assert.equal(h.calls[1][1][0].clinic_template_id, 5);
    const query = h.calls[2][1];
    assert.equal(query.where.tratamiento_id, 4);
    assert.equal(query.where[h.Op.or][0].clinica_id, 3);
    assert.equal(query.where[h.Op.or][1].clinica_id, null);
});

test('clearing clinic requirements also returns successfully, without a create', async () => {
    const h = harness();
    assert.equal(await h.service.saveTreatmentRequirements(4, { clinica_id: 3, requirements: [] }), h.stored);
    assert.deepEqual(h.calls.map(([name]) => name), ['destroy', 'read']);
    assert.equal(h.calls[1][1].where[h.Op.or][0].clinica_id, 3);
});

test('invalid treatment IDs fail before any writes', async () => {
    const h = harness();
    await assert.rejects(h.service.saveTreatmentRequirements('bad', { clinic_id: 3 }), error => error.message === 'tratamiento_id_required');
    assert.equal(h.calls.length, 0);
});
