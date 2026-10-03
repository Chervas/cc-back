'use strict';
const { createHash } = require('node:crypto');
const health = require('./whatsappInboxHealth');
const templateSyncState = require('./whatsappTemplateSyncState');

async function templateAlerts({ rows, query, bindings, resolveTemplateBinding, namespace, now }) {
  const wabaIds = rows.map(row => String(row.waba_id || '')).filter(Boolean);
  const states = await templateSyncState.recentJobs({ query, wabaIds, namespace, now });
  const alerts = [];
  const [labels] = wabaIds.length ? await query(`SELECT DISTINCT a.wabaId,w.nombre_clinica
    FROM ClinicMetaAssets a LEFT JOIN Clinicas w ON w.id_clinica=a.clinicaId
    WHERE a.wabaId IN (:wabaIds) AND a.assetType='whatsapp_phone_number'`,
  { replacements: { wabaIds } }) : [[]];
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
    const blocked = denied || available && !!templateSyncState.blockedCode(states.get(wabaId)?.error_message);
    const inactive = !available && !denied;
    const names = [...new Set(labels.filter(label => String(label.wabaId) === wabaId).map(label => label.nombre_clinica).filter(Boolean))];
    const name = names.slice(0, 3).join(', ') || 'cuenta de WhatsApp';
    const cause = inactive ? 'Esta cuenta concreta no tiene un permiso operativo de consulta en Clinicaclick.'
      : blocked ? 'El control de acceso del broker deniega la consulta de esta cuenta; no demuestra un bloqueo nuevo de Meta.'
        : 'La consulta del estado actual de las plantillas sigue pendiente.';
    const summary = `${pending} avisos técnicos de aprobación, categoría o calidad de plantillas; no son respuestas de pacientes.`;
    alerts.push({ eventKey: 'whatsapp.template_reconciliation_delayed', payload: {
      severity: inactive ? 'info' : 'warning',
      title: `Plantillas de ${name}: ${inactive ? 'avisos conservados' : blocked ? 'revisar permiso de consulta' : 'sincronización retrasada'}`,
      detail: `${summary} ${cause} No son ${pending} plantillas pendientes de aprobación.`,
      action: inactive ? 'No necesitas reconectar el número por este aviso. El historial se conserva sin acciones sobre pacientes.'
        : 'El equipo técnico debe revisar esta cuenta en Ajustes > Cuentas conectadas. https://crm.clinicaclick.com/ajustes?panel=connected-accounts',
      occurredAt: Number.isFinite(new Date(row.oldest_pending).getTime()) ? new Date(row.oldest_pending).toISOString() : null,
    }, metadata: { source: 'whatsapp_template_reconciliation', waba_id: wabaId,
      incident_scope: `waba:${wabaId || 'unknown'}`, incident_impact: [inactive ? 'inactive' : blocked ? 'blocked' : 'sync_delayed'],
      panel_only: inactive, pending, active: available && !blocked ? pending : 0,
      blocked: blocked ? pending : 0, disconnected: inactive ? pending : 0, operational_summary: summary } });
  }
  return alerts;
}

