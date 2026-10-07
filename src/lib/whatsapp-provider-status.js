'use strict';

const ORDER = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed'];
const mapped = value => ['sent', 'delivered', 'read', 'failed'].includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : null;
function factualSentAt(status) {
  if (mapped(status?.status) !== 'sent' || status.timestamp == null || status.timestamp === '') return null;
  if (typeof status.timestamp !== 'number' && (typeof status.timestamp !== 'string' || !/^[0-9]+$/.test(status.timestamp))) return null;
  const seconds = Number(status.timestamp), value = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return null;
  return new Date(value);
}
function mergeStatusMetadata(existing, status) {
  const metadata = existing || {}, history = Array.isArray(metadata.wa_status_history) ? [...metadata.wa_status_history] : [];
  const timestamps = metadata.wa_status_timestamps && typeof metadata.wa_status_timestamps === 'object' ? { ...metadata.wa_status_timestamps } : {};
  const entry = { status: status.status, timestamp: status.timestamp, recipient_id: status.recipient_id || null,
    conversation: status.conversation || null, pricing: status.pricing || null, errors: status.errors || null };
  history.push(entry);
  const normalized = mapped(status.status); if (normalized && status.timestamp) timestamps[normalized] = status.timestamp;
  return { ...metadata, wa_status: entry, wa_status_history: history, wa_status_timestamps: timestamps,
    wa_error: Array.isArray(status.errors) && !status.errors.length ? metadata.wa_error || null : status.errors || metadata.wa_error || null };
}
// Both SQL adapters call this with their CURRENT locked row. The passive inbox
// historically treats failed as recoverable; the legacy webhook keeps its own
// existing order. Sharing the projection does not silently change either lane.
function projectProviderStatus(message, status, { recoverFailed = false } = {}) {
  const next = mapped(status?.status); if (!next) return null;
  const clock = factualSentAt(status), current = String(message.status || '').toLowerCase();
  const rank = { pending: 0, sending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
  const regresses = recoverFailed
    ? next === 'failed' ? rank[current] >= 2 : rank[next] < rank[current]
    : ORDER.indexOf(current) !== -1 && ORDER.indexOf(next) < ORDER.indexOf(current);
  if (regresses && !(clock && !message.sent_at)) return null;
  return { status: regresses ? message.status : next,
    sent_at: message.sent_at || clock || null, metadata: mergeStatusMetadata(message.metadata, status) };
}
// Called by the real webhook status consumer. Its short SQL row lock preserves
// concurrent receipt metadata/state. A late valid sent timestamp may fill the
// clock even after delivered/read, without regressing that advanced state.
async function persistProviderStatus({ db, messageId, status }) {
  const next = mapped(status?.status); if (!next) return null;
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const message = await db.Message.findByPk(messageId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!message) return null;
    const projected = projectProviderStatus(message, status); if (!projected) return null;
    Object.assign(message, projected);
    await message.save({ transaction });
    return message;
  });
}
module.exports = { factualSentAt, mergeStatusMetadata, projectProviderStatus, persistProviderStatus };
