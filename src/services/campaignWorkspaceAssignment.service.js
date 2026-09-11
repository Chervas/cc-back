'use strict';

const Ajv = require('ajv');
const { Op } = require('sequelize');
const { loadWorkspaceInventory } = require('./campaignWorkspace.service');
const { settingScope, campaignIncluded } = require('./campaignWorkspaceSettings.service');
const { findAssociationAccountScope, saveAssignmentWithinScope } = require('./managedCampaignAssociationScopes.service');
const { appendAssignmentAudit, buildChanges, AUDIT_EVENT_TYPES } = require('./externalCampaignAssignmentTargets.service');
const { accountAliases } = require('./campaignWorkspaceReport.service');

const validate = new Ajv().compile({
  type: 'object', additionalProperties: false,
  required: ['provider', 'account_id', 'campaign_id', 'clinic_id', 'expected_version', 'confirmed'],
  properties: {
    provider: { enum: ['google_ads', 'meta_ads'] }, account_id: { type: 'string', pattern: '^[0-9]{1,64}$' },
    campaign_id: { type: 'string', pattern: '^[0-9]{1,128}$' }, clinic_id: { type: 'integer', minimum: 1 },
    expected_version: { type: 'integer', minimum: 0 }, confirmed: { const: true },
  },
});
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };

function assignmentClinics(clinics) {
  return clinics.filter(row => [true, 1, '1'].includes(row.estado_clinica) && !/\btest\b/i.test(row.nombre_clinica || ''))
    .map(row => ({ id: Number(row.id_clinica), name: row.nombre_clinica || `Clínica ${row.id_clinica}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

async function assignWorkspaceCampaign({ models, scope, actorId, input, loadInventory = loadWorkspaceInventory,
  accountScope = findAssociationAccountScope, now = () => new Date() }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  if (!validate(input)) fail('invalid_workspace_assignment', 400);
  if (!scope.groupId || scope.isAll) fail('workspace_assignment_group_required', 400);
  return models.sequelize.transaction(async transaction => {
    if (!await models.GrupoClinica.findByPk(scope.groupId, { transaction, lock: transaction.LOCK.UPDATE })) fail('scope_not_found', 404);
    const clinics = await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId },
      attributes: ['id_clinica', 'nombre_clinica', 'estado_clinica'], raw: true, transaction, lock: transaction.LOCK.UPDATE });
    const members = new Set(clinics.map(row => Number(row.id_clinica)));
    if (members.size !== scope.clinicIds.length || scope.clinicIds.some(id => !members.has(id))) fail('workspace_assignment_scope_changed');
    if (!assignmentClinics(clinics).some(row => row.id === input.clinic_id)) fail('workspace_assignment_clinic_forbidden', 403);
    const setting = await models.CampaignWorkspaceSetting.findOne({ where: settingScope(scope), transaction, lock: transaction.LOCK.UPDATE });
    if (Number(setting?.version || 0) !== input.expected_version) fail('workspace_version_conflict');
    const authorized = await accountScope({ models, groupId: scope.groupId, provider: input.provider,
      accountId: input.account_id, transaction, lock: true });
    if (!authorized) fail('workspace_assignment_account_forbidden', 403);
    const inventory = await loadInventory({ models, scope, transaction });
    const campaign = inventory.campaigns.find(row => row.provider === input.provider
      && row.account_id === input.account_id && row.campaign_id === input.campaign_id && campaignIncluded(row, setting));
    if (!campaign) fail('workspace_assignment_campaign_unavailable', 404);
    if (campaign.assigned) fail('workspace_assignment_already_reviewed');
    await createReviewedAssignment({ models, actorId, campaign, clinicId: input.clinic_id,
      groupId: scope.groupId, groupClinicIds: members, transaction, now });
    return { success: true, assignment: { provider: input.provider, account_id: input.account_id,
      campaign_id: input.campaign_id, clinic_id: input.clinic_id, version: 1 } };
  });
}

async function createReviewedAssignment({ models, actorId, campaign, clinicId, groupId, groupClinicIds, transaction, now = () => new Date() }) {
    // A prior decision, including a formatted alias, is never implicitly replaced.
    const prior = await models.ExternalCampaignAssignment.findAll({ where: { provider: campaign.provider,
      customer_id: { [Op.in]: accountAliases(campaign.provider, campaign.account_id) }, campaign_id: campaign.campaign_id }, transaction, lock: transaction.LOCK.UPDATE });
    if (prior.length) fail('workspace_assignment_already_reviewed');
    const values = { provider: campaign.provider, customer_id: campaign.account_id, campaign_id: campaign.campaign_id,
      campaign_name_snapshot: campaign.name, grupo_clinica_id: groupId || null, clinica_id: clinicId,
      match_kind: 'manual', match_confidence: null, match_explanation: 'Clínica confirmada desde la preparación de campañas.',
      status: 'active', version: 1, approved_by_user_id: actorId, approved_at: now() };
    const result = await saveAssignmentWithinScope({ assignmentModel: models.ExternalCampaignAssignment, values,
      groupId, groupClinicIds, transaction, returnMetadata: true,
      prepareValues: (current, next) => { if (current) fail('workspace_assignment_already_reviewed'); return next; },
    });
    await appendAssignmentAudit({ auditModel: models.ExternalCampaignAssignmentAudit, assignmentId: result.row.id,
      eventType: AUDIT_EVENT_TYPES.CLINIC_ASSIGNED, actorUserId: actorId, fromVersion: 0, toVersion: 1,
      changes: buildChanges({}, values, Object.keys(values)), transaction });
    return result.row;
}

module.exports = { assignWorkspaceCampaign, assignmentClinics, createReviewedAssignment };
