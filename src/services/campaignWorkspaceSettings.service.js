'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');

const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false, required: ['expected_version', 'accounts'], properties: {
    expected_version: { type: 'integer', minimum: 0 },
    accounts: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['provider', 'account_id', 'include_future', 'campaign_ids'],
      properties: {
        provider: { enum: ['google_ads', 'meta_ads'] }, account_id: { type: 'string', pattern: '^[0-9]{1,64}$' },
        include_future: { type: 'boolean' },
        campaign_ids: { type: 'array', maxItems: 2000, uniqueItems: true, items: { type: 'string', pattern: '^[0-9]{1,128}$' } },
      },
    } },
  },
});

function workspaceError(code, status = 409) { return Object.assign(new Error(code), { status, code }); }
function settingScope(scope) {
  if (scope.groupId) return { scope_type: 'group', scope_id: scope.groupId };
  if (scope.clinicIds?.length === 1) return { scope_type: 'clinic', scope_id: scope.clinicIds[0] };
  throw workspaceError('single_workspace_scope_required', 400);
}
function publicSettings(row, scope) {
  const value = row?.get ? row.get({ plain: true }) : row;
  const activation = value?.activation ? { ...value.activation, signals: value.activation.signals
    ? { enabled: value.activation.signals.enabled, events: value.activation.signals.events } : undefined } : null;
  return { scope: settingScope(scope), version: value?.version || 0, accounts: value?.accounts || [],
    activation, preferences: value?.preferences || null, updatedAt: value?.updated_at || null };
}
function canonicalAccounts(accounts) {
  return accounts.map(account => ({ ...account, campaign_ids: [...account.campaign_ids].sort() }))
    .sort((a, b) => `${a.provider}:${a.account_id}`.localeCompare(`${b.provider}:${b.account_id}`));
}

function validateAccountSelection(input, inventory, current = null) {
  if (!validate(input)) throw workspaceError('invalid_workspace_settings', 400);
  const keys = new Set();
  for (const account of input.accounts) {
    const key = `${account.provider}:${account.account_id}`;
    if (keys.has(key)) throw workspaceError('duplicate_workspace_account', 400);
    keys.add(key);
    const mapped = account.provider === 'google_ads'
      ? inventory.google.some(row => String(row.customerId).replace(/\D/g, '') === account.account_id)
      : inventory.meta.some(row => String(row.metaAssetId).replace(/\D/g, '') === account.account_id);
    if (!mapped) throw workspaceError('workspace_account_not_mapped', 403);
    const known = new Set(inventory.campaigns.filter(c => c.provider === account.provider && c.account_id === account.account_id).map(c => c.campaign_id));
    // Previously selected campaigns can remain after archival; permission to read them is still rechecked on every report.
    for (const old of current?.accounts || []) {
      if (old.provider === account.provider && old.account_id === account.account_id) for (const id of old.campaign_ids || []) known.add(id);
    }
    if (account.campaign_ids.some(id => !known.has(id))) throw workspaceError('workspace_campaign_not_in_scope', 403);
  }
  return canonicalAccounts(input.accounts);
}

async function saveWorkspaceAccounts({ models, scope, actorId, input, loadInventory, now = () => new Date() }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw workspaceError('unauthenticated', 401);
  if (!validate(input)) throw workspaceError('invalid_workspace_settings', 400);
  const where = settingScope(scope);
  return models.sequelize.transaction(async transaction => {
    // Serialize first creation as well as edits without relying on a row that does not exist yet.
    const ownerModel = where.scope_type === 'group' ? models.GrupoClinica : models.Clinica;
    const owner = await ownerModel.findByPk(where.scope_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!owner) throw workspaceError('scope_not_found', 404);
    const current = await models.CampaignWorkspaceSetting.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (Number(current?.version || 0) !== input.expected_version) throw workspaceError('workspace_version_conflict');
    const inventory = await loadInventory({ models, scope, transaction });
    const accounts = validateAccountSelection(input, inventory, current);
    if (current && JSON.stringify(canonicalAccounts(current.accounts || [])) === JSON.stringify(accounts)) {
      return { success: true, changed: false, configuration: publicSettings(current, scope) };
    }
    const previous = current?.accounts || [];
    const version = Number(current?.version || 0) + 1;
    const row = current ? await current.update({ accounts, version, signal_preparation: null, updated_by_user_id: actorId }, { transaction })
      : await models.CampaignWorkspaceSetting.create({ id: crypto.randomUUID(), ...where, version, accounts,
        activation: null, updated_by_user_id: actorId }, { transaction });
    await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: row.id, version,
      event_type: 'accounts_selected', actor_user_id: actorId, changes: { accounts: { before: previous, after: accounts } }, created_at: now() }, { transaction });
    return { success: true, changed: true, configuration: publicSettings(row, scope) };
  });
}

function campaignIncluded(campaign, settings) {
  if (!settings) return true;
  const account = (settings.accounts || []).find(row => row.provider === campaign.provider && row.account_id === campaign.account_id);
  return !!account && (account.include_future === true || account.campaign_ids.includes(campaign.campaign_id));
}

module.exports = { settingScope, publicSettings, validateAccountSelection, saveWorkspaceAccounts, campaignIncluded };
