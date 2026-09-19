'use strict';

const crypto = require('node:crypto');
const Ajv = require('ajv');
const { settingScope, publicSettings, validateAccountSelection } = require('./campaignWorkspaceSettings.service');

const EVENTS = ['lead', 'contact', 'qualified_lead', 'schedule'];
const ACTIONS = ['pause_underperforming_ads', 'adjust_bids', 'negative_keywords'];
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false, required: ['expected_version', 'preferences'], properties: {
    expected_version: { type: 'integer', minimum: 1 },
    preferences: { type: 'object', additionalProperties: false, required: ['mode', 'signals', 'optimization'], properties: {
      mode: { enum: ['measurement', 'optimize'] },
      signals: { type: 'object', additionalProperties: false, required: ['enabled', 'events'], properties: {
        enabled: { type: 'boolean' }, events: { type: 'array', uniqueItems: true, maxItems: 4, items: { enum: EVENTS } },
      } },
      optimization: { anyOf: [{ type: 'null' }, {
        type: 'object', additionalProperties: false, required: ['actions', 'budget_changes', 'monthly_limit_cents'], properties: {
          actions: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ACTIONS } },
          budget_changes: { type: 'boolean' },
          monthly_limit_cents: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 10000, maximum: 5000000 }] },
        },
      }] },
    } },
  },
});
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };

function preferenceDraft(input) {
  if (!validate(input)) fail('invalid_workspace_preferences', 400);
  const { mode, signals, optimization } = input.preferences;
  if (signals.enabled !== (signals.events.length > 0)
    || (mode === 'measurement' ? optimization !== null : !optimization)
    || optimization && optimization.budget_changes !== (optimization.monthly_limit_cents !== null)) fail('invalid_workspace_preferences', 400);
  return { schema_version: 1, mode, signals: { enabled: signals.enabled, events: EVENTS.filter(event => signals.events.includes(event)) },
    optimization: optimization ? { ...optimization, actions: ACTIONS.filter(action => optimization.actions.includes(action)), max_budget_change_pct: 10 } : null };
}

async function saveWorkspacePreferences({ models, scope, actorId, input, loadInventory, now = () => new Date() }) {
  const preferences = preferenceDraft(input);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  const owner = settingScope(scope);
  return models.sequelize.transaction(async transaction => {
    const ownerModel = scope.groupId ? models.GrupoClinica : models.Clinica;
    if (!await ownerModel.findByPk(owner.scope_id, { transaction, lock: transaction.LOCK.UPDATE })) fail('scope_not_found', 404);
    if (scope.groupId) {
      const members = await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId }, attributes: ['id_clinica'], raw: true,
        transaction, lock: transaction.LOCK.UPDATE });
      if (members.some(row => !scope.clinicIds.includes(Number(row.id_clinica)))) fail('workspace_scope_changed');
    }
    const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, transaction, lock: transaction.LOCK.UPDATE });
    if (!setting || Number(setting.version) !== input.expected_version) fail('workspace_version_conflict');
    if (!setting.accounts?.length) fail('workspace_accounts_required');
    const inventory = await loadInventory({ models, scope, transaction });
    validateAccountSelection({ expected_version: setting.version, accounts: setting.accounts }, inventory, setting);
    if (preferences.optimization?.actions.includes('negative_keywords') && !setting.accounts.some(account => account.provider === 'google_ads')) {
      fail('workspace_google_account_required');
    }
    if (JSON.stringify(setting.preferences) === JSON.stringify(preferences)) return { success: true, changed: false, configuration: publicSettings(setting, scope) };
    const previous = setting.preferences || null;
    const version = Number(setting.version) + 1;
    // Saving a draft cannot alter live senders, conversion targets, optimization policies or advertising.
    await setting.update({ preferences, version, signal_preparation: null, updated_by_user_id: actorId }, { transaction });
    await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version, actor_user_id: actorId,
      event_type: 'preferences_saved', changes: { preferences: { before: previous, after: preferences } }, created_at: now() }, { transaction });
    return { success: true, changed: true, configuration: publicSettings(setting, scope) };
  });
}

module.exports = { EVENTS, ACTIONS, preferenceDraft, saveWorkspacePreferences };
