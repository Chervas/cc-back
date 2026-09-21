'use strict';

// ClinicCloud's week endpoint exposes only the last concept of a multi-act
// appointment. Restore its complete source label from the read-only history;
// do not infer treatments, clinical equivalence, prices, phases or staff.
const { hash, norm, localDateTime } = require('./adapter');
const positive = n => /^[1-9]\d*$/.test(String(n)) && Number.isSafeInteger(Number(n));
const note = n => norm(String(n || '').replace(/,/g, ' '));
const fail = () => { throw Error('COMPOUND_SOURCE_EVIDENCE_INVALID'); };
function compoundSourceEvidence({ actions, history, live, now = Date.now() }) {
  for (const document of [history, live]) {
    if (document?.source_account !== 'cliniccloud-5880' || !Number.isFinite(Date.parse(document.captured_at))
      || Date.parse(document.captured_at) > now || now - Date.parse(document.captured_at) > 3600000) fail();
  }
  if (!Array.isArray(actions) || actions.length < 2 || actions.length > 8 || !Array.isArray(live.rows)) fail();
  const sources = actions.map(a => a.source), first = sources[0];
  if (!first || sources.some(s => !s || s.kind !== 'appointment' || s.validation_errors?.length
    || ['source_contact_id','start_local','end_local','service_key','status'].some(k => s[k] !== first[k])
    || norm(s.details) !== norm(first.details) || s.status !== 'pendiente')
    || new Set(sources.map(s => s.agenda_key)).size !== sources.length) fail();
  const patients = history.patients?.filter(p => String(p.contact_id) === first.source_contact_id) || [];
  if (patients.length !== 1 || !Array.isArray(patients[0].rows)) fail();
  const rows = [], evidence = [];
  for (const source of sources) {
    const matches = patients[0].rows.filter(r => String(r.idContacto) === source.source_contact_id && Number(r.idEmpresa) === 5880
      && localDateTime(r.fechaIni,r.horaIni) === source.start_local && localDateTime(r.fechaFin,r.horaFin) === source.end_local
      && norm(r.agenda?.nombre) === source.agenda_key);
    if (matches.length !== 1) fail();
    const row = matches[0], concepts = row.conceptos;
    if (!positive(row.idCita) || Number(row.estado) !== 0 || !Array.isArray(concepts) || concepts.length < 2 || concepts.length > 8
      || concepts.some(c => !positive(c.idServicio) || !String(c.asunto || '').trim())
      || norm(concepts.map(c => c.asunto).join('-')) !== source.service_key || note(row.detalles) !== note(source.details)) fail();
    const weeks = live.rows.filter(r => String(r.appointment_id) === String(row.idCita));
    if (weeks.length !== 1) fail();
    const week = weeks[0];
    if (String(week.contact_id) !== source.source_contact_id || Number(week.state) !== 0
      || String(week.start).replace(' ','T') !== source.start_local || String(week.end).replace(' ','T') !== source.end_local
      || norm(week.agenda) !== source.agenda_key || note(week.details) !== note(source.details)
      || ![norm(concepts[concepts.length-1].asunto), source.service_key].includes(norm(week.service))) fail();
    const sourceConcepts = concepts.map(c => ({ source_service_id: String(c.idServicio), name: String(c.asunto) }));
    rows.push({ ...week, service: source.service_key, details: source.details || '',
      complete_concepts_from: 'authenticated_source_patient_history', source_concepts: sourceConcepts });
    evidence.push({ source_appointment_id: String(row.idCita), source_contact_id: source.source_contact_id,
      source_row_key: source.provenance?.row_key, source_concepts: sourceConcepts, source_history_row_sha256: hash(row),
      original_week_service: week.service, original_note: row.detalles || '', csv_provenance: source.provenance });
  }
  if (new Set(evidence.map(e => e.source_appointment_id)).size !== evidence.length
    || new Set(evidence.map(e => hash(e.source_concepts))).size !== 1) fail();
  const body = { version: 'cliniccloud-compound-source-evidence/1', source_account: 'cliniccloud-5880',
    history_sha256: hash(history), week_sha256: hash(live), reviewed_at: new Date(now).toISOString(),
    concepts_are_source_labels_not_catalog_ids: true, phase_durations_inferred: false, entries: evidence };
  const receipt = { ...body, evidence_sha256: hash(body) };
  // Only reviewed rows are exposed to the strict parallel-binding validator.
  return { receipt, live: { source_account: live.source_account,
    captured_at: new Date(Math.min(Date.parse(history.captured_at),Date.parse(live.captured_at))).toISOString(),
    coverage: live.coverage, rows, complete_concepts_evidence_sha256: receipt.evidence_sha256 } };
}
module.exports = { compoundSourceEvidence };
