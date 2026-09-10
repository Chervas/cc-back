'use strict';

const { googlePreparationContext } = require('./campaignWorkspaceGooglePreparation.service');
const { metaSignalPreparationContext } = require('./campaignWorkspaceMetaSignalPreparation.service');
const { EVENTS } = require('./campaignWorkspacePreferences.service');
const { settingScope } = require('./campaignWorkspaceSettings.service');

const TTL_MS = 86400000;
const id = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const eventKey = value => String(value || '').replace(/[_\s-]/g, '').toLowerCase();
const positive = value => Number.isSafeInteger(value) && value > 0;
const uniqueEvents = events => Array.isArray(events) && events.length > 0 && events.length === new Set(events).size
  && events.every(event => EVENTS.includes(event));
const sameEvents = (a, b) => uniqueEvents(a) && uniqueEvents(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeError = error => /^(workspace_(google|meta)_[a-z_]+|workspace_(scope_changed|account_not_selected|signal_preferences_required))$/.test(error?.code || '')
  ? error.code : 'workspace_signal_check_unavailable';

async function currentGrant({ models, scope, account, events, now, transaction }) {
  const resolve = account.provider === 'google_ads' ? googlePreparationContext : metaSignalPreparationContext;
  if (!['google_ads', 'meta_ads'].includes(account.provider) || !id(account.account_id)) fail('workspace_signal_account_invalid');
  return resolve({ models, scope, accountId: account.account_id, signalEvents: events, now, transaction });
}

function checkedProof(record, context, now) {
  const checkedAt = typeof record?.checked_at === 'string' ? Date.parse(record.checked_at) : NaN;
  const expiresAt = typeof record?.expires_at === 'string' ? Date.parse(record.expires_at) : NaN;
  return record?.schema_version === 1 && record.status === 'checked' && record.fingerprint === context.fingerprint
    && typeof record.run_id === 'string' && /^[a-f0-9-]{36}$/.test(record.run_id)
    && Number.isFinite(checkedAt) && checkedAt <= +now && expiresAt > +now && expiresAt - checkedAt === TTL_MS;
}

function preparedAccount(context, account, events, now) {
  const proof = context.setting.signal_preparation?.[account.provider]?.[account.account_id];
  const result = { provider: account.provider, account_id: account.account_id, ready: false, status: 'pending',
    checked_at: null, expires_at: null, error: null, events: events.map(event => ({ event, destination_id: null, destination_name: null, ready: false })) };
  if (!proof) return { review: result, destination: null };
  if (!checkedProof(proof, context, now)) {
    const checking = proof.status === 'checking' && proof.fingerprint === context.fingerprint
      && typeof proof.started_at === 'string' && +new Date(proof.started_at) <= +now && +new Date(proof.started_at) + 120000 > +now;
    return { review: { ...result, status: checking ? 'checking' : 'stale' }, destination: null };
  }
  result.checked_at = proof.checked_at; result.expires_at = proof.expires_at;
  const completeEvents = account.provider === 'meta_ads' || Array.isArray(proof.events)
    && sameEvents(proof.events.map(row => row?.event), events);
  result.events = result.events.map(row => {
    if (account.provider === 'meta_ads') return { ...row, destination_id: id(proof.dataset_id) ? proof.dataset_id : null,
      destination_name: typeof proof.dataset_name === 'string' ? proof.dataset_name.slice(0, 255) : null,
      ready: proof.state === 'access_verified' && proof.error === null && id(proof.dataset_id) };
    const record = completeEvents ? proof.events.find(item => item.event === row.event) : null;
    return { ...row, destination_id: id(record?.action_id) ? record.action_id : null,
      ready: !!record && record.state === 'verified' && record.error === null && id(record.action_id) && hash(record.action_fingerprint) };
  });
  result.ready = result.events.every(row => row.ready);
  result.status = result.ready ? 'ready' : 'failed';
  if (!result.ready) result.error = 'workspace_signal_preparation_required';
  return { review: result, destination: result.ready ? {
    provider: account.provider, account_id: account.account_id, grant_fingerprint: context.grantFingerprint,
    connection_id: Number(context.connection.id), login_customer_id: context.loginCustomerId || null,
    proof_run_id: proof.run_id, proof_checked_at: proof.checked_at,
    events: result.events.map(row => ({ event: row.event, destination_id: row.destination_id })),
  } : null };
}

async function loadSignalAuthorizationReview({ models, scope, setting, now = new Date(), transaction = null,
  resolveGrant = currentGrant }) {
  const signals = setting?.preferences?.signals;
  if (!signals?.enabled) return { review: { enabled: false, ready: false, accounts: [] }, authorization: null };
  if (!uniqueEvents(signals.events) || !Array.isArray(setting.accounts) || !setting.accounts.length
    || new Set(setting.accounts.map(row => `${row.provider}:${row.account_id}`)).size !== setting.accounts.length) {
    return { review: { enabled: true, ready: false, accounts: [], error: 'workspace_signal_preferences_required' }, authorization: null };
  }
  const accounts = []; const destinations = [];
  for (const account of setting.accounts) {
    try {
      const context = await resolveGrant({ models, scope, account, events: signals.events, now, transaction });
      // A review may span several accounts. Reject a configuration changed during the read.
      if (context.setting.id !== setting.id || context.setting.version !== setting.version) fail('workspace_scope_changed');
      const result = preparedAccount(context, account, signals.events, now);
      accounts.push(result.review); if (result.destination) destinations.push(result.destination);
    } catch (error) {
      accounts.push({ provider: account.provider, account_id: account.account_id, ready: false, status: 'failed',
        checked_at: null, expires_at: null, events: [], error: safeError(error) });
    }
  }
  const ready = accounts.length > 0 && accounts.every(row => row.ready);
  return { review: { enabled: true, ready, accounts }, authorization: ready ? {
    schema_version: 1, clinic_ids: [...scope.clinicIds].sort((a, b) => a - b), destinations,
  } : null };
}

async function verifySignalDestination({ models, setting, provider, accountId, clinicId, eventName, destinationId,
  connectionId, loginCustomerId, now = new Date(), transaction = null, resolveGrant = currentGrant }) {
  if (!['google_ads', 'meta_ads'].includes(provider) || !id(accountId)) fail('workspace_signal_account_invalid');
  const authorization = setting.activation?.signals?.authorization;
  if (!authorization || authorization.schema_version !== 1 || !Array.isArray(authorization.clinic_ids)
    || !authorization.clinic_ids.length || authorization.clinic_ids.some(value => !positive(value))
    || new Set(authorization.clinic_ids).size !== authorization.clinic_ids.length
    || !positive(clinicId) || !authorization.clinic_ids.includes(clinicId)
    || !Array.isArray(authorization.destinations)) fail('workspace_signal_authorization_required');
  const events = setting.activation.signals.events;
  if (!uniqueEvents(events)) fail('workspace_signal_authorization_invalid');
  const matches = authorization.destinations.filter(row => row?.provider === provider && row.account_id === accountId);
  const destination = matches.length === 1 ? matches[0] : null;
  if (!destination || !hash(destination.grant_fingerprint) || !positive(destination.connection_id)
    || !Array.isArray(destination.events) || !sameEvents(destination.events.map(row => row?.event), events)) fail('workspace_signal_authorization_invalid');
  const event = destination.events.find(row => eventKey(row.event) === eventKey(eventName));
  const target = provider === 'google_ads'
    ? new RegExp(`^customers/${accountId}/conversionActions/([0-9]{1,64})$`).exec(destinationId || '')?.[1] : destinationId;
  if (!event || !id(event.destination_id) || target !== event.destination_id) fail('workspace_signal_destination_not_authorized');
  const scope = { clinicIds: authorization.clinic_ids, groupId: setting.scope_type === 'group' ? setting.scope_id : null };
  const owner = settingScope(scope);
  if (owner.scope_type !== setting.scope_type || owner.scope_id !== setting.scope_id) fail('workspace_signal_authorization_invalid');
  const clinic = await models.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'estado_clinica', 'grupoClinicaId'], raw: true, transaction });
  if (Number(clinic?.id_clinica) !== clinicId || ![true, 1, '1'].includes(clinic.estado_clinica)
    || scope.groupId && Number(clinic.grupoClinicaId) !== scope.groupId) fail('workspace_signal_clinic_inactive');
  const current = await resolveGrant({ models, scope, account: { provider, account_id: accountId }, events, now, transaction });
  if (current.setting.id !== setting.id || current.setting.version !== setting.version
    || current.grantFingerprint !== destination.grant_fingerprint || Number(current.connection.id) !== destination.connection_id
    || (current.loginCustomerId || null) !== (destination.login_customer_id || null)
    || connectionId !== undefined && (Number(connectionId) !== destination.connection_id
      || provider === 'google_ads' && (loginCustomerId || null) !== (destination.login_customer_id || null))) fail('workspace_signal_connection_changed');
  return { destinationId: event.destination_id, connectionId: destination.connection_id };
}

module.exports = { currentGrant, checkedProof, preparedAccount, loadSignalAuthorizationReview, verifySignalDestination };
