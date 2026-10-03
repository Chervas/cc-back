'use strict';

const { createHash } = require('node:crypto');
const MANAGED = new Set(['whatsapp.reception_attention', 'whatsapp.template_reconciliation_delayed']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const millis = value => new Date(value).getTime();

function identity(alert, namespace) {
  if (!MANAGED.has(alert.eventKey) || !/^[a-z0-9:_-]{1,128}$/i.test(alert.metadata?.incident_scope || '')) {
    throw Error('operational_incident_scope_required');
  }
  return hash([namespace, alert.eventKey, alert.metadata.incident_scope]);
}

function notificationDecision(previous, observation, phase, now, { criticalMinutes = 360, warningMinutes = 1440 } = {}) {
  const signature = hash([phase, observation.payload.severity,
    [...(observation.metadata?.incident_impact || [])].sort()]);
  if (!previous || previous.signature !== signature) return { notify: true, signature };
  if (phase === 'closed') return { notify: false, signature };
  const minutes = observation.payload.severity === 'critical' ? criticalMinutes : warningMinutes;
  return { notify: now - previous.at >= minutes * 60000, signature };
}

// State and notification jobs commit together. A restart or concurrent sweep
// cannot turn an unchanged incident into a new hourly email.
function createIncidentNotifier({ sequelize, Incident, queue, channels, namespace, now = () => Date.now(), reminderMinutes }) {
  async function observe(alert, closing = false, expectedObservedAt = null) {
    const key = identity(alert, namespace);
    // Acquire the unique incident row without overwriting an existing clock.
    // An atomic insert avoids findOrCreate's concurrent lock-upgrade race.
    return sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const time = now();
      const occurred = millis(alert.payload.occurredAt);
      const opened = Number.isFinite(occurred) && occurred >= Date.UTC(2000, 0, 1) ? Math.min(occurred, time) : time;
      await sequelize.query(`INSERT INTO SystemNotificationIncidents
        (incident_key,namespace,event_key,scope_key,state,severity,opened_at,observed_at,snapshot,channel_state)
        VALUES (:key,:namespace,:eventKey,:scope,'new',:severity,:opened,:observed,:snapshot,'{}')
        ON DUPLICATE KEY UPDATE incident_key=incident_key`, { transaction, replacements: {
        key, namespace, eventKey: alert.eventKey, scope: alert.metadata.incident_scope,
        severity: alert.payload.severity, opened: new Date(opened), observed: new Date(time), snapshot: JSON.stringify(alert),
      } });
      const row = await Incident.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
      if (closing && row.state !== 'open') return { created: [], skipped: [], incidentKey: key };
      if (closing && millis(row.observed_at) !== expectedObservedAt) return { created: [], skipped: [], incidentKey: key };
      const phase = closing ? 'closed' : 'open';
      const reopened = !closing && row.state === 'closed';
      const channelState = reopened ? {} : { ...json(row.channel_state) };
      const selected = channels(alert).filter(channel => notificationDecision(channelState[channel], alert,
        phase, time, reminderMinutes).notify);
      const deliveryAlert = { ...alert, payload: { ...alert.payload,
        occurredAt: new Date(closing ? time : reopened ? opened : millis(row.opened_at)).toISOString() },
      metadata: { ...alert.metadata, incident_key: key, incident_phase: phase,
        incident_opened_at: new Date(reopened ? opened : millis(row.opened_at)).toISOString() } };
      const queued = selected.length ? await queue({ ...deliveryAlert, transaction, force: true,
        channelsOverride: Object.fromEntries(['panel', 'email', 'whatsapp'].map(channel => [channel, selected.includes(channel)])) })
        : { created: [], skipped: [] };
      for (const created of queued.created) channelState[created.channel] = {
        signature: notificationDecision(channelState[created.channel], alert, phase, time, reminderMinutes).signature, at: time,
      };
      await row.update({ state: phase, severity: alert.payload.severity, observed_at: new Date(time),
        opened_at: reopened ? new Date(opened) : row.opened_at, closed_at: closing ? new Date(time) : null,
        snapshot: alert, channel_state: channelState }, { transaction });
      return { ...queued, incidentKey: key };
    });
  }

  async function sync(alerts, { resolution } = {}) {
    const result = [];
    const seen = new Set();
    for (const alert of alerts.filter(alert => MANAGED.has(alert.eventKey))) {
      seen.add(identity(alert, namespace)); result.push(await observe(alert));
    }
    if (!resolution) return result;
    const open = await Incident.findAll({ where: { namespace, state: 'open' } });
    for (const row of open) {
      if (seen.has(row.incident_key)) continue;
      const original = json(row.snapshot);
      const recovered = await resolution(original);
      if (!recovered) continue;
      result.push(await observe({ ...original, payload: recovered,
        metadata: { ...original.metadata, incident_impact: ['recovered'], operational_summary: recovered.detail } },
      true, millis(row.observed_at)));
    }
    return result;
  }
  return { sync };
}

module.exports = { createIncidentNotifier, identity, notificationDecision, MANAGED };
