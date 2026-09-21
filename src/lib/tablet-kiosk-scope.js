'use strict';

// Scope is read from the device on every request, not from long-lived JWT
// claims. A clinic moving to another group cannot inherit the previous grant.
const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

async function consentClinicIds(db, kiosk) {
    const own = id(kiosk.clinic_id);
    if (!own) fail('tablet_kiosk_scope_invalid', 403);
    const grantedGroup = id(kiosk.consent_group_id);
    if (!grantedGroup) return [own];
    const clinic = await db.Clinica.findByPk(own, { attributes: ['id_clinica', 'grupoClinicaId'], raw: true });
    if (id(clinic?.grupoClinicaId) !== grantedGroup) return [own];
    const clinics = await db.Clinica.findAll({ where: { grupoClinicaId: grantedGroup }, attributes: ['id_clinica'], raw: true });
    return [...new Set([own, ...clinics.map(c => id(c.id_clinica)).filter(Boolean)])];
}

async function setConsentGroupScope({ db, assertAccess, clinicId, kioskId, actorId, enabled }) {
    if (![clinicId, kioskId, actorId].every(value => id(value))) fail('tablet_kiosk_scope_parameters_invalid', 400);
    if (typeof enabled !== 'boolean') fail('tablet_kiosk_group_scope_boolean_required', 400);
    await assertAccess({ actorId: id(actorId), featureKey: 'consents.manage', clinicId: id(clinicId) });
    return db.sequelize.transaction(async transaction => {
        const clinic = await db.Clinica.findByPk(id(clinicId), { transaction, lock: transaction.LOCK.UPDATE });
        const kiosk = await db.ClinicTabletKiosk.findOne({ where: { id: id(kioskId), clinic_id: id(clinicId) }, transaction, lock: transaction.LOCK.UPDATE });
        if (!clinic || !kiosk) fail('tablet_kiosk_not_found', 404);
        let groupId = null;
        if (enabled) {
            groupId = id(clinic.grupoClinicaId);
            if (!groupId) fail('tablet_kiosk_clinic_has_no_group', 409);
            const clinics = await db.Clinica.findAll({ where: { grupoClinicaId: groupId }, attributes: ['id_clinica'], raw: true, transaction });
            for (const member of clinics) {
                await assertAccess({ actorId: id(actorId), featureKey: 'consents.manage', clinicId: id(member.id_clinica) });
            }
        }
        await kiosk.update({ consent_group_id: groupId }, { transaction });
        return kiosk;
    });
}

module.exports = { consentClinicIds, setConsentGroupScope };
