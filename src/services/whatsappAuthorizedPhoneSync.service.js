'use strict';

// The hourly health check uses the same authorized profile reader as the UI.
// Queue payloads contain routing identity only, never provider credentials.
const ASSET_ATTRIBUTES = ['id', 'assetType', 'isActive', 'assignmentScope', 'clinicaId',
  'grupoClinicaId', 'phoneNumberId', 'wabaId', 'whatsappAuthorizationId'];
const BINDING_KEYS = ['connectionRef', 'authorizationId', 'clinicId', 'assetId',
  'phoneId', 'wabaId', 'revision', 'sendEnabled', 'messageNotBefore'];
const positiveId = value => Number.isInteger(value) && value > 0;
const DEDUPE_STATUSES = ['pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'];
const DENIED = new Set(['connection_blocked', 'scope_denied', 'whatsapp_authorized_scope_blocked',
  'whatsapp_authorized_binding_invalid', 'whatsapp_authorized_binding_changed']);
const active = asset => asset?.assetType === 'whatsapp_phone_number'
  && (asset.isActive === true || asset.isActive === 1);
const sameBinding = (left, right) => !!left && !!right
  && BINDING_KEYS.every(key => left[key] === right[key]);

function createService({
  broker = require('../lib/whatsappAuthorizedBrokerClient'),
  loadAsset = assetId => require('../../models').ClinicMetaAsset.findByPk(assetId, { attributes: ASSET_ATTRIBUTES }),
  enqueueJob = input => require('./jobRequests.service').enqueueUniqueJobRequest(input, { activeStatuses: DEDUPE_STATUSES }),
  refresh = input => require('./whatsappAuthorizedPhoneRefresh.service').refresh(input),
  now = () => new Date(),
} = {}) {
  async function eligible(candidate) {
    const asset = await loadAsset(candidate.assetId);
    if (!active(asset)) return null;
    const binding = await broker.binding(candidate.clinicId, candidate.assetId, asset);
    if (!sameBinding(candidate, binding) || binding.sendEnabled !== true) return null;
    return { asset, binding };
  }

  async function enqueue() {
    const configured = broker.configuration();
    if (!configured) return { queued: 0, skipped: 0, mode: 'authorized' };
    const seen = new Set();
    const summary = { queued: 0, skipped: 0, mode: 'authorized' };
    const hour = Math.floor(now().getTime() / 3600000);
    for (const candidate of configured.bindings) {
      if (seen.has(candidate.assetId)) continue;
      let target;
      try { target = await eligible(candidate); }
      catch (error) {
        // A withdrawn scope does not prevent the remaining phones being checked.
        if (['whatsapp_authorized_scope_blocked', 'whatsapp_authorized_binding_invalid',
          'whatsapp_authorized_binding_changed'].includes(error?.code)) {
          summary.skipped += 1;
          continue;
        }
        throw error;
      }
      if (!target) { summary.skipped += 1; continue; }
      const result = await enqueueJob({ type: 'whatsapp_phones_sync', priority: 'low',
        origin: 'scheduled_whatsapp_profile', maxAttempts: 3,
        payload: { mode: 'authorized', assetId: candidate.assetId,
          clinicId: candidate.clinicId, expectedBinding: target.binding },
        // Include terminal jobs in native transactional deduplication. A second
        // pass in the same hour must not repeat a completed provider read.
        dedupeScope: `wa-phone-health-${candidate.assetId}-${hour}`,
      });
      seen.add(candidate.assetId);
      if (result.created) summary.queued += 1;
    }
    return summary;
  }

  async function run(input = {}) {
    const { assetId, clinicId, expectedBinding } = input;
    if (!positiveId(assetId) || !positiveId(clinicId)
      || expectedBinding?.assetId !== assetId || expectedBinding?.clinicId !== clinicId) {
      throw Object.assign(Error('whatsapp_authorized_phone_sync_invalid'), { code: 'whatsapp_authorized_phone_sync_invalid' });
    }
    try {
      const target = await eligible(expectedBinding);
      if (!target) return { skipped: true, reason: 'whatsapp_authorized_phone_sync_superseded' };
      const result = await refresh({ asset: target.asset, clinicId });
      return { asset_id: assetId, state: result.health?.state || 'unknown',
        can_send: result.health?.can_send ?? null };
    } catch (error) {
      // An explicit custody/scope denial is not a transient provider outage and
      // says nothing about Meta's current phone status. Keep its last snapshot.
      if (DENIED.has(error?.code)) return { skipped: true, reason: error.code, asset_id: assetId };
      throw error;
    }
  }

  return Object.freeze({ enqueue, run });
}

module.exports = { createService, ...createService() };
