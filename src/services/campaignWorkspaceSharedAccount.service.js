'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');
const { Op } = require('sequelize');
const { loadWorkspaceInventory } = require('./campaignWorkspace.service');
const { accountAliases } = require('./campaignWorkspaceReport.service');
const { settingScope, campaignIncluded } = require('./campaignWorkspaceSettings.service');
const { assignmentClinics, createReviewedAssignment } = require('./campaignWorkspaceAssignment.service');
const { findManagedCampaignAssociationAccountScope } = require('./managedCampaignAssociationScopes.service');

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const referenceSchema = { provider: { enum: ['google_ads', 'meta_ads'] }, account_id: { type: 'string', pattern: '^[1-9][0-9]{0,63}$' } };
const validateReference = new Ajv().compile({ type: 'object', additionalProperties: false,
  required: ['provider', 'account_id'], properties: referenceSchema });
const validateAssignment = new Ajv().compile({ type: 'object', additionalProperties: false,
  required: ['provider', 'account_id', 'revision', 'clinic_id', 'campaigns', 'confirmed'], properties: {
    ...referenceSchema, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, clinic_id: { type: 'integer', minimum: 1 }, confirmed: { const: true },
    campaigns: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false,
      required: ['campaign_id', 'revision'], properties: { campaign_id: { type: 'string', pattern: '^[1-9][0-9]{0,127}$' }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
  } });
const query = transaction => ({ raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const ids = rows => [...new Set(rows.map(row => Number(row.id_clinica)))].sort((a, b) => a - b);

function sharedAccountReference(input) {
  if (!validateReference(input)) fail('invalid_shared_account', 400);
  return { provider: input.provider, account_id: input.account_id };
}

async function sharedAccountContext({ models, scope, actorId, reference, hasAccess, transaction = null,
  loadInventory = loadWorkspaceInventory, accountScope = findManagedCampaignAssociationAccountScope }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  if (scope.isAll) fail('single_workspace_scope_required', 400);
  const owner = settingScope(scope); const options = query(transaction);
  if (!await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, options)) fail('scope_not_found', 404);
  const clinics = await models.Clinica.findAll({ where: scope.groupId ? { grupoClinicaId: scope.groupId } : { id_clinica: scope.clinicIds[0] },
    attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'estado_clinica'], ...options });
  if (JSON.stringify(ids(clinics)) !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_assignment_scope_changed');
  const local = await loadInventory({ models, scope, transaction, accountReference: reference });
  const account = local.accounts.find(row => row.provider === reference.provider && row.id === reference.account_id);
  if (!account) fail('workspace_account_not_mapped', 403);
  const google = reference.provider === 'google_ads';
  const model = google ? models.ClinicGoogleAdsAccount : models.ClinicMetaAsset;
  const owners = await model.findAll({ where: { isActive: true,
    ...(google ? { customerId: { [Op.in]: accountAliases(reference.provider, reference.account_id) } }
      : { assetType: 'ad_account', metaAssetId: { [Op.in]: accountAliases(reference.provider, reference.account_id) } }),
  }, attributes: ['id', 'assignmentScope', 'clinicaId', 'grupoClinicaId', google ? 'googleConnectionId' : 'metaConnectionId'], ...options });
  if (!owners.length || owners.some(row => !['clinic', 'group'].includes(row.assignmentScope)
    || !validId(row.assignmentScope === 'group' ? row.grupoClinicaId : row.clinicaId))) fail('workspace_shared_account_owner_unresolved');
  const clinicOwners = [...new Set(owners.filter(row => row.assignmentScope === 'clinic').map(row => Number(row.clinicaId)))];
  const groupOwners = [...new Set(owners.filter(row => row.assignmentScope === 'group').map(row => Number(row.grupoClinicaId)))];
  const members = await models.Clinica.findAll({ where: { [Op.or]: [
    ...(clinicOwners.length ? [{ id_clinica: { [Op.in]: clinicOwners } }] : []),
    ...(groupOwners.length ? [{ grupoClinicaId: { [Op.in]: groupOwners } }] : []),
  ] }, attributes: ['id_clinica', 'grupoClinicaId'], ...options });
  if (clinicOwners.some(id => !members.some(row => Number(row.id_clinica) === id))
    || groupOwners.some(id => !members.some(row => Number(row.grupoClinicaId) === id))) fail('workspace_shared_account_owner_unresolved');
  const allClinicIds = [...new Set([...ids(members), ...scope.clinicIds])].sort((a, b) => a - b);
  const permitted = async () => {
    const membershipModel = models.UsuarioClinica ? { findAll: input => models.UsuarioClinica.findAll({ ...input, transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) }) } : undefined;
    if (!hasAccess || !await hasAccess({ userId: actorId, clinicIds: allClinicIds, access: 'write', membershipModel })) fail('workspace_shared_account_access_required', 403);
  };
  // Widen only this explicit account review, after checking every owner's clinics. Reports stay scoped.
  await permitted();
  const authorization = await accountScope({ models, groupId: scope.groupId || null,
    clinicId: scope.groupId ? null : scope.clinicIds[0], provider: reference.provider, accountId: reference.account_id, transaction, lock: !!transaction });
  if (!authorization) fail('workspace_assignment_account_forbidden', 403);
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...options });
  const inventory = await loadInventory({ models, scope: { clinicIds: allClinicIds }, transaction, accountReference: reference });
  await permitted();
  const campaigns = inventory.campaigns.filter(row => row.provider === reference.provider && row.account_id === reference.account_id && !row.assigned)
    .map(row => ({ ...row, revision: hash([row.provider, row.account_id, row.campaign_id, row.name]) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.campaign_id.localeCompare(b.campaign_id));
  const revision = hash({ owner, members: allClinicIds,
    mappings: owners.map(row => [row.id, row.assignmentScope, row.clinicaId, row.grupoClinicaId, row.googleConnectionId || row.metaConnectionId]).sort((a, b) => Number(a[0]) - Number(b[0])),
    settingVersion: setting?.version || 0, accounts: setting?.accounts || [],
  });
  return { account, campaigns, clinics, setting, revision, permitted };
}

async function loadSharedAccountReview(options) {
  const reference = sharedAccountReference(options.input);
  const page = Number(options.page || 1); const search = String(options.search || '').trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || search.length > 100) fail('invalid_shared_account_page', 400);
  const result = await sharedAccountContext({ ...options, reference });
  const filtered = result.campaigns.filter(row => `${row.name} ${row.campaign_id}`.toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es')));
  return { success: true, account: result.account, revision: result.revision, clinics: assignmentClinics(result.clinics),
    page, pageSize: 10, total: filtered.length,
    campaigns: filtered.slice((page - 1) * 10, page * 10).map(row => ({ campaign_id: row.campaign_id, name: row.name,
      status: row.status || 'UNKNOWN', revision: row.revision, included: campaignIncluded(row, result.setting) })),
  };
}

async function assignSharedAccountCampaigns(options) {
  const { models, scope, actorId, input } = options;
  if (!validateAssignment(input) || new Set(input.campaigns.map(row => row.campaign_id)).size !== input.campaigns.length) fail('invalid_shared_account_assignment', 400);
  const reference = sharedAccountReference({ provider: input.provider, account_id: input.account_id });
  return models.sequelize.transaction(async transaction => {
    const context = await sharedAccountContext({ ...options, reference, transaction });
    if (context.revision !== input.revision) fail('workspace_shared_account_changed');
    if (!assignmentClinics(context.clinics).some(row => row.id === input.clinic_id)) fail('workspace_assignment_clinic_forbidden', 403);
    const campaigns = input.campaigns.map(item => {
      const campaign = context.campaigns.find(row => row.campaign_id === item.campaign_id && row.revision === item.revision);
      if (!campaign) fail('workspace_shared_account_changed');
      return campaign;
    });
    await context.permitted();
    const clinic = context.clinics.find(row => Number(row.id_clinica) === input.clinic_id);
    for (const campaign of campaigns) await createReviewedAssignment({ models, actorId, campaign, clinicId: input.clinic_id,
      groupId: scope.groupId || clinic.grupoClinicaId || null, groupClinicIds: new Set(scope.clinicIds), transaction, now: options.now });
    return { success: true, assigned: campaigns.length, included: campaigns.filter(row => campaignIncluded(row, context.setting)).length };
  });
}

module.exports = { sharedAccountReference, sharedAccountContext, loadSharedAccountReview, assignSharedAccountCampaigns };
