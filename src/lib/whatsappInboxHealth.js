'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const contactKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const FILE = '/run/clinicaclick-whatsapp-inbox-health/health.json';
const REVIEW_CATEGORIES = new Set(['incoming_messages', 'delivery_updates', 'provider_errors',
  'mobile_echoes', 'app_state_changes', 'history', 'mixed', 'unknown']);
function summaryOf(group) {
  const items = group.reviewSummary;
  if (!Array.isArray(items) || items.length > 9 || items.some(item => !REVIEW_CATEGORIES.has(item.category)
    || !Number.isSafeInteger(item.count) || item.count < 1
    || ['oldestAt', 'newestAt'].some(key => item[key] !== null && !Number.isSafeInteger(item[key]))
    || !Array.isArray(item.errorCodes) || item.errorCodes.length > 10
    || item.errorCodes.some(code => !Number.isSafeInteger(code) || code < 1 || code > 9999999))
    || items.reduce((total, item) => total + item.count, 0) !== group.blockingReview) return null;
  return items.map(item => Object.fromEntries(['category', 'count', 'oldestAt', 'newestAt', 'errorCodes'].map(key => [key, item[key]])));
}
function mergeSummaries(items) {
  const merged = new Map();
  for (const item of items) {
    const previous = merged.get(item.category);
    merged.set(item.category, previous ? { category: item.category, count: previous.count + item.count,
      oldestAt: previous.oldestAt === null || item.oldestAt === null ? null : Math.min(previous.oldestAt, item.oldestAt),
      newestAt: previous.newestAt === null || item.newestAt === null ? null : Math.max(previous.newestAt, item.newestAt),
      errorCodes: [...new Set([...previous.errorCodes, ...item.errorCodes])].sort((a, b) => a - b).slice(0, 10) } : item);
  }
  return [...merged.values()];
}
function capacityOf(health) {
  if (health.capacity === undefined) return null; // Older broker during a rolling deployment.
  const value = health.capacity;
  if (!value || !['rows', 'bytes', 'maxRows', 'maxBytes', 'auditPending', 'maxAuditBacklog']
    .every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || !value.maxRows || !value.maxBytes || !value.maxAuditBacklog) throw Error('inbox_health_capacity_invalid');
  return Object.fromEntries(['rows', 'bytes', 'maxRows', 'maxBytes', 'auditPending', 'maxAuditBacklog']
    .map(key => [key, value[key]]));
}
function archiveOf(health) {
  if (health.archive === undefined) return null;
  const value = health.archive;
  if (!value || !Number.isSafeInteger(value.pending) || value.pending < 0
    || !Number.isSafeInteger(value.untaggedImported) || value.untaggedImported < 0
    || (value.oldestAt !== null && !Number.isSafeInteger(value.oldestAt))
    || (value.oldestUntaggedAt !== null && !Number.isSafeInteger(value.oldestUntaggedAt))
    || (value.failedArchive !== undefined && (!Number.isSafeInteger(value.failedArchive) || value.failedArchive < 0))
    || (value.failedTag !== undefined && (!Number.isSafeInteger(value.failedTag) || value.failedTag < 0))
    || (value.lastArchivedAt !== undefined && value.lastArchivedAt !== null && !Number.isSafeInteger(value.lastArchivedAt))
    || (value.lastTaggedAt !== undefined && value.lastTaggedAt !== null && !Number.isSafeInteger(value.lastTaggedAt))) throw Error('inbox_health_archive_invalid');
  return { pending: value.pending, oldestAt: value.oldestAt,
    untaggedImported: value.untaggedImported, oldestUntaggedAt: value.oldestUntaggedAt,
    failedArchive: value.failedArchive ?? 0, failedTag: value.failedTag ?? 0,
    lastArchivedAt: value.lastArchivedAt ?? null, lastTaggedAt: value.lastTaggedAt ?? null };
}
function read() {
  try {
    const stat = fs.lstatSync(FILE);
    if (!stat.isFile() || stat.mode & 0o022 || stat.size > 131072) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return null; }
}
function state(snapshot, clinicId, now = Date.now(), { contactKeys = null } = {}) {
  if (!snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.observedAt)
    || now - snapshot.observedAt > 90000 || snapshot.observedAt > now + 5000
    || !Array.isArray(snapshot.clinics)) return { healthy: false, reason: 'inbox_health_unavailable' };
  const clinic = snapshot.clinics.find(c => c.clinicId === Number(clinicId));
  if (!clinic) return { healthy: false, reason: 'inbox_health_scope_missing' };
  let blockingReview = clinic.blockingReview;
  if (Array.isArray(contactKeys) && contactKeys.every(contactKey)
    && Number.isSafeInteger(clinic.unscopedBlockingReview) && clinic.unscopedBlockingReview >= 0
    && clinic.unscopedBlockingReview <= clinic.blockingReview
    && Array.isArray(clinic.blockingContactKeys) && clinic.blockingContactKeys.length <= 128
    && clinic.blockingContactKeys.every(contactKey)) {
    blockingReview = clinic.unscopedBlockingReview
      + Number(clinic.blockingContactKeys.some(key => contactKeys.includes(key)));
  }
  const readyForReplies = !snapshot.recoveryHold && blockingReview === 0;
  const healthy = readyForReplies
    && (clinic.oldestPendingAt === null || now - clinic.oldestPendingAt <= 120000);
  return { healthy, readyForReplies, readyForTimeout: healthy && clinic.oldestPendingAt === null,
    reason: healthy ? null : 'inbox_reception_delayed', recoveryNotBefore: snapshot.recoveryNotBefore || null };
}
function publish(health, scopes, { recoveryNotBefore = null, recoveryHold = false } = {}) {
  if (!health || !Number.isFinite(health.observedAt) || !Array.isArray(health.groups)) throw Error('inbox_health_invalid');
  const clinics = new Map();
  for (const scope of scopes) for (const clinicId of scope.clinicIds) {
    const value = clinics.get(clinicId) || { clinicId, oldestPendingAt: null, blockingReview: 0, review: 0,
      unscopedBlockingReview: 0, blockingContactKeys: [], reviewSummary: [] };
    for (const group of health.groups.filter(g => g.scopes.includes(scope.wabaId + ':' + scope.phoneId))) {
      if (group.oldestPendingAt !== null) value.oldestPendingAt = Math.min(value.oldestPendingAt ?? Infinity, group.oldestPendingAt);
      value.blockingReview += Number(group.blockingReview) || 0; value.review += Number(group.review) || 0;
      const summary = summaryOf(group);
      value.reviewSummary = mergeSummaries([...value.reviewSummary, ...(summary || (group.blockingReview > 0
        ? [{ category: 'unknown', count: group.blockingReview, oldestAt: null, newestAt: null, errorCodes: [] }] : []))]);
      const isolation = group.reviewIsolation;
      const valid = isolation?.version === 1 && Number.isSafeInteger(isolation.scopedReviews)
        && isolation.scopedReviews > 0 && isolation.scopedReviews <= group.blockingReview
        && Array.isArray(isolation.contacts) && isolation.contacts.length > 0 && isolation.contacts.length <= 128
        && isolation.contacts.every(c => Number.isSafeInteger(c.clinicId) && c.clinicId > 0 && contactKey(c.contactKey));
      value.unscopedBlockingReview += (Number(group.blockingReview) || 0) - (valid ? isolation.scopedReviews : 0);
      if (valid) value.blockingContactKeys = [...new Set([...value.blockingContactKeys,
        ...isolation.contacts.filter(c => c.clinicId === clinicId).map(c => c.contactKey)])];
    }
    clinics.set(clinicId, value);
  }
  const snapshot = { version: 1, observedAt: health.observedAt, clinics: [...clinics.values()],
    capacity: capacityOf(health), archive: archiveOf(health), recoveryNotBefore, recoveryHold };
  fs.writeFileSync(FILE + '.next', JSON.stringify(snapshot), { mode: 0o644 });
  fs.chmodSync(FILE + '.next', 0o644); fs.renameSync(FILE + '.next', FILE);
  return snapshot;
}
function issues(snapshot, clinicIds, now = Date.now()) {
  return [...new Set(clinicIds)].filter(id => !state(snapshot, id, now).healthy).map(clinicId => {
    if (state(snapshot, clinicId, now, { contactKeys: [] }).healthy) return {
      severity: 'warning', type: 'whatsapp_inbox_contact_review', title: 'Contactos de WhatsApp pendientes de revisión',
      detail: 'Los eventos retenidos afectan a contactos concretos. Las demás conversaciones mantienen sus automatizaciones.',
      data: { clinic_id: clinicId, blocking_reviews: snapshot.clinics.find(c => c.clinicId === Number(clinicId)).blockingReview },
    };
    return {
    severity: 'critical', type: 'whatsapp_inbox_reception_delayed',
    title: 'Recepción de WhatsApp pendiente de recuperación',
    detail: 'Los recordatorios y cancelaciones por falta de respuesta están retenidos hasta comprobar la recepción.',
    data: { clinic_id: clinicId, reason: state(snapshot, clinicId, now).reason },
    };
  });
}
async function forConversation(snapshot, conversation, bindings, query, { transaction, now = Date.now() } = {}) {
  const clinicId = Number(conversation?.clinic_id);
  const fallback = () => state(snapshot, clinicId, now);
  const base = fallback();
  if (!Object.hasOwn(base, 'readyForReplies') || snapshot?.recoveryHold) return base;
  const clinic = snapshot?.clinics?.find(c => c.clinicId === clinicId);
  if (!clinic?.blockingReview) return fallback();
  if (!Number.isSafeInteger(Number(conversation?.id)) || Number(conversation.id) <= 0
    || conversation.channel !== 'whatsapp' || !Array.isArray(clinic.blockingContactKeys)
    || clinic.blockingContactKeys.length > 128 || !clinic.blockingContactKeys.every(contactKey)) return fallback();
  const peer = String(conversation.contact_id || '').replace(/^\+/, '');
  const ownBindings = bindings.filter(b => b.clinicId === clinicId);
  if (!/^[1-9][0-9]{6,14}$/.test(peer) || !ownBindings.length) return fallback();
  const keys = ownBindings.map(b => createHash('sha256').update(JSON.stringify([clinicId, b.phoneId, peer])).digest('hex'));
  if (clinic.blockingContactKeys.length) {
    // Protect old aliases too. This bounded lookup uses the contact-key PK.
    try {
      const [bound] = await query("SELECT /*+ MAX_EXECUTION_TIME(3000) */ k.contact_key FROM WhatsappInboxContactKeys k JOIN Conversations c ON c.id=k.conversation_id WHERE k.contact_key IN (:reviewKeys) AND c.id=:conversationId AND c.clinic_id=:clinicId AND c.channel='whatsapp'", {
        replacements: { reviewKeys: clinic.blockingContactKeys, conversationId: Number(conversation.id), clinicId }, transaction,
      });
      keys.push(...bound.map(row => row.contact_key));
    } catch { return fallback(); }
  }
  return state(snapshot, clinicId, now, { contactKeys: keys });
}
module.exports = { FILE, read, state, publish, issues, forConversation, summaryOf };
