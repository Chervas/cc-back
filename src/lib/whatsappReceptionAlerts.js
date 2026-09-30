'use strict';
const health = require('./whatsappInboxHealth');

function capacityAlert(snapshot, now) {
  if (!snapshot || !Number.isFinite(snapshot.observedAt) || now - snapshot.observedAt > 90000
    || snapshot.observedAt > now + 5000) return null;
  const c = snapshot.capacity;
  if (!c || !['rows', 'bytes', 'maxRows', 'maxBytes', 'auditPending', 'maxAuditBacklog']
    .every(key => Number.isSafeInteger(c[key]) && c[key] >= 0)
    || !c.maxRows || !c.maxBytes || !c.maxAuditBacklog) return null;
  const utilization = Math.max(c.rows / c.maxRows, c.bytes / c.maxBytes, c.auditPending / c.maxAuditBacklog);
  if (utilization < 0.75) return null;
  const percent = Math.min(100, Math.ceil(utilization * 100));
  const critical = utilization >= 0.9;
  return { eventKey: critical ? 'whatsapp.inbox_capacity_critical' : 'whatsapp.inbox_capacity_warning', payload: {
    severity: critical ? 'critical' : 'warning',
    title: 'Capacidad de recepción de WhatsApp próxima al límite',
    detail: `El inbox cifrado está al ${percent}% de al menos uno de sus límites: ${c.rows}/${c.maxRows} recibos, ${c.bytes}/${c.maxBytes} bytes y ${c.auditPending}/${c.maxAuditBacklog} auditorías pendientes. Al agotarse un límite, el webhook dejará de confirmar eventos para que Meta reintente.`,
    action: 'Revisar capacidad y archivado controlado del inbox AWS. No borrar recibos ni forzar confirmaciones.',
  }, metadata: { source: 'whatsapp_inbox_capacity', utilization_percent: percent } };
}

// Runs inside the existing five-minute system check. No Meta API request,
// message body or patient identity is needed to notify an administrator.
async function collect({ snapshot, bindings, query, now = Date.now() }) {
  const clinicIds = [...new Set(bindings.filter(b => b.sendEnabled).map(b => b.clinicId))];
  const capacity = capacityAlert(snapshot, now);
  if (!clinicIds.length) return capacity ? [capacity] : [];
  const issues = health.issues(snapshot, clinicIds, now);
  const [waiting] = await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ id,clinic_id FROM FlowExecutionsV2
    WHERE status='waiting' AND clinic_id IN (:clinicIds) AND last_error='inbound_response_dispatch_pending'
    AND wait_until < :until ORDER BY id LIMIT 50`, { replacements: { clinicIds, until: new Date(now + 120000) } });
  if (!issues.length && !waiting.length) return capacity ? [capacity] : [];
  const affected = [...new Set([...issues.map(x => x.data.clinic_id), ...waiting.map(x => x.clinic_id)])];
  const [clinics] = await query('SELECT id_clinica,nombre_clinica FROM Clinicas WHERE id_clinica IN (:clinicIds)',
    { replacements: { clinicIds: affected } });
  const names = affected.map(id => clinics.find(c => Number(c.id_clinica) === Number(id))?.nombre_clinica || `Clínica ${id}`);
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` y ${names.length - 4} más` : '');
  const stale = !snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.observedAt)
    || now - snapshot.observedAt > 90000 || snapshot.observedAt > now + 5000;
  const checkedAt = stale && Number.isFinite(snapshot?.observedAt) && snapshot.observedAt <= now
    ? new Date(snapshot.observedAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })
    : null;
  const summary = stale
    ? `El control de recepción no se actualiza desde ${checkedAt || 'hace más de 90 segundos'}. Afecta a ${affected.length} clínicas: ${shown}.`
    : issues.length ? `${issues.length} clínicas tienen eventos de WhatsApp pendientes de importar o revisar: ${shown}.`
      : `${waiting.length} respuestas recibidas siguen pendientes del motor en: ${shown}.`;
  const oldest = (Array.isArray(snapshot?.clinics) ? snapshot.clinics : [])
    .filter(clinic => affected.includes(clinic.clinicId))
    .map(clinic => clinic.oldestPendingAt).filter(Number.isFinite).reduce((min, time) => Math.min(min, time), Infinity);
  const oldestDetail = Number.isFinite(oldest)
    ? ` El evento pendiente más antiguo es del ${new Date(oldest).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })}.`
    : '';
  const waits = waiting.length ? ` ${waiting.length}${waiting.length === 50 ? ' o más' : ''} respuestas ya registradas esperan al motor.`
    : ' No hay respuestas ya registradas pendientes del motor.';
  return [...(capacity ? [capacity] : []), { eventKey: 'whatsapp.reception_attention', payload: {
    severity: issues.some(x => x.severity === 'critical') ? 'critical' : 'warning',
    title: stale ? 'No se actualiza el control de recepción de WhatsApp' : 'WhatsApp tiene eventos pendientes de recepción',
    detail: `${summary}${oldestDetail}${waits} Las acciones por falta de respuesta permanecen en espera hasta comprobar la recepción.`,
    action: 'Revisar Ajustes → Monitorización → WhatsApp. https://crm.clinicaclick.com/ajustes?panel=jobs-monitoring&tab=whatsapp',
  }, metadata: { source: 'whatsapp_reception', clinic_ids: affected,
    waiting_execution_ids: waiting.map(x => x.id), issue_types: [...new Set(issues.map(x => x.type))] } }];
}
function unavailable(error) {
  const knownCodes = new Set(['ER_PARSE_ERROR', 'ER_QUERY_TIMEOUT', 'ER_QUERY_INTERRUPTED',
    'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ER_ACCESS_DENIED_ERROR',
    'ER_TABLEACCESS_DENIED_ERROR', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'PROTOCOL_CONNECTION_LOST']);
  const code = error?.original?.code || error?.parent?.code || error?.code;
  return { eventKey: 'whatsapp.reception_attention', payload: {
    severity: 'critical', title: 'No se puede comprobar la recepción de WhatsApp',
    detail: 'La comprobación de recepción o respuestas pendientes no está disponible.',
    action: 'Revisar Ajustes → Monitorización → WhatsApp.',
  }, metadata: { source: 'whatsapp_reception', check_unavailable: true,
    check_error_code: knownCodes.has(code) ? code : 'CHECK_FAILED' } };
}
module.exports = { collect, unavailable };
