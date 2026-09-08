'use strict';

const db = require('../../models');
const { resolveWhatsappRouting } = require('../lib/whatsapp-channel-role');

const ClinicMetaAsset = db.ClinicMetaAsset;
const { Op } = db.Sequelize;

function whatsappPhoneScopeWhere({ assignmentScope, clinicId, groupId }) {
  if (assignmentScope === 'clinic' && clinicId) {
    return { assignmentScope: 'clinic', clinicaId: clinicId };
  }
  if (assignmentScope === 'group' && groupId) {
    return { assignmentScope: 'group', grupoClinicaId: groupId };
  }
  return { assignmentScope: 'unassigned' };
}

async function releaseWhatsappWabaScopeIfUnused({ wabaId, assignmentScope, clinicId, groupId }) {
  if (!wabaId || !['clinic', 'group'].includes(assignmentScope)) return;
  const scopeWhere = whatsappPhoneScopeWhere({ assignmentScope, clinicId, groupId });
  const assignedPhoneCount = await ClinicMetaAsset.count({
    where: {
      assetType: 'whatsapp_phone_number',
      isActive: true,
      wabaId,
      ...scopeWhere,
    },
  });
  if (assignedPhoneCount > 0) return;

  await ClinicMetaAsset.update(
    {
      assignmentScope: 'unassigned',
      clinicaId: null,
      grupoClinicaId: null,
    },
    {
      where: {
        assetType: 'whatsapp_business_account',
        isActive: true,
        wabaId,
        ...scopeWhere,
      },
    }
  );
}

async function unassignWhatsappPhoneAsset(phone) {
  const previousScope = phone.assignmentScope || null;
  const previousClinicId = phone.clinicaId || null;
  const previousGroupId = phone.grupoClinicaId || null;
  await phone.update({
    assignmentScope: 'unassigned',
    clinicaId: null,
    grupoClinicaId: null,
  });
  await releaseWhatsappWabaScopeIfUnused({
    wabaId: phone.wabaId,
    assignmentScope: previousScope,
    clinicId: previousClinicId,
    groupId: previousGroupId,
  });
}

async function clearWhatsappPhoneRoleCollision({
  assignmentScope,
  clinicId,
  groupId,
  role,
  exceptPhoneNumberId,
}) {
  if (!['clinic', 'group'].includes(assignmentScope)) return;
  const scoped = await ClinicMetaAsset.findAll({
    where: {
      assetType: 'whatsapp_phone_number',
      isActive: true,
      ...whatsappPhoneScopeWhere({ assignmentScope, clinicId, groupId }),
      phoneNumberId: { [Op.ne]: exceptPhoneNumberId },
    },
  });
  const conflicts = scoped.filter((asset) => resolveWhatsappRouting(asset).role === role);
  for (const conflict of conflicts) {
    await unassignWhatsappPhoneAsset(conflict);
  }
}

async function hasWhatsappPrimaryForScope({ assignmentScope, clinicId, groupId, exceptPhoneNumberId = null }) {
  const scopeClauses = [whatsappPhoneScopeWhere({ assignmentScope, clinicId, groupId })];
  if (assignmentScope === 'clinic' && groupId) {
    scopeClauses.push(whatsappPhoneScopeWhere({ assignmentScope: 'group', groupId }));
  }
  const assets = await ClinicMetaAsset.findAll({
    where: {
      assetType: 'whatsapp_phone_number',
      isActive: true,
      ...(exceptPhoneNumberId ? { phoneNumberId: { [Op.ne]: exceptPhoneNumberId } } : {}),
      [Op.or]: scopeClauses,
    },
  });
  return assets.some((asset) => resolveWhatsappRouting(asset).role === 'primary');
}

module.exports = {
  clearWhatsappPhoneRoleCollision,
  hasWhatsappPrimaryForScope,
  releaseWhatsappWabaScopeIfUnused,
  unassignWhatsappPhoneAsset,
  whatsappPhoneScopeWhere,
};
