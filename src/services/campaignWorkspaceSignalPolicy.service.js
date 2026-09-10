'use strict';

const CRM_EVENTS = new Set(['lead', 'contact', 'qualifiedlead', 'schedule', 'purchase']);
const VERIFIED_MILESTONES = new Set(['qualifiedlead', 'schedule', 'purchase']);
// A JSON request cannot mint the in-process capability used by CRM lifecycle handlers.
const CRM_MILESTONE_SOURCE = Symbol('campaign_crm_milestone');
const normalizedEvent = value => String(value || '').replace(/[_\s-]/g, '').toLowerCase();
const denied = (reason, version = null) => ({ applicable: true, allowed: false, reason, version });
const legacy = () => ({ applicable: false, allowed: true, reason: 'existing_signal_policy', version: null });

function accountIncludes(account, campaignId) {
  if (!account) return false;
  if (account.include_future === true) return true;
  return !!campaignId && Array.isArray(account.campaign_ids) && account.campaign_ids.includes(String(campaignId));
}

function workspaceSignalDecision({ setting, provider, accountId, campaignId = null, eventName, crmEventSource = null }) {
  if (!CRM_EVENTS.has(normalizedEvent(eventName))) return legacy();
  const activation = setting?.activation;
  if (!activation || activation.schema_version !== 1 || !['measurement', 'optimize'].includes(activation.mode)) {
    return denied('workspace_activation_invalid', setting?.version);
  }
  if (activation.status !== 'active') return denied('workspace_activation_inactive', setting.version);
  if (activation.signals?.enabled !== true) return denied('workspace_signals_disabled', setting.version);
  if (!Array.isArray(activation.signals.events)
    || !activation.signals.events.some(event => normalizedEvent(event) === normalizedEvent(eventName))) {
    return denied('workspace_event_not_authorized', setting.version);
  }
  if (VERIFIED_MILESTONES.has(normalizedEvent(eventName)) && crmEventSource !== CRM_MILESTONE_SOURCE) {
    return denied('workspace_crm_milestone_required', setting.version);
  }
  const cleanAccountId = String(accountId || '').replace(/^act_/i, '').replace(/-/g, '');
  if (!['google_ads', 'meta_ads'].includes(provider) || !/^\d+$/.test(cleanAccountId)) return denied('workspace_account_required', setting.version);
  const matches = account => account.provider === provider && account.account_id === cleanAccountId;
  const selected = Array.isArray(setting.accounts) ? setting.accounts.filter(matches) : [];
  const authorized = Array.isArray(activation.account_authorizations) ? activation.account_authorizations.filter(matches) : [];
  if (selected.length !== 1 || authorized.length !== 1) return denied('workspace_account_not_authorized', setting.version);
  // Both the current selection and the explicit activation snapshot constrain the grant.
  if (!accountIncludes(selected[0], campaignId) || !accountIncludes(authorized[0], campaignId)) {
    return denied('workspace_campaign_not_authorized', setting.version);
  }
  return { applicable: true, allowed: true, reason: 'workspace_signal_authorized', version: setting.version };
}

async function resolveWorkspaceSignalPolicy({ records = [], provider, accountId, campaignId, eventName, crmEventSource = null,
  loadSetting = id => require('../../models').CampaignWorkspaceSetting.findByPk(id, { raw: true }) }) {
  if (!CRM_EVENTS.has(normalizedEvent(eventName))) return legacy();
  const references = records.filter(record => record?.config?.campaigns
    && Object.prototype.hasOwnProperty.call(record.config.campaigns, 'workspace_policy'));
  if (!references.length) return legacy();
  let result = legacy();
  const checked = new Set();
  for (const record of references) {
    const reference = record.config.campaigns.workspace_policy;
    const scopeType = record.assignment_scope === 'group' ? 'group' : 'clinic';
    const scopeId = Number(scopeType === 'group' ? record.group_id : record.clinic_id);
    if (!reference || reference.schema_version !== 1 || typeof reference.setting_id !== 'string'
      || reference.scope_type !== scopeType || Number(reference.scope_id) !== scopeId || !Number.isSafeInteger(scopeId) || scopeId <= 0) {
      return denied('workspace_policy_reference_invalid');
    }
    const key = `${reference.setting_id}:${scopeType}:${scopeId}`;
    if (checked.has(key)) continue;
    checked.add(key);
    // No authorization cache: revocation must be visible to the next upload.
    const setting = await loadSetting(reference.setting_id);
    if (!setting || setting.scope_type !== scopeType || Number(setting.scope_id) !== scopeId) return denied('workspace_policy_scope_mismatch');
    result = workspaceSignalDecision({ setting, provider, accountId, campaignId, eventName, crmEventSource });
    if (!result.allowed) return result;
  }
  return result;
}

module.exports = { workspaceSignalDecision, resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE };
