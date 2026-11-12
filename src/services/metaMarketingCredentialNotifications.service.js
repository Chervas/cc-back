'use strict';

const policy = require('../lib/metaMarketingCredentialAlerts');
const { createIncidentNotifier } = require('../lib/operationalNotificationIncidents');
// The normal Business source verifier checks the complete enrollment receipt.
// These are enrollment/authority metadata, never provider credentials; do not
// replace this with a MetaConnection/token-column read or a partial proof.
const ENROLLMENT_FIELDS = Object.freeze(['enrollment_id', 'flow_id', 'session_ref', 'prepare_request_id', 'activate_request_id', 'revoke_request_id',
  'scope_key', 'connection_ref', 'scope_digest', 'flow_digest', 'candidate_digest', 'meta_user_id', 'app_id', 'assignment_digest',
  'clinic_ids', 'assets', 'mapping_ids', 'meta_connection_id', 'actor_user_id', 'session_expires_at', 'requested_at', 'updated_at', 'next_attempt_at',
  'prepared_at', 'activated_at', 'revoked_at', 'lease_until', 'prepare_sent_at', 'activate_sent_at', 'selection_digest', 'lease_token', 'last_error', 'attempts', 'state']);
const fail = code => { throw Object.assign(Error(code), { code }); };
function enabled(env = process.env, namespace) {
  return namespace === 'staging' && env.RUNTIME_ROLE !== 'gateway'
    && env.META_MARKETING_BROKER_ENABLED === 'true'
    && (env.META_MARKETING_CREDENTIAL_RENEWAL_ENABLED === 'true' || env.META_MARKETING_BUSINESS_ENABLED === 'true'
      || env.META_MARKETING_BUSINESS_MAINTENANCE_ENABLED === 'true');
}
function createCredentialNotifications({ models, queue, channels, namespace, now = () => Date.now(),
  enabled: isEnabled = () => enabled(process.env, namespace), credentialStatus, maintenanceStatus, confirmedHandover, ordering: providedOrder } = {}) {
  async function run() {
    // In particular, do not query an optional new table before its reviewed
    // migration/feature activation. DEV and Gateway never collect this cohort.
    if (!isEnabled()) return { status: 'completed', skipped: true, reason: 'meta_credential_notifications_disabled', alerts: 0, queued: [] };
    if (!models?.sequelize || typeof queue !== 'function' || typeof channels !== 'function') fail('meta_credential_notifications_configuration_invalid');
    const effective = credentialStatus || require('./metaMarketingEffectiveCredential.service').createEffectiveCredentials({
      models, now: () => new Date(now()),
    }).getCredentialStatus;
    const upkeep = maintenanceStatus || require('./metaMarketingCredentialMaintenance.service').createMaintenance({
      models, now: () => new Date(now()),
    }).getMaintenanceStatus;
    const source = confirmedHandover ? null : require('./metaMarketingBusinessSource.service').createSource({ models, now: () => new Date(now()) });
    const handover = confirmedHandover || source.getConfirmedHandover;
    const order = providedOrder || require('./metaMarketingTransactionOrder.service').createOrder({ models,
      unavailable: () => fail('meta_credential_notification_current_changed') });
    async function current(id, transaction, prepared) {
      if (!prepared || prepared.enrollmentId !== id) fail('meta_credential_notification_current_changed');
      await order.lockPrepared(prepared, transaction);
      const row = await models.MetaMarketingEnrollmentRequest.findByPk(id, { attributes: ENROLLMENT_FIELDS,
        raw: true, logging: false, transaction, lock: transaction.LOCK.UPDATE });
      if (!row || row.state !== 'active') return null;
      const value = await effective(row, { transaction });
      policy.status(value, now());
      const maintenance = await upkeep(row, { transaction });
      policy.maintenance(maintenance, value, now());
      return { value, maintenance };
    }
    const enrollments = await models.MetaMarketingEnrollmentRequest.findAll({ attributes: ['enrollment_id'],
      where: { state: 'active' }, order: [['enrollment_id', 'ASC']], limit: 101, raw: true, logging: false });
    if (!Array.isArray(enrollments) || enrollments.length > 100) fail('meta_credential_notification_limit');
    const statuses = new Map(), failedEnrollments = new Set(), alerts = [];
    let failed = 0;
    for (const row of enrollments) {
      try {
        const prepared = await order.prepareEnrollment(row.enrollment_id);
        if (!prepared) continue;
        const value = await models.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, transaction => current(row.enrollment_id, transaction, prepared));
        if (value) {
          const observations = policy.alertsFromStatus(value.value, now(), value.maintenance);
          statuses.set(value.value.enrollmentId, { ...value, prepared });
          alerts.push(...observations);
        }
      } catch {
        // An unavailable or invalid scope is unknown, never evidence that its
        // prior incident recovered. Other connections retain their own checks.
        failedEnrollments.add(row.enrollment_id);
        failed++;
      }
    }
    const handovers = new Map();
    const notifier = createIncidentNotifier({ sequelize: models.sequelize, Incident: models.SystemNotificationIncident,
      namespace, now, managedEvents: policy.MANAGED, once: true,
      onIncidentError: () => { failed++; },
      // Successful maintenance is audited by the maintenance owner. Close the
      // durable incident without an additional success email or panel notice.
      channels: alert => alert.payload.severity === 'info' ? [] : channels(alert).filter(channel => ['panel', 'email'].includes(channel)),
      beforeObserve: async ({ alert, closing, transaction, previous }) => {
        if (!isEnabled()) fail('meta_credential_notification_current_changed');
        const capturedHandover = closing && handovers.get(previous?.metadata?.incident_scope);
        if (capturedHandover) {
          const identity = previous.metadata.credential, latest = await handover({ enrollmentId: identity.enrollmentId, connectionId: identity.connectionId,
            epoch: identity.epoch, versionId: identity.versionId, scopeKey: identity.scopeKey }, { transaction, prepared: capturedHandover.prepared });
          if (!latest || JSON.stringify(latest.proof) !== JSON.stringify(capturedHandover.value.proof)
            || latest.currentStatus.epoch !== capturedHandover.value.currentStatus.epoch || latest.currentStatus.versionId !== capturedHandover.value.currentStatus.versionId
            || !policy.handoverResolution(previous, latest, now())) fail('meta_credential_notification_current_changed');
          return;
        }
        const identity = alert.metadata?.credential, latest = identity && await current(identity.enrollmentId, transaction, statuses.get(identity.enrollmentId)?.prepared);
        if (!latest) fail('meta_credential_notification_current_changed');
        if (closing) {
          const captured = statuses.get(latest.value.enrollmentId);
          if (!captured || captured.value.epoch !== latest.value.epoch || captured.value.versionId !== latest.value.versionId
            || !policy.resolution(previous, latest.value, now(), latest.maintenance)) fail('meta_credential_notification_current_changed');
        } else if (!policy.alertsFromStatus(latest.value, now(), latest.maintenance).some(value => value.eventKey === alert.eventKey
          && value.metadata.incident_scope === alert.metadata.incident_scope)) fail('meta_credential_notification_current_changed');
      },
      queue: async alert => {
        return queue({ ...alert, allowedChannels: ['panel', 'email'] });
      },
    });
    const queued = await notifier.sync(alerts, { resolution: async original => {
      const id = original.metadata?.credential?.enrollmentId;
      if (failedEnrollments.has(id)) return null;
      const current = statuses.get(id);
      if (current) return policy.resolution(original, current.value, now(), current.maintenance);
      const identity = original.metadata?.credential;
      if (!identity) return null;
      const previous = { enrollmentId: identity.enrollmentId, connectionId: identity.connectionId, epoch: identity.epoch, versionId: identity.versionId, scopeKey: identity.scopeKey };
      const prepared = source ? await source.prepareConfirmedHandover(previous) : null;
      if (source && !prepared) return null;
      const value = source ? await handover(previous, { prepared })
        : await models.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, transaction => handover(previous, { transaction }));
      const recovered = policy.handoverResolution(original, value, now());
      if (recovered) handovers.set(original.metadata.incident_scope, { value, prepared });
      return recovered;
    } });
    return { status: 'completed', alerts: alerts.length, checked: statuses.size, failed, incomplete: failed > 0, queued };
  }
  return { run };
}

async function runChecks(options) { return createCredentialNotifications(options).run(); }
module.exports = { ENROLLMENT_FIELDS, enabled, createCredentialNotifications, runChecks };
