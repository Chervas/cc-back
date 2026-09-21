'use strict';

// Deterministic READ ONLY audit. A possible collision is a deferral, never a
// merge. Recomputed again by the writer; the report is not executable SQL.
const { hash, norm, dateOnly, normalizeContacts, index } = require('./adapter');
const { newEvidence } = require('./primary-clinics');
const { choosePrimaryClinic } = require('./planner');
const VERSION = 'cliniccloud-new-patients-audit/2';

function sourceWindow(manifest) {
  const coverage = manifest.coverage || {};
  const asOf = manifest.contacts_as_of;
  if (![coverage.start, coverage.end, asOf].every(v => typeof v === 'string' && dateOnly(v) === v)
    || coverage.start > asOf || asOf > coverage.end
    || Date.parse(coverage.end) - Date.parse(coverage.start) > 366 * 86400000) throw Error('NEW_PATIENT_COVERAGE_INVALID');
  return { start: coverage.start, end: asOf };
}

function primaryProof(sources, sourceId) {
  const observed=require('./observed-history-primary').observedHistoryPrimary(sources,sourceId);
  if(observed) return observed;
  const rows = sources.appointments.rows.filter(row => String(row.values.IDCONTACTO) === String(sourceId)).map(row => ({
    ...row, provenance: { file_sha256: sources.appointments.file.sha256, source_row: row.source_row, row_sha256: hash(row.values) },
  }));
  const { evidence } = newEvidence(rows, sources.historic_types.rows);
  const choice = choosePrimaryClinic(evidence);
  const reasons = choice.reason ? [choice.reason] : [];
  const first = choice.evidence?.[0]?.treatment_date;
  if (evidence.some(row => !row.clinic_id && !row.payment_reversed && (choice.rule === 'oldest_paid_treatment'
    ? row.paid_evidence && (!first || row.treatment_date <= first)
    : row.paid_evidence || !first || row.treatment_date <= first))) reasons.push('EARLIER_OR_PAID_TREATMENT_HAS_AMBIGUOUS_CLINIC');
  return { proposed_primary_clinic_id: reasons.length ? null : choice.clinic_id,
    membership_clinic_ids: [...new Set(evidence.map(row => row.clinic_id).filter(id => [66, 72].includes(id)))].sort((a, b) => a - b),
    primary_rule: choice.rule, primary_evidence: choice.evidence || [], reasons,
    first_evidence_date: evidence.map(row => row.treatment_date).sort()[0] || null };
}

function creationWithProof(raw,manifest,proof){
  const core=require('./new-patients-apply'),window=sourceWindow(manifest);
  if(manifest.version==='cliniccloud-new-patients-audit/3'&&proof.coverage_basis&&!proof.reasons.length){
    const created=core.sourceCreated(raw,{start:'1900-01-01',end:window.end});
    if(!proof.first_evidence_date||proof.first_evidence_date<created.local.slice(0,10)) throw Error('TREATMENT_PRECEDES_SOURCE_CREATION');
    return {...created,coverage_basis:proof.coverage_basis};
  }
  return core.sourceCreated(raw,window);
}

// Deliberately conservative: one insertion, deletion or replacement in a long
// normalized name, or an omitted given/surname token, requires manual review.
function nearName(left, right) {
  const a = String(left || ''), b = String(right || '');
  if (Math.min(a.replace(/ /g, '').length, b.replace(/ /g, '').length) < 10) return false;
  const at = a.split(' '), bt = b.split(' ');
  if (Math.min(at.length, bt.length) >= 2 && (at.every(token => bt.includes(token)) || bt.every(token => at.includes(token)))) return true;
  const x = a.replace(/ /g, ''), y = b.replace(/ /g, '');
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length >= y.length) i++;
    if (y.length >= x.length) j++;
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

