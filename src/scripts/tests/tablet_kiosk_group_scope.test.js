'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { consentClinicIds, setConsentGroupScope } = require('../../lib/tablet-kiosk-scope');

function fixture({ group = 29, granted = null, deny = null } = {}) {
    const writes = [], checks = [];
    const kiosk = { id: 31, clinic_id: 72, consent_group_id: granted,
        update: async value => { writes.push(value); Object.assign(kiosk, value); } };
    const db = { sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
        Clinica: { findByPk: async () => ({ id_clinica: 72, grupoClinicaId: group }),
            findAll: async () => [{ id_clinica: 66 }, { id_clinica: 72 }] },
        ClinicTabletKiosk: { findOne: async options => options.where.id === 31 && options.where.clinic_id === 72 ? kiosk : null } };
    const args = { db, assertAccess: async ({ clinicId }) => { checks.push(clinicId); if (clinicId === deny) throw Object.assign(Error('forbidden'), { statusCode: 403 }); },
        clinicId: 72, kioskId: 31, actorId: 1, enabled: true };
    return { db, args, kiosk, writes, checks };
}
test('default and missing grant are own-clinic only', async () => {
    const f = fixture(); assert.deepEqual(await consentClinicIds(f.db, f.kiosk), [72]);
});
test('explicit opt-in verifies every group clinic and derives group server-side', async () => {
    const f = fixture(); await setConsentGroupScope(f.args);
    assert.deepEqual(f.writes, [{ consent_group_id: 29 }]); assert.deepEqual(f.checks, [72, 66, 72]);
    assert.deepEqual(await consentClinicIds(f.db, f.kiosk), [72, 66]);
});
test('a denied group clinic prevents every write', async () => {
    const f = fixture({ deny: 66 }); await assert.rejects(setConsentGroupScope(f.args), /forbidden/); assert.equal(f.writes.length, 0);
});
test('a device in another clinic cannot be edited', async () => {
    const f = fixture(); await assert.rejects(setConsentGroupScope({ ...f.args, kioskId: 32 }), /not_found/); assert.equal(f.writes.length, 0);
});
test('moving the base clinic to another group does not transfer consent access', async () => {
    const f = fixture({ group: 30, granted: 29 }); assert.deepEqual(await consentClinicIds(f.db, f.kiosk), [72]);
});
test('removing grant takes effect without issuing another kiosk token', async () => {
    const f = fixture({ granted: 29, deny: 66 }); await setConsentGroupScope({ ...f.args, enabled: false });
    assert.deepEqual(await consentClinicIds(f.db, f.kiosk), [72]); assert.deepEqual(f.checks, [72]);
});
for (const enabled of [undefined, null, 1, 'true', 'false']) test('reject non-boolean opt-in ' + enabled, async () => {
    const f = fixture(); await assert.rejects(setConsentGroupScope({ ...f.args, enabled }), /boolean_required/); assert.equal(f.writes.length, 0);
});
test('clinic without group cannot opt in', async () => {
    const f = fixture({ group: null }); await assert.rejects(setConsentGroupScope(f.args), /no_group/); assert.equal(f.writes.length, 0);
});
