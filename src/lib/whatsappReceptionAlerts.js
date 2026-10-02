'use strict';
const health = require('./whatsappInboxHealth');
const templateSyncState = require('./whatsappTemplateSyncState');

async function templateAlert({ rows, query, bindings, resolveTemplateBinding, namespace, now }) {
  const wabaIds = rows.map(row => String(row.waba_id || '')).filter(Boolean);
  const states = await templateSyncState.recentJobs({ query, wabaIds, namespace, now });
  const totals = { pending: 0, active: 0, blocked: 0, disconnected: 0, blocked_wabas: 0, disconnected_wabas: 0 };
  let oldest = Infinity;
  for (const row of rows) {
    const pending = Number(row.pending || 0);
    if (!pending) continue;
    const wabaId = String(row.waba_id || '');
    let available = !wabaId || bindings.some(binding => binding.wabaId === wabaId && binding.sendEnabled);
    let denied = false;
    if (wabaId && resolveTemplateBinding) {
      try { available = !!await resolveTemplateBinding(wabaId); }
      catch (error) { if (!templateSyncState.blockedCode(error)) throw error; denied = true; }
    }
    totals.pending += pending;
    if (!available && !denied) { totals.disconnected += pending; totals.disconnected_wabas++; }
    else if (denied || templateSyncState.blockedCode(states.get(wabaId)?.error_message)) {
      totals.blocked += pending; totals.blocked_wabas++;
    } else totals.active += pending;
    const date = new Date(row.oldest_pending || '').getTime();
    if (Number.isFinite(date)) oldest = Math.min(oldest, date);
  }
  // A deliberately disconnected account retains evidence, not an operational
  // approval failure. Never mark it reconciled merely to silence an alert.
  if (!totals.active && !totals.blocked) return null;
  const cause = totals.blocked
    ? ` La última consulta de ${totals.blocked} avisos en ${totals.blocked_wabas} cuentas fue bloqueada por el control de acceso del broker; esto no demuestra un nuevo bloqueo de Meta.` : '';
  const inactive = totals.disconnected
    ? ` Otros ${totals.disconnected} avisos pertenecen a ${totals.disconnected_wabas} cuentas sin conexión autorizada activa y se conservan para una futura conciliación.` : '';
  const active = totals.active ? ` ${totals.active} avisos de cuentas disponibles siguen pendientes de sincronización.` : '';
  const since = Number.isFinite(oldest) ? ` Pendientes en CRM desde ${new Date(oldest).toLocaleString('es-ES',
    { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })}.` : '';
  return { eventKey: 'whatsapp.template_reconciliation_delayed', payload: {
    severity: 'warning',
    title: totals.active ? 'Sincronización de cambios de plantillas WhatsApp retrasada'
      : 'No se pueden conciliar avisos de plantillas de cuentas bloqueadas',
    detail: `Meta ya entregó ${totals.pending} avisos técnicos de cambios de plantillas, pero CRM todavía no ha contrastado su estado actual.${cause}${inactive}${active}${since} No son ${totals.pending} plantillas pendientes de aprobación ni mensajes de pacientes. Este aviso no acredita un fallo de recepción de pacientes.`,
    action: totals.blocked
      ? 'Revisar el permiso de las cuentas bloqueadas en Ajustes > Cuentas conectadas. No reconectar cuentas retiradas ni dar avisos por conciliados manualmente. https://crm.clinicaclick.com/ajustes?panel=connected-accounts'
      : 'Revisar la sincronización de plantillas en Monitorización > WhatsApp. No dar avisos por conciliados manualmente. https://crm.clinicaclick.com/ajustes?panel=jobs-monitoring&tab=whatsapp',
  }, metadata: { source: 'whatsapp_template_reconciliation', ...totals } };
}

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
function archiveAlert(snapshot, now) {
  if (!snapshot || !Number.isFinite(snapshot.observedAt) || now - snapshot.observedAt > 90000
    || snapshot.observedAt > now + 5000) return null;
  const archive = snapshot.archive;
  if (!archive) return null;
  const archiveStalled = !Number.isSafeInteger(archive.lastArchivedAt)
    || now - archive.lastArchivedAt >= 120000;
  const taggingStalled = !Number.isSafeInteger(archive.lastTaggedAt)
    || now - archive.lastTaggedAt >= 120000;
  const pending = Number.isSafeInteger(archive.pending) && archive.pending > 0
    && Number.isSafeInteger(archive.oldestAt) && now - archive.oldestAt >= 120000
    && (archive.failedArchive > 0 || archiveStalled);
  const untagged = Number.isSafeInteger(archive.untaggedImported) && archive.untaggedImported > 0
    && Number.isSafeInteger(archive.oldestUntaggedAt) && now - archive.oldestUntaggedAt >= 120000
    && (archive.failedTag > 0 || taggingStalled);
  if (!pending && !untagged) return null;
  const count = (pending ? archiveStalled ? archive.pending : archive.failedArchive : 0)
    + (untagged ? taggingStalled ? archive.untaggedImported : archive.failedTag : 0);
  return { eventKey: 'whatsapp.inbox_archive_delayed', payload: {
    severity: 'critical', title: 'La copia de seguridad de recepción de WhatsApp está retrasada',
    detail: `${count} ${count === 1 ? 'recibo requiere' : 'recibos requieren'} copia externa o marcado de importación. Si falla la copia para un evento nuevo, Meta recibirá un error reintentable.`,
    action: 'Revisar el archivo S3 y el servicio de recepción. No eliminar ni confirmar recibos manualmente.',
  }, metadata: { source: 'whatsapp_inbox_archive', pending: archive.pending,
    untagged_imported: archive.untaggedImported || 0, failed_archive: archive.failedArchive || 0,
    failed_tag: archive.failedTag || 0 } };
}

