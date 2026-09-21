'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const servicePath = path.resolve(__dirname, '../../services/consentimientos.service.js');
function harness(granted = null, packageClinic = 66) {
    const calls = [], Op = { in: Symbol('in'), or: Symbol('or'), gt: Symbol('gt') };
    const kiosk = { id: 31, clinic_id: 72, consent_group_id: granted, update: async () => {} };
    const pack = { id: 9, public_id: 'synthetic', clinica_id: packageClinic, status: 'pending', documents: [{ id: 4, status: 'sent' }] };
    const db = { Sequelize: { Op }, ClinicTabletKiosk: { findOne: async () => kiosk },
        Clinica: { findByPk: async () => ({ id_clinica: 72, grupoClinicaId: 29 }), findAll: async () => [{ id_clinica: 66 }, { id_clinica: 72 }] },
        ConsentSignaturePackage: { findAll: async q => { calls.push(['list', q]); return []; }, findByPk: async () => pack },
        ConsentDeliveryEvent: { findOne: async () => ({ id: 1 }) } };
    const economics = { listTabletBudgetSignatureRequestsForClinic: async q => { calls.push(['budgets', q]); return []; },
        createTabletBudgetSignatureSession: async q => { calls.push(['budgetSession', q]); return {}; } };
    const nativeRequire = createRequire(servicePath), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
        require: name => name === '../../models' ? db : name === './patientEconomics.service' ? economics : name === 'jsonwebtoken'
            ? { verify: () => ({ type: 'clinic_tablet_kiosk', kiosk_id: 31, clinic_id: 72 }), sign: () => 'synthetic', decode: () => ({}) } : nativeRequire(name),
        module, exports: module.exports, __dirname: path.dirname(servicePath), process: { env: {} }, Buffer, console,
    });
    return { service: module.exports, calls, Op, kiosk };
}
test('listing default is own-clinic; explicitly opted in expands consents but never budgets', async () => {
    for (const grant of [null, 29]) {
        const h = harness(grant); await h.service.listTabletKioskPackages('synthetic');
        assert.deepEqual(Array.from(h.calls[0][1].where.clinica_id[h.Op.in]), grant ? [72, 66] : [72]);
        assert.equal(h.calls[1][1].clinicId, 72);
        await h.service.createTabletBudgetSignatureSessionForKiosk(1, 'synthetic');
        assert.equal(h.calls[2][1].clinicId, 72);
    }
});
test('opening a sibling package requires opt-in and revocation is immediate for new sessions', async () => {
    const h = harness();
    await assert.rejects(h.service.createTabletSessionForKiosk(9, 'synthetic'), e => e.statusCode === 403);
    h.kiosk.consent_group_id = 29;
    assert.equal((await h.service.createTabletSessionForKiosk(9, 'synthetic')).package_id, 9);
    h.kiosk.consent_group_id = null;
    await assert.rejects(h.service.createTabletSessionForKiosk(9, 'synthetic'), e => e.statusCode === 403);
});
test('explicit opt-in still rejects a package outside the group', async () => {
    const h = harness(29, 99);
    await assert.rejects(h.service.createTabletSessionForKiosk(9, 'synthetic'), e => e.statusCode === 403);
});
test('scope route is staff authenticated, never exposed through tablet public routes', () => {
    const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/consentimientos.routes.js'), 'utf8');
    assert(routes.indexOf("router.patch('/clinic/:clinicId/tablet-kiosk/:kioskId/scope'") > routes.indexOf('router.use(authMiddleware)'));
});
