const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getAllowedClinicIdsForActorTarget,
    getOperationalStaffClinicIdsForUser,
} = require('../../controllers/personal.controller').__personalSecurityContract;

test('operational staff clinics include the pending membership of a provisional user', async () => {
    let receivedWhere = null;
    const result = await getOperationalStaffClinicIdsForUser(82, {
        invitationWhereLoader: async () => ({ provisional_pending_allowed: true }),
        staffPivotFindAll: async (options) => {
            receivedWhere = options.where;
            return [
                { id_clinica: '19' },
                { id_clinica: 19 },
            ];
        },
    });

    assert.deepEqual(result, [19]);
    assert.equal(receivedWhere.id_usuario, 82);
    assert.equal(receivedWhere.provisional_pending_allowed, true);
});

test('schedule access uses operational staff clinics by default', async () => {
    const result = await getAllowedClinicIdsForActorTarget(1, 82, {
        operationalStaffDependencies: {
            invitationWhereLoader: async () => ({}),
            staffPivotFindAll: async () => [{ id_clinica: 19 }],
        },
        adminCheck: () => true,
    });

    assert.deepEqual(result, [19]);
});

test('a manager sees only shared clinics for a provisional doctor schedule', async () => {
    const result = await getAllowedClinicIdsForActorTarget(40, 80, {
        targetClinicIdsLoader: async () => [19, 57],
        actorClinicIdsLoader: async () => [19, 35],
        adminCheck: () => false,
    });

    assert.deepEqual(result, [19]);
});

test('an admin sees every operational clinic of a provisional doctor', async () => {
    const result = await getAllowedClinicIdsForActorTarget(1, 80, {
        targetClinicIdsLoader: async () => [19, 57],
        actorClinicIdsLoader: async () => {
            throw new Error('admin clinic scope should not be loaded');
        },
        adminCheck: () => true,
    });

    assert.deepEqual(result, [19, 57]);
});

test('a provisional doctor can load their own operational clinic', async () => {
    const result = await getAllowedClinicIdsForActorTarget(80, 80, {
        targetClinicIdsLoader: async () => [19],
        actorClinicIdsLoader: async () => {
            throw new Error('self clinic scope should not be loaded');
        },
        adminCheck: () => false,
    });

    assert.deepEqual(result, [19]);
});