function reviewBrief(clinic) {
  const count = Number(clinic?.blockingReview) || 0;
  if (!count) return '';
  const items = health.summaryOf({ blockingReview: count, reviewSummary: clinic?.reviewSummary });
  if (!items) return `${count} eventos retenidos cuyo tipo aún no está clasificado.`;
  const names = { incoming_messages: ['mensaje entrante', 'mensajes entrantes'], delivery_updates: ['actualización de entrega', 'actualizaciones de entrega'],
    provider_errors: ['error técnico de Meta', 'errores técnicos de Meta'], mobile_echoes: ['eco de un mensaje enviado desde el móvil', 'ecos de mensajes enviados desde el móvil'],
    app_state_changes: ['cambio de estado de la app', 'cambios de estado de la app'], history: ['evento de historial', 'eventos de historial'],
    mixed: ['lote mixto', 'lotes mixtos'], unknown: ['evento sin clasificar', 'eventos sin clasificar'] };
  const counts = new Map();
  for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + item.count);
  return `Resumen: ${[...counts].map(([category, total]) => `${total} ${names[category][total === 1 ? 0 : 1]}`).join('; ')}.`;
}
function groupSharedReviews(alerts) {
  const groups = new Map(), result = [];
  for (const alert of alerts) {
    const keys = alert.metadata.review_scope_keys;
    if (alert.metadata.engine_pending || !alert.metadata.blocking_review || !Array.isArray(keys) || !keys.length
      || keys.length > 16 || keys.some(key => !/^[a-f0-9]{64}$/.test(key))) { result.push(alert); continue; }
    const scope = createHash('sha256').update(JSON.stringify([...keys].sort())).digest('hex');
    const key = JSON.stringify([scope, alert.payload.severity, alert.metadata.blocking_review,
      alert.metadata.incident_impact, alert.metadata.operational_summary]);
    const group = groups.get(key) || []; group.push(alert); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const first = group[0], clinicIds = group.flatMap(alert => alert.metadata.clinic_ids);
    const scope = createHash('sha256').update(JSON.stringify([[...first.metadata.review_scope_keys].sort(), [...clinicIds].sort((a,b)=>a-b)])).digest('hex');
    const names = group.map(alert => alert.metadata.clinic_name);
    const label = names.slice(0, 2).join(', ') + (names.length > 2 ? ` y ${names.length - 2} clínicas` : '');
    result.push({ ...first, payload: { ...first.payload,
      title: `${label}: ${first.metadata.blocking_review} ${first.metadata.blocking_review === 1 ? 'evento retenido' : 'eventos retenidos'}`,
      detail: `${first.payload.detail} Es el mismo evento compartido entre ${names.join(', ')}; no se suman sus copias por clínica.` },
    metadata: { ...first.metadata, incident_scope: `review:${scope}`, clinic_ids: clinicIds,
      supersedes_scopes: group.map(alert => alert.metadata.incident_scope) } });
  }
  return result;
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
    FROM WhatsappInboxAdminSync WHERE reconciled_at IS NULL AND archived_at IS NULL AND created_at < :cutoff GROUP BY waba_id`,
  { replacements: { cutoff: new Date(now - 10 * 60 * 1000) } }) : [[]];
  const adminAlerts = await templateAlerts({ rows: adminRows, query, bindings, resolveTemplateBinding, namespace, now });
  if (!clinicIds.length) return [...[capacity, archive].filter(Boolean), ...adminAlerts];
  const issues = health.issues(snapshot, clinicIds, now);
  const [waiting] = await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ clinic_id,COUNT(*) pending FROM FlowExecutionsV2
    WHERE status='waiting' AND clinic_id IN (:clinicIds) AND last_error='inbound_response_dispatch_pending'
    AND wait_until < :until GROUP BY clinic_id`, { replacements: { clinicIds, until: new Date(now + 120000) } });
  const base = [...[capacity, archive].filter(Boolean), ...adminAlerts];
  if (!issues.length && !waiting.length) return base;
  const affected = [...new Set([...issues.map(x => x.data.clinic_id), ...waiting.map(x => x.clinic_id)])];
  const [clinics] = await query('SELECT id_clinica,nombre_clinica FROM Clinicas WHERE id_clinica IN (:clinicIds)',
    { replacements: { clinicIds: affected } });
  const names = affected.map(id => clinics.find(c => Number(c.id_clinica) === Number(id))?.nombre_clinica || `Clínica ${id}`);
  const stale = !snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.observedAt)
    || now - snapshot.observedAt > 90000 || snapshot.observedAt > now + 5000;
  const checkedAt = stale && Number.isFinite(snapshot?.observedAt) && snapshot.observedAt <= now
    ? new Date(snapshot.observedAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })
    : null;
  if (stale) return [...base, { eventKey: 'whatsapp.reception_attention', payload: {
    severity: 'critical', title: 'No se actualiza el control de recepción de WhatsApp',
    detail: `El control de recepción no se actualiza desde ${checkedAt || 'hace más de 90 segundos'}. No se puede determinar si hay mensajes pendientes; no demuestra una caída de Meta.`,
    action: 'El equipo técnico debe revisar el monitor de recepción. https://crm.clinicaclick.com/ajustes?panel=jobs-monitoring&tab=whatsapp',
  }, metadata: { source: 'whatsapp_reception', incident_scope: 'monitor:whatsapp', incident_impact: ['health_unavailable'],
    clinic_ids: affected, check_unavailable: true, operational_summary: 'Falla la comprobación de recepción; cantidad de mensajes pendientes desconocida.' } }];
  return [...base, ...groupSharedReviews(affected.map((clinicId, index) => {
    const clinic = snapshot.clinics.find(clinic => clinic.clinicId === Number(clinicId));
    const issue = issues.find(issue => issue.data.clinic_id === clinicId);
    const enginePending = waiting.filter(row => Number(row.clinic_id) === Number(clinicId))
      .reduce((total, row) => total + Number(row.pending || 1), 0);
    const retained = Number(clinic?.blockingReview) || 0;
    const reviewDates = (health.summaryOf({ blockingReview: retained, reviewSummary: clinic?.reviewSummary }) || [])
      .map(item => item.oldestAt).filter(Number.isFinite);
    const oldest = Number.isFinite(clinic?.oldestPendingAt) ? clinic.oldestPendingAt
      : reviewDates.length ? Math.min(...reviewDates) : null;
    const brief = !clinic ? 'No hay una señal de recepción válida para esta clínica; cantidad de eventos pendientes desconocida.'
      : reviewBrief(clinic) || (Number.isFinite(oldest) ? 'Hay eventos nuevos pendientes de importación.'
      : `${enginePending} respuestas guardadas pendientes del motor.`);
    const age = Number.isFinite(oldest) ? ` El evento pendiente más antiguo es del ${new Date(oldest).toLocaleString('es-ES',
      { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })}.` : '';
    const impact = issue?.severity === 'critical' ? 'Las automatizaciones afectadas se mantienen en espera hasta verificar la recepción.'
      : issue ? 'La revisión se limita a contactos concretos; las demás conversaciones mantienen sus automatizaciones.'
        : 'La importación está operativa, pero estas respuestas todavía no han llegado al motor.';
    const waits = enginePending ? ` ${enginePending} respuestas guardadas esperan al motor.`
      : clinic ? ' No hay respuestas guardadas pendientes del motor.' : '';
    const issueTypes = [issue?.type, enginePending ? 'engine_pending' : null].filter(Boolean);
    return { eventKey: 'whatsapp.reception_attention', payload: {
      severity: issue?.severity || 'warning',
      title: `${names[index]}: ${retained ? `${retained} ${retained === 1 ? 'evento retenido' : 'eventos retenidos'}` : enginePending ? `${enginePending} respuestas pendientes` : 'recepción pendiente de revisión'}`,
      detail: `${brief}${age}${waits} ${impact}`,
      action: 'El equipo técnico debe revisar estos eventos; recepción no debe confirmar ni cancelar citas por este aviso. https://crm.clinicaclick.com/ajustes?panel=jobs-monitoring&tab=whatsapp',
      occurredAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    }, metadata: { source: 'whatsapp_reception', incident_scope: `clinic:${clinicId}`, clinic_ids: [clinicId],
      clinic_name: names[index], review_scope_keys: clinic?.blockingReviewScopeKeys,
      engine_pending: enginePending, blocking_review: retained, incident_impact: [...issueTypes,
        ...[...new Set((health.summaryOf({ blockingReview: retained, reviewSummary: clinic?.reviewSummary }) || [])
          .map(item => item.category))]],
      issue_types: issueTypes, operational_summary: brief } };
  }))];
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
    incident_scope: 'monitor:whatsapp', incident_impact: ['check_failed'],
    check_error_code: knownCodes.has(code) ? code : 'CHECK_FAILED' } };
}
module.exports = { collect, unavailable, reviewBrief, groupSharedReviews };
