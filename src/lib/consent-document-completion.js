'use strict';

// Opt-in capability for NEW, non-clinical information documents. Historical
// requires_patient_signature=false never grants this capability on its own.
const SCHEMA = 'cc-document-completion/v1';
const object = raw => { if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {}; } }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; };
const plain = row => row?.toJSON ? row.toJSON() : row;
const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const hash = (snapshot, html) => require('./consent-document-choices').choiceSnapshotHash(snapshot, html || '');

function policy(version, template, statusCode = 409) {
  const body = object(version?.body_json);
  if (!Object.hasOwn(body, 'document_completion')) return null;
  const marker = object(body.document_completion);
  if (Object.keys(marker).length !== 3 || marker.schema_version !== SCHEMA
    || marker.signature_mode !== 'none' || marker.completion_mode !== 'acknowledge'
    || template?.purpose !== 'other' || template.requires_patient_signature !== false
    || template.requires_representative_when_minor !== false || template.requires_professional_signature !== false
    || body.registration_privacy || body.digital_presentation || body.consent_form) {
    throw fail('consent_document_completion_configuration_invalid', statusCode);
  }
  return marker;
}
function documentPolicy(document) {
  const doc = plain(document), snapshot = object(doc?.snapshot_json);
  const resolved = policy(object(snapshot.version), object(snapshot.template));
  if (resolved && (doc.purpose !== 'other'
    || Number(snapshot.template.id) !== Number(doc.clinic_template_id || doc.catalog_template_id)
    || Number(snapshot.version?.id) !== Number(doc.clinic_template_version_id || doc.catalog_template_version_id)
    || Number(snapshot.context?.paciente?.id) !== Number(doc.paciente_id)
    || Number(snapshot.context?.clinica?.id) !== Number(doc.clinica_id))) throw fail('consent_document_completion_scope_invalid');
  return resolved;
}
function validateTemplate(version, template) {
  require('./consent-document-blocks').versionBlocks(version, template, 400);
  policy(version, template, 400);
  if (template?.purpose === 'data_protection' && template.requires_patient_signature === false) {
    throw fail('consent_privacy_patient_signature_required', 400);
  }
}
function assertUnsigned(document) {
  if (!documentPolicy(document)) throw fail('consent_document_completion_not_allowed');
}
function isCompleted(document, now = new Date()) {
  const doc = plain(document), snapshot = object(doc?.snapshot_json), evidence = object(snapshot.completion_evidence);
  try { assertUnsigned(doc); } catch { return false; }
  const completedAt = new Date(evidence.completed_at).getTime();
  if (doc.status !== 'completed' || doc.signed_at || doc.signed_by_patient_id || doc.signed_by_representative_id
    || doc.professional_signed_at || doc.professional_signed_by || doc.revoked_at || snapshot.signature_evidence
    || snapshot.professional_signature_evidence || evidence.schema_version !== SCHEMA
    || evidence.method !== 'tablet_acknowledgement' || evidence.acknowledged !== true
    || !Number.isFinite(completedAt) || completedAt > now.getTime()
    || (doc.expires_at && (!Number.isFinite(new Date(doc.expires_at).getTime()) || new Date(doc.expires_at) <= now))
    || Number(evidence.document_id) !== Number(doc.id) || Number(evidence.patient_id) !== Number(doc.paciente_id)
    || Number(evidence.clinic_id) !== Number(doc.clinica_id) || Number(evidence.package_id) !== Number(doc.package_id)
    || Number(snapshot.template.id) !== Number(doc.clinic_template_id || doc.catalog_template_id)
    || Number(snapshot.version.id) !== Number(doc.clinic_template_version_id || doc.catalog_template_version_id)) return false;
  const { completion_evidence: _receipt, ...before } = snapshot;
  let beforeHtml = doc.snapshot_html;
  try {
    if (require('./consent-document-blocks').documentBlocks(doc)) {
      delete before.document_block_answers;
      beforeHtml = require('./consent-document-blocks').renderVersion(before.version, before.context);
    }
  } catch { return false; }
  return evidence.snapshot_hash_before_completion === hash(before, beforeHtml)
    && doc.snapshot_hash === hash(snapshot, doc.snapshot_html);
}
function completedValues(document, payload, requestMeta = {}, now = new Date()) {
  const doc = plain(document);
  assertUnsigned(doc);
  require('./consent-document-personal-data').assertReadyToSign(doc, payload);
  if (payload.acknowledged !== true) throw fail('consent_document_acknowledgement_required', 400);
  if (!['pending', 'sent', 'viewed'].includes(doc.status) || doc.signed_at || doc.revoked_at) throw fail('consent_document_already_closed');
  if (doc.expires_at && (!Number.isFinite(new Date(doc.expires_at).getTime()) || new Date(doc.expires_at) <= now)) throw fail('consent_document_expired', 410);
  const snapshot = object(doc.snapshot_json);
  if (!/^[a-f0-9]{64}$/.test(payload.document_snapshot_hashes?.[String(doc.id)] || '')
    || payload.document_snapshot_hashes[String(doc.id)] !== doc.snapshot_hash
    || doc.snapshot_hash !== hash(snapshot, doc.snapshot_html)) throw fail('consent_document_completion_changed');
  if (snapshot.signature_evidence || snapshot.completion_evidence) throw fail('consent_document_already_closed');
  const evidence = { schema_version: SCHEMA, method: 'tablet_acknowledgement', acknowledged: true,
    document_id: Number(doc.id), patient_id: Number(doc.paciente_id), clinic_id: Number(doc.clinica_id), package_id: Number(doc.package_id),
    completed_at: now.toISOString(), snapshot_hash_before_completion: doc.snapshot_hash,
    ip: typeof requestMeta.ip === 'string' ? requestMeta.ip.slice(0, 80) : null,
    user_agent: typeof requestMeta.userAgent === 'string' ? requestMeta.userAgent.slice(0, 500) : null };
  const blocks = require('./consent-document-blocks');
  blocks.validateAnswerMap(payload, [doc]);
  const answers = blocks.answerEvidence(doc, payload, now);
  const next = { ...snapshot, ...(answers ? { document_block_answers: answers } : {}), completion_evidence: evidence };
  const html = blocks.renderVersion(snapshot.version, snapshot.context, { answers: answers?.answers || {} }) ?? doc.snapshot_html;
  return { status: 'completed', delivery_status: 'completed', snapshot_json: next,
    ...(html !== doc.snapshot_html ? { snapshot_html: html } : {}), snapshot_hash: hash(next, html) };
}
function publicFields(document) {
  const doc = plain(document);
  let unsigned = false;
  try { unsigned = !!documentPolicy(doc); } catch { /* Invalid new configuration never becomes a no-signature capability. */ }
  const evidence = object(object(doc.snapshot_json).completion_evidence);
  return { completion_mode: unsigned ? 'acknowledge' : 'signature', requires_patient_signature: !unsigned,
    completion_evidence: isCompleted(doc) ? { method: evidence.method, completed_at: evidence.completed_at, acknowledged: true } : null };
}
module.exports = { SCHEMA, policy, documentPolicy, validateTemplate, assertUnsigned, isCompleted, completedValues, publicFields, hash };
