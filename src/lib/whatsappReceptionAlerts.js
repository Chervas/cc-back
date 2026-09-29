'use strict';
const health = require('./whatsappInboxHealth');

// Runs inside the existing five-minute system check. No Meta API request,
// message body or patient identity is needed to notify an administrator.
async function collect({ snapshot, bindings, query, now = Date.now() }) {
  const clinicIds = [...new Set(bindings.filter(b => b.sendEnabled).map(b => b.clinicId))];
  if (!clinicIds.length) return [];
  const issues = health.issues(snapshot, clinicIds, now);
  const [waiting] = await query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ id,clinic_id FROM FlowExecutionsV2
    WHERE status='waiting' AND clinic_id IN (:clinicIds) AND last_error='inbound_response_dispatch_pending'
    AND wait_until < :until ORDER BY id LIMIT 50`, { replacements: { clinicIds, until: new Date(now + 120000) } });
  if (!issues.length && !waiting.length) return [];
  const affected = [...new Set([...issues.map(x => x.data.clinic_id), ...waiting.map(x => x.clinic_id)])];
  const [clinics] = await query('SELECT id_clinica,nombre_clinica FROM Clinicas WHERE id_clinica IN (:clinicIds)',
    { replacements: { clinicIds: affected } });
  const names = affected.map(id => clinics.find(c => Number(c.id_clinica) === Number(id))?.nombre_clinica || `Clínica ${id}`);
  return [{ eventKey: 'whatsapp.reception_attention', payload: {
    severity: issues.some(x => x.severity === 'critical') ? 'critical' : 'warning',
    title: 'WhatsApp requiere revisión de recepción',
    detail: `${names.join(', ')}. ${issues.length} incidencias de recepción; ${waiting.length}${waiting.length === 50 ? ' o más' : ''} esperas con respuesta recibida pendiente de procesar. No se debe interpretar esa espera como silencio del paciente.`,
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