function buildNewPatientsAudit({ sources, live, coverage, contactsAsOf, now = new Date().toISOString() }) {
  const core = require('./new-patients-apply');
  const observed=Boolean(sources.live_histories);
  const manifest = { version: observed?'cliniccloud-new-patients-audit/3':VERSION, source_account: core.ACCOUNT, coverage, contacts_as_of: contactsAsOf,
    generated_at: now, local_snapshot_sha256: hash(live), source_files: Object.values(sources).map(source => source.file),
    policy: { whatsapp_ignored: true, primary_requires_source_creation_inside_export_coverage: !observed,
      ...(observed?{primary_requires_export_or_observed_history_coverage:true}:{}),
      identity_collisions_are_deferrals: true, no_automatic_merges: true, max_batch: 70 } };
  const window = sourceWindow(manifest);
  if (!live.group_id || !live.clinic_ids.includes(66) || !live.clinic_ids.includes(72)) throw Error('NEW_PATIENT_GROUP_SCOPE_CHANGED');
  const contacts = sources.contacts.rows, historic = sources.historic_contacts.rows;
  const ids = index(contacts, row => row.values.IDCONTACTO), nums = index(contacts, row => row.values.NUM);
  const historicIds = new Set(historic.map(row => String(row.values.idContacto)));
  const historicNums = new Set(historic.map(row => String(row.values.num)));
  const linkedIds = new Set(live.source_links.map(row => String(row.source_contact_id)));
  const linkedNums = new Set(live.source_links.filter(row => row.history_number != null).map(row => String(row.history_number)));
  const currentIdentities = contacts.map(row => ({ id: String(row.values.IDCONTACTO), keys: core.sourceIdentity(row.values) }));
  const historicalIdentities = historic.map(row => core.identityKeys({ name: row.values.nombre, surname: row.values.apellidos,
    phones: [row.values.tele1, row.values.tele2], email: row.values.email, national_id: row.values.dni }));
  const localIdentities = live.patients.map(core.localIdentity);
  const normalized = normalizeContacts(contacts, sources.contacts.file.sha256);
  const rows = []; let remaining = 70, alreadyLinked = 0;
  for (let i = 0; i < contacts.length; i++) {
    const record = contacts[i], raw = record.values, row = normalized[i], id = String(row.source_contact_id);
    if (linkedIds.has(id)) { alreadyLinked++; continue; }
    const reasons = [];
    if (!/^[1-9]\d*$/.test(id) || ids.get(id)?.length !== 1 || historicIds.has(id)) reasons.push('SOURCE_ID_NOT_NEW_UNIQUE');
    if (!/^[1-9]\d*$/.test(String(raw.NUM)) || nums.get(raw.NUM)?.length !== 1 || historicNums.has(String(raw.NUM)) || linkedNums.has(String(raw.NUM))) reasons.push('HISTORY_NUMBER_NOT_NEW_UNIQUE');
    const proof = primaryProof(sources, id);
    let created;
    try { created = creationWithProof(raw,manifest,proof); } catch { reasons.push('SOURCE_CREATION_NOT_WITHIN_CONFIRMED_COVERAGE'); }
    if (norm(raw.ESTADO) !== 'ACTIVO' || /BLOQUEO AGENDA|VISITA COMERCIAL/.test(norm(`${raw.NOMBRE} ${raw.APELLIDOS}`))) reasons.push('CONTACT_NOT_ACTIVE_PERSON');
    if (!String(raw.NOMBRE || '').trim() || !String(raw.APELLIDOS || '').trim()) reasons.push('PATIENT_NAME_INCOMPLETE');
    if (String(raw['F. NACIMIENTO'] || '').trim() && !row.fields.birth_date) reasons.push('SOURCE_BIRTH_DATE_INVALID');
    if (created && row.fields.birth_date > created.local.slice(0, 10)) reasons.push('BIRTH_DATE_AFTER_SOURCE_CREATION');
    const keys = core.sourceIdentity(raw);
    if (!keys.phones.length && !keys.email) reasons.push('CONTACT_CHANNEL_OR_GUARDIAN_REQUIRED');
    reasons.push(...proof.reasons);
    if (created && proof.first_evidence_date && proof.first_evidence_date < created.local.slice(0, 10)) reasons.push('TREATMENT_PRECEDES_SOURCE_CREATION');
    if (!proof.coverage_basis&&proof.primary_evidence.some(item => item.treatment_date < coverage.start || item.treatment_date > coverage.end)) reasons.push('PRIMARY_EVIDENCE_OUTSIDE_COVERAGE');
    // Do the relatively expensive variant sweep only for otherwise eligible
    // new people. The writer repeats exact collisions against every identity.
    if (!reasons.length) {
      const others = [...currentIdentities.filter(other => other.id !== id).map(other => other.keys), ...historicalIdentities, ...localIdentities];
      if (others.some(other => core.intersects(keys, other))) reasons.push('SOURCE_HISTORIC_OR_LOCAL_IDENTITY_COLLISION');
      else if (others.some(other => nearName(keys.name, other.name))) reasons.push('POSSIBLE_NAME_VARIANT_REQUIRES_REVIEW');
    }
    const status = reasons.length ? 'defer' : remaining-- > 0 ? 'safe_candidate_for_reviewed_creation' : 'ready_for_next_batch';
    rows.push({ ...row, action_key: hash([core.ACCOUNT, 'new_patient', id]), status, reasons: [...new Set(reasons)],
      proposed_primary_clinic_id: proof.proposed_primary_clinic_id, membership_clinic_ids: proof.membership_clinic_ids,
      primary_rule: proof.primary_rule, primary_evidence: proof.primary_evidence });
  }
  const count = (items, key) => items.reduce((out, item) => { out[item[key]] = (out[item[key]] || 0) + 1; return out; }, {});
  const result = { manifest, summary: { source_contacts: contacts.length, already_linked: alreadyLinked,
    actions: count(rows, 'status'), reasons: count(rows.flatMap(row => row.reasons.map(reason => ({ reason }))), 'reason') }, rows };
  return { ...result, plan_sha256: hash(result) };
}

module.exports = { VERSION, sourceWindow, primaryProof, creationWithProof, nearName, buildNewPatientsAudit };
