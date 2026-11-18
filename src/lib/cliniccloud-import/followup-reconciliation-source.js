'use strict';

const io = require('./io');
const { hash, norm, normalizeAlerts, normalizeContacts, localDateTime } = require('./adapter');
const primary = require('./primary-clinics');
const c = require('./followup-reconciliation');
const { buildClinicDecision } = require('./followup-clinic-decision');
const overrideContract = require('./followup-clinic-override');
const dateContract = require('./followup-date-reconciliation');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const cleanBody = text => String(text || '').replace(/\r\n/g, '\n').trim();

function rawRecord(record) {
  return { local_patient_id: record.patient_id, source_contact_id: record.source_contact_id, history_number: record.history_number,
    source_external_id: record.source_reference.startsWith('alert:') ? record.source_reference.slice(6) : null,
    source_contact_due_at: record.contact_due_date, reasons: record.validation_errors, provenance: record.provenance,
    ...(record.contact_date_reconciliation ? { contact_date_reconciliation: record.contact_date_reconciliation } : {}),
    payload: { status: record.source_status, contact_due_date: record.contact_due_date, clinical_notes: record.clinical_notes,
      operational_reason: record.operational_reason } };
}

// Re-read source rows, not only their manifest hashes. This also reconstructs
// all relevant treatment evidence through the existing ClinicCloud adapters.
function createSourceProof({ sourceFiles, readCsv = io.readCsv, readAlerts = io.readAlerts }) {
  const cache = new Map(), byRole = new Map();
  for (const file of sourceFiles) {
    if (byRole.has(file.role)) fail('FOLLOWUP_SOURCE_ROLE_DUPLICATED');
    byRole.set(file.role, file);
  }
  let administrativeOverride = null;
  let administrativeScope = null;
  let contactDateReconciliation = null;
  const dateFile = byRole.get(dateContract.ROLE);
  if (dateFile) {
    const bytes = io.readBytes(dateFile.path);
    if (hash(bytes) !== dateFile.sha256) fail('FOLLOWUP_DATE_RECONCILIATION_FILE_CHANGED');
    contactDateReconciliation = dateContract.validateDocument({document:JSON.parse(bytes.toString('utf8')),file:dateFile,sourceFiles,sourceManifestHash:overrideContract.sourceManifestHash});
  }
  const scopeFile = byRole.get(overrideContract.SCOPE_ROLE);
  if (scopeFile) {
    const bytes = io.readBytes(scopeFile.path);
    if (hash(bytes) !== scopeFile.sha256) fail('FOLLOWUP_BATCH_SCOPE_FILE_CHANGED');
    administrativeScope = overrideContract.validateBatchScope({ document: JSON.parse(bytes.toString('utf8')), file: scopeFile, sourceFiles });
  }
  const overrideFile = byRole.get(overrideContract.ROLE);
  if (overrideFile) {
    const bytes = io.readBytes(overrideFile.path);
    if (hash(bytes) !== overrideFile.sha256) fail('FOLLOWUP_OVERRIDE_FILE_CHANGED');
    administrativeOverride = overrideContract.validateOverride({ document: JSON.parse(bytes.toString('utf8')), file: overrideFile, sourceFiles });
  }
  function read(role, xlsx = false) {
    if (cache.has(role)) return cache.get(role);
    const file = byRole.get(role);
    if (!file) fail('FOLLOWUP_SOURCE_ROLE_MISSING');
    const value = (xlsx ? readAlerts : readCsv)(file.path, role);
    if (value.file.sha256 !== file.sha256) fail('FOLLOWUP_SOURCE_FILE_CHANGED');
    const rows = value.rows.map(r => ({ ...r, provenance: { file_sha256: file.sha256, source_row: r.source_row, row_sha256: hash(r.values) } }));
    cache.set(role, rows); return rows;
  }
  const contacts = normalizeContacts(read('new_contacts'), byRole.get('new_contacts').sha256);
  const historicalAlerts = read('aviso_1.csv');
  const alerts = normalizeAlerts(read('alerts', true), byRole.get('alerts').sha256, contacts, historicalAlerts);
  if (byRole.has('later_alerts')) {
    for (const row of read('later_alerts')) {
      const values = row.values, related = String(values['RELACIONADO CON'] || '').trim();
      const history = /^\s*(\d+)\.\s*/.exec(related)?.[1] || null;
      const matches = contacts.filter(contact => contact.history_number === history);
      const status = { PROGRAMADA: 'pending', FINALIZADA: 'closed', ANULADA: 'cancelled' }[norm(values.ESTADO)];
      const due = localDateTime(values.FECHA, String(values.FECHA || '').trim().split(' ')[1] || '00:00');
      alerts.push({ source_contact_id: matches.length === 1 ? matches[0].source_contact_id : null, history_number: history,
        source_external_id: null, body: cleanBody(values.DETALLES), contact_due_at: due, status,
        provenance: row.provenance, validation_errors: [matches.length !== 1 && 'AMBIGUOUS_OR_MISSING_HISTORY_NUMBER', !status && 'UNKNOWN_ALERT_STATE', !due && 'INVALID_ALERT_DATE'].filter(Boolean) });
    }
  }
  const byRow = new Map(alerts.map(r => [`${r.provenance.file_sha256}:${r.provenance.source_row}`, r]));
  const appointments = [...read('cita_1.csv'), ...read('cita_2.csv')];
  const concepts = [...read('citaconcepto_1.csv'), ...read('citaconcepto_2.csv')];
  const historic = primary.historicalEvidence({ appointments, concepts, services: read('servicio_1.csv'), coverage: { start: '2026-08-01', end: '2026-12-31' } });
  const latest = primary.newEvidence(read('new_appointments'), read('tiposervicio_1.csv'));
  const evidence = [...historic.evidence, ...latest.evidence];
  if (contactDateReconciliation) {
    const d = contactDateReconciliation;
    const chosen = alerts.filter(row => row.provenance.file_sha256 === d.selected.provenance.file_sha256
      && String(row.source_contact_id) === d.source_contact_id && hash(norm(row.body)) === d.body_sha256);
    const oldId = historicalAlerts.filter(row => String(row.values.idAviso) === d.historical.source_external_id);
    const oldBody = historicalAlerts.filter(row => String(row.values.idEntidad) === d.source_contact_id && hash(norm(row.values.detalles)) === d.body_sha256);
    const old = oldId[0], selected = chosen[0];
    if (chosen.length !== 1 || oldId.length !== 1 || oldBody.length !== 1 || oldId[0] !== oldBody[0]
      || String(selected.history_number) !== d.history_number || hash(selected.provenance) !== hash(d.selected.provenance)
      || selected.contact_due_at?.slice(0,10) !== d.selected.contact_due_date || selected.status !== d.selected.status
      || hash(old.provenance) !== hash(d.historical.provenance)
      || String(old.values.estado) !== d.historical.state_raw
      || localDateTime(old.values.fecha,String(old.values.fecha).trim().split(' ')[1] || '00:00')?.slice(0,10) !== d.historical.contact_due_date) fail('FOLLOWUP_DATE_RECONCILIATION_SOURCE_NOT_UNIQUE');
  }

  function verifyRecord(record) {
    const expected = byRow.get(`${record.provenance.file_sha256}:${record.provenance.source_row}`);
    const reconciled = record.contact_date_reconciliation;
    if (reconciled && (!contactDateReconciliation || hash(reconciled) !== hash(contactDateReconciliation))) fail('FOLLOWUP_DATE_RECONCILIATION_RECORD_CHANGED');
    if (reconciled) dateContract.assertRecord(reconciled,record,sourceFiles);
    const expectedErrors = (expected?.validation_errors || []).filter(reason => !(reconciled && reason === 'POSSIBLE_CHANGED_ALERT_DATE'));
    if (!expected || expected.provenance.row_sha256 !== record.provenance.row_sha256
      || String(expected.source_contact_id) !== record.source_contact_id || String(expected.history_number) !== record.history_number
      || expected.contact_due_at?.slice(0,10) !== record.contact_due_date || expected.status !== record.source_status
      || cleanBody(expected.body) !== cleanBody(record.clinical_notes)
      || hash(expectedErrors.sort()) !== hash([...record.validation_errors].sort())) fail('FOLLOWUP_SOURCE_ROW_CONTENT_CHANGED');
    const reference = reconciled ? reconciled.canonical_source_reference : expected.source_external_id ? `alert:${expected.source_external_id}`
      : `row:${expected.provenance.file_sha256}:${expected.provenance.source_row}:${expected.provenance.row_sha256}`;
    if (reference !== record.source_reference) fail('FOLLOWUP_SOURCE_REFERENCE_CHANGED');
  }
  function verifyRecords(records, { normalized = false } = {}) {
    for (const record of records) verifyRecord(normalized ? record : c.normalizedRecord(record));
    // Preparation checks the full declared batch. Application intentionally
    // validates only reviewed operations; the authorization may also include
    // rows which were quarantined by identity/membership/source safeguards.
    if (administrativeOverride && !normalized) {
      const keys = new Set(records.map(record => normalized ? record.source_key : c.normalizedRecord(record).source_key));
      if (administrativeOverride.source_keys.some(key => !keys.has(key))) fail('FOLLOWUP_OVERRIDE_SOURCE_NOT_IN_BATCH');
    }
  }
  function decisionsFor(records, live) {
    verifyRecords(records);
    return records.map(input => buildClinicDecision({ input, live, evidence, administrativeOverride, administrativeScope }));
  }
  function verifyOperation(op, live) {
    verifyRecord(op.record);
    const inference = op.record.source_status === 'pending' ? c.inferTargetMonth({ text: op.record.clinical_notes, contactDueDate: op.record.contact_due_date })
      : { month: null, reason: 'HISTORY_STATE_PRESERVED' };
    if (hash(inference) !== hash(op.inference)) fail('FOLLOWUP_SOURCE_TARGET_CHANGED');
    if (op.action !== 'create') return;
    const expected = buildClinicDecision({ input: rawRecord(op.record), live, evidence, administrativeOverride, administrativeScope });
    const projected = { clinic_id: expected.clinic_id, rule: expected.rule, evidence: expected.evidence,
      ...(expected.administrative_authorization ? { administrative_authorization: expected.administrative_authorization } : {}) };
    if (expected.action !== 'apply' || hash(projected) !== hash(op.decision)) {
      fail('FOLLOWUP_SOURCE_CLINIC_DECISION_CHANGED');
    }
  }
  return { verifyRecords, decisionsFor, verifyOperation };
}

module.exports = { createSourceProof, rawRecord };
