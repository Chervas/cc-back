'use strict';

const { randomUUID } = require('node:crypto');
const C = require('./metaMarketingOAuth.contract');

// Only the OAuth gateway can request an empty, scope-bound candidate. The
// broker is the authority for provisioning; CRM never handles a secret.
function createAdmission({ client, now = () => new Date(), env = process.env } = {}) {
  const enabled = scopeKey => env.META_MARKETING_OAUTH_SELF_SERVICE_ENABLED === 'true' &&
    String(env.META_MARKETING_OAUTH_SELF_SERVICE_SCOPES || '').split(',').includes(scopeKey);

  async function prepare(snapshot) {
    if (!enabled(snapshot.scopeKey)) C.fail('meta_oauth_admission_required', 409);
    const { OPERATION, connectionRef } = require('../../services/integrations-broker/src/meta-marketing-admission-contract');
    const { scopeKey, clinicIds, scopeDigest, sessionExpiresAt } = snapshot;
    const requestId = randomUUID();
    const expiresAt = Math.min(+now() + 120000, +sessionExpiresAt);
    if (expiresAt <= +now()) C.fail('meta_oauth_session_required', 401);
    const response = await client.execute({
      requestId,
      operation: OPERATION,
      tenantRef: `clinic:${clinicIds[0]}`,
      connectionRef: connectionRef(scopeKey),
      assetRef: `meta-enroll:${scopeKey}`,
      payload: { scopeKey, clinicIds, scopeDigest, clinicSetDigest: C.hash(JSON.stringify(clinicIds)), expiresAt },
    }, { timeoutMs: 30000 });
    if (!enabled(scopeKey) || +now() >= expiresAt) C.fail('meta_oauth_scope_changed', 409);
    if (!C.exact(response, 'requestId,replayed,data') || response.requestId !== requestId || typeof response.replayed !== 'boolean' ||
        !C.exact(response.data, 'status,connected,binding') || response.data.status !== 'prepared' || response.data.connected !== false) {
      C.fail('broker_response_invalid');
    }
    const binding = response.data.binding;
    if (!C.exact(binding, 'connectionRef,scopeKey,clinicIds,assetRef,appId,scopes,redirectUri,expiresAt') ||
        binding.scopeKey !== scopeKey || binding.connectionRef !== connectionRef(scopeKey) ||
        JSON.stringify(binding.clinicIds) !== JSON.stringify(clinicIds) ||
        !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= +now()) C.fail('broker_response_invalid');
    const row = {
      scope_key: scopeKey,
      connection_ref: binding.connectionRef,
      asset_ref: binding.assetRef,
      app_id: binding.appId,
      clinic_ids: JSON.stringify(binding.clinicIds),
      scopes: JSON.stringify(binding.scopes),
      redirect_uri: binding.redirectUri,
      expires_at: new Date(binding.expiresAt),
      state: 'active',
    };
    C.slot(row);
    return row;
  }

  return { enabled, prepare };
}

module.exports = { createAdmission };
