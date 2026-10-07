'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const CODE = 'consent_template_version_unavailable';
const MESSAGE = 'No se pueden preparar las firmas: uno de los consentimientos de esta cita no tiene una versión publicada en español. '
    + 'Pide al responsable de consentimientos que revise la plantilla y publique la versión correspondiente; después vuelve a intentarlo.';
const error = (message, statusCode, details) => Object.assign(new Error(message), { statusCode, ...(details ? { details } : {}) });

// Actual controller and express-async-handler; DB, ACL and service boundaries
// are explicit offline spies. This proves wiring/error presentation, NOT real
// employee authentication, publication policy, SQL rollback or a tablet send.
function fixture({ clinicId = 100, denied = false, serviceError = null } = {}) {
    const filename = path.resolve(__dirname, '../../controllers/consentimientos.controller.js');
    const nativeRequire = createRequire(filename), module = { exports: {} }, calls = [];
    const details = { clinicId };
    const db = { Sequelize: { Op: {} }, CitaPaciente: { findByPk: async (id, options) => {
        calls.push(['appointment_scope', Number(id)]);
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { attributes: ['id_cita', 'clinica_id'], raw: true });
        return clinicId ? { id_cita: Number(id), clinica_id: clinicId } : null;
    } } };
    const service = { createPackageForAppointment: async (id, options) => {
        calls.push(['service', Number(id), JSON.parse(JSON.stringify(options))]);
        if (serviceError) throw serviceError;
        return { id: 90, documents: [] };
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
        require: name => {
            if (name === '../../models') return db;
            if (name === '../services/consentimientos.service') return service;
            if (name === '../lib/access-policy') return { canUserAccessFeature: async () => false,
                assertUserCanAccessFeature: async request => {
                    calls.push(['acl', JSON.parse(JSON.stringify(request))]);
                    if (denied) throw error('feature_access_forbidden', 403, details);
                } };
            if (name === '../lib/role-helpers') return { isGlobalAdmin: () => false };
            if (name === 'express-async-handler') return nativeRequire(name);
            throw new Error('Unexpected controller dependency: ' + name);
        }, console, Date, Buffer, Map, Set, Promise }, { filename });
    const invoke = async (patch = {}) => {
        const req = { params: { id: '41' }, userData: { userId: 7 }, body: {}, ...patch };
        const res = { statusCode: 200, payload: undefined, status(value) { this.statusCode = value; return this; },
            json(value) { this.payload = JSON.parse(JSON.stringify(value)); return this; } };
        await module.exports.createAppointmentPackage(req, res, issue => { throw issue; });
        return res;
    };
    return { invoke, calls, details };
}

test('new consent issuance 409 is actionable Spanish with stable code/key after scoped manage ACL', async () => {
    const issue = error(CODE, 409, { missing_version: true }), f = fixture({ serviceError: issue });
    const response = await f.invoke({ body: { clinic_id: 999, clinica_id: 999, createdBy: 999, origen: 'manual' } });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.payload, { code: CODE, key: CODE, message: MESSAGE, details: issue.details });
    assert.equal(issue.message, CODE, 'API presentation never changes the service error contract');
    assert.deepEqual(f.calls, [['appointment_scope', 41], ['acl', { actorId: 7, featureKey: 'consents.manage', clinicId: 100 }],
        ['service', 41, { createdBy: 7, triggerSource: 'manual' }]]);
    assert(!/[<>]/.test(response.payload.message));
});

test('denied controller ACL boundary never invokes consent preparation or translates an unrelated denial', async () => {
    const f = fixture({ denied: true, serviceError: error(CODE, 409) });
    const response = await f.invoke();
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.payload, { message: 'feature_access_forbidden', details: f.details });
    assert.deepEqual(f.calls.map(call => call[0]), ['appointment_scope', 'acl']);
});

test('missing actor or unresolved appointment clinic fails closed before ACL and service', async () => {
    for (const scenario of [{ args: {}, patch: { userData: {} }, status: 401, message: 'auth_failed' },
        { args: { clinicId: null }, patch: {}, status: 400, message: 'clinic_id_required' }]) {
        const f = fixture({ ...scenario.args, serviceError: error(CODE, 409) });
        const response = await f.invoke(scenario.patch);
        assert.equal(response.statusCode, scenario.status);
        assert.deepEqual(response.payload, { message: scenario.message });
        assert.deepEqual(f.calls.map(call => call[0]), ['appointment_scope']);
    }
});

test('other service errors retain the exact previous message/status/details shape', async () => {
    for (const issue of [error('appointment_has_no_consent_requirements', 400),
        error('consent_package_unavailable', 410, { reason: 'expired' }),
        Object.assign(new Error('other_conflict'), { status: 409, details: { reason: 'unchanged' } }),
        Object.assign(new Error(''), { details: { reason: 'fallback' } })]) {
        const response = await fixture({ serviceError: issue }).invoke();
        const expected = { message: issue.message || 'consentimientos_error' };
        if (issue.details) expected.details = issue.details;
        assert.equal(response.statusCode, issue.statusCode || issue.status || 500);
        assert.deepEqual(response.payload, expected);
        assert(!Object.hasOwn(response.payload, 'code')); assert(!Object.hasOwn(response.payload, 'key'));
    }
});

test('translated version error without details omits details, while successful preparation remains unchanged', async () => {
    const refused = await fixture({ serviceError: error(CODE, 409) }).invoke();
    assert.deepEqual(refused.payload, { code: CODE, key: CODE, message: MESSAGE });
    const f = fixture(), accepted = await f.invoke({ body: { trigger_source: 'appointment_preparation' } });
    assert.equal(accepted.statusCode, 201); assert.deepEqual(accepted.payload, { id: 90, documents: [] });
    assert.deepEqual(f.calls[2], ['service', 41, { createdBy: 7, triggerSource: 'appointment_preparation' }]);
});