// Runs inside the existing five-minute system check. No Meta API request,
// message body or patient identity is needed to notify an administrator.
async function collect({ snapshot, bindings, query, now = Date.now(),
  accountSyncEnabled = process.env.WHATSAPP_INBOX_ADMIN_SYNC_ENABLED === 'true',
  resolveTemplateBinding, namespace = process.env.JOB_RUNTIME_NAMESPACE || process.env.RUNTIME_NAMESPACE || 'staging' }) {
  const clinicIds = [...new Set(bindings.filter(b => b.sendEnabled).map(b => b.clinicId))];
  const capacity = capacityAlert(snapshot, now);
  const archive = archiveAlert(snapshot, now);
  if (!bindings.length) return [capacity, archive].filter(Boolean);
  const [adminRows] = accountSyncEnabled ? await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ waba_id,COUNT(*) pending,MIN(created_at) oldest_pending
    FROM WhatsappInboxAdminSync WHERE reconciled_at IS NULL AND created_at < :cutoff GROUP BY waba_id`,
  { replacements: { cutoff: new Date(now - 10 * 60 * 1000) } }) : [[]];
  const adminAlert = await templateAlert({ rows: adminRows, query, bindings, resolveTemplateBinding, namespace, now });
  if (!clinicIds.length) return [capacity, archive, adminAlert].filter(Boolean);
  const issues = health.issues(snapshot, clinicIds, now);
  const [waiting] = await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ id,clinic_id FROM FlowExecutionsV2
    WHERE status='waiting' AND clinic_id IN (:clinicIds) AND last_error='inbound_response_dispatch_pending'
    AND wait_until < :until ORDER BY id LIMIT 50`, { replacements: { clinicIds, until: new Date(now + 120000) } });
  if (!issues.length && !waiting.length) return [capacity, archive, adminAlert].filter(Boolean);
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
  return [...[capacity, archive, adminAlert].filter(Boolean), { eventKey: 'whatsapp.reception_attention', payload: {
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
