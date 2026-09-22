'use strict';
const fs = require('node:fs');
const FILE = '/run/clinicaclick-whatsapp-inbox-health/health.json';
function read() {
  try {
    const stat = fs.lstatSync(FILE);
    if (!stat.isFile() || stat.mode & 0o022 || stat.size > 131072) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return null; }
}
function state(snapshot, clinicId, now = Date.now()) {
  if (!snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.observedAt)
    || now - snapshot.observedAt > 90000 || snapshot.observedAt > now + 5000
    || !Array.isArray(snapshot.clinics)) return { healthy: false, reason: 'inbox_health_unavailable' };
  const clinic = snapshot.clinics.find(c => c.clinicId === Number(clinicId));
  if (!clinic) return { healthy: false, reason: 'inbox_health_scope_missing' };
  const healthy = !snapshot.recoveryHold && clinic.blockingReview === 0
    && (clinic.oldestPendingAt === null || now - clinic.oldestPendingAt <= 120000);
  return { healthy, reason: healthy ? null : 'inbox_reception_delayed', recoveryNotBefore: snapshot.recoveryNotBefore || null };
}
function publish(health, scopes, { recoveryNotBefore = null, recoveryHold = false } = {}) {
  if (!health || !Number.isFinite(health.observedAt) || !Array.isArray(health.groups)) throw Error('inbox_health_invalid');
  const clinics = new Map();
  for (const scope of scopes) for (const clinicId of scope.clinicIds) {
    const value = clinics.get(clinicId) || { clinicId, oldestPendingAt: null, blockingReview: 0, review: 0 };
    for (const group of health.groups.filter(g => g.scopes.includes(scope.wabaId + ':' + scope.phoneId))) {
      if (group.oldestPendingAt !== null) value.oldestPendingAt = Math.min(value.oldestPendingAt ?? Infinity, group.oldestPendingAt);
      value.blockingReview += Number(group.blockingReview) || 0; value.review += Number(group.review) || 0;
    }
    clinics.set(clinicId, value);
  }
  const snapshot = { version: 1, observedAt: health.observedAt, clinics: [...clinics.values()], recoveryNotBefore, recoveryHold };
  fs.writeFileSync(FILE + '.next', JSON.stringify(snapshot), { mode: 0o644 });
  fs.chmodSync(FILE + '.next', 0o644); fs.renameSync(FILE + '.next', FILE);
  return snapshot;
}
function issues(snapshot, clinicIds, now = Date.now()) {
  return [...new Set(clinicIds)].filter(id => !state(snapshot, id, now).healthy).map(clinicId => ({
    severity: 'critical', type: 'whatsapp_inbox_reception_delayed',
    title: 'Recepción de WhatsApp pendiente de recuperación',
    detail: 'Los recordatorios y cancelaciones por falta de respuesta están retenidos hasta comprobar la recepción.',
    data: { clinic_id: clinicId, reason: state(snapshot, clinicId, now).reason },
  }));
}
module.exports = { FILE, read, state, publish, issues };
