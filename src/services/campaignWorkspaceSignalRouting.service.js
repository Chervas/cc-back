'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { workspaceSignalDecision } = require('./campaignWorkspaceSignalPolicy.service');

const id = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value);
const eventKey = value => String(value || '').replace(/[_\s-]/g, '').toLowerCase();
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function loadSignalRoutingScope({ models, clinicId, transaction = null }) {
  const clinic = await models.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], raw: true, transaction });
  if (Number(clinic?.id_clinica) !== clinicId || ![true, 1, '1'].includes(clinic.estado_clinica)) fail('workspace_signal_clinic_inactive');
  const owners = [{ scope_type: 'clinic', scope_id: clinicId },
    ...(clinic.grupoClinicaId ? [{ scope_type: 'group', scope_id: Number(clinic.grupoClinicaId) }] : [])];
  const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: owners }, raw: true, transaction });
  return { clinic, owners, settings };
}

// Resolve destinations from explicit workspace mandates, without using web/widget settings.
async function resolveWorkspaceSignalRoute({ models, provider, accountId, campaignId, clinicId, eventName,
  crmEventSource = null, now = new Date(), transaction = null, loadScope = loadSignalRoutingScope,
  verify = input => require('./campaignWorkspaceSignalAuthorization.service').verifySignalDestination(input) }) {
  if (!['google_ads', 'meta_ads'].includes(provider) || !id(accountId)
    || !Number.isSafeInteger(clinicId) || clinicId < 1) fail('workspace_signal_route_invalid');
  const { clinic, owners, settings } = await loadScope({ models, clinicId, transaction });
  const mandates = settings.filter(row => row.activation && row.activation.schema_version !== 1);
  if (!mandates.length) return null;
  if (settings.some(row => row.activation?.schema_version === 1)) fail('workspace_signal_scope_migration_required');
  if (new Set(mandates.map(row => `${row.scope_type}:${row.scope_id}`)).size !== mandates.length
    || mandates.some(row => !owners.some(owner => owner.scope_type === row.scope_type && owner.scope_id === row.scope_id))) fail('workspace_signal_scope_invalid');
  const refs = []; const grants = []; let runtime = null; let destinationId = null;
  for (const setting of mandates.sort((a, b) => a.id.localeCompare(b.id))) {
    const decision = workspaceSignalDecision({ setting, provider, accountId, campaignId, eventName, crmEventSource });
    if (!decision.allowed) fail(decision.reason);
    if (setting.activation.schema_version !== 2 || !Number.isSafeInteger(setting.version) || setting.version < 1) fail('workspace_activation_invalid');
    const destinations = setting.activation.signals.authorization?.destinations;
    const account = Array.isArray(destinations) ? destinations.find(row => row?.provider === provider && row.account_id === accountId) : null;
    const event = Array.isArray(account?.events) ? account.events.find(row => eventKey(row?.event) === eventKey(eventName)) : null;
    if (!id(event?.destination_id)) fail('workspace_signal_destination_not_authorized');
    const verified = await verify({ models, setting, provider, accountId, clinicId, eventName, now, transaction,
      destinationId: provider === 'google_ads' ? `customers/${accountId}/conversionActions/${event.destination_id}` : event.destination_id,
      includeGrant: true });
    const current = verified.grant;
    if (!current?.connection?.accessToken) fail('workspace_signal_connection_changed');
    if (runtime && (destinationId !== verified.destinationId || Number(runtime.connection.id) !== Number(current.connection.id)
      || (runtime.loginCustomerId || null) !== (current.loginCustomerId || null))) fail('workspace_signal_routes_conflict');
    runtime = current; destinationId = verified.destinationId;
    refs.push({ setting_id: setting.id, scope_type: setting.scope_type, scope_id: setting.scope_id, version: setting.version });
    grants.push([setting.scope_type, setting.scope_id, current.grantFingerprint]);
  }
  const destinationKey = crypto.createHash('sha256').update(JSON.stringify({ clinic: clinicId, group: clinic.grupoClinicaId || null,
    provider, account: accountId, destination: destinationId, grants })).digest('hex');
  return { destinationId, destinationKey, connectionId: Number(runtime.connection.id), accessToken: runtime.connection.accessToken,
    loginCustomerId: runtime.loginCustomerId || null,
    authorization: { applicable: true, allowed: true, reason: 'workspace_signal_authorized', authorizationSchema: 2,
      version: refs[refs.length - 1].version, policyRefs: refs } };
}

module.exports = { loadSignalRoutingScope, resolveWorkspaceSignalRoute };
