'use strict';

const { hash } = require('./adapter');
const ROLE = 'administrative_clinic_override';
const RULE = 'user_override_capilar_20261118';
const VERSION = 'cliniccloud-followup-clinic-override/v1';
const SCOPE_ROLE = 'administrative_batch_scope';
const SCOPE_VERSION = 'cliniccloud-followup-batch-scope/v1';
const MEDICAL_RULE = 'exclusive_medical_membership_authorized_20261118';
const fail = code => { throw Object.assign(new Error(code), { code }); };

function sourceManifestHash(files) {
  return hash(files.filter(f => ![ROLE,SCOPE_ROLE,'followup_date_reconciliation'].includes(f.role)).map(f => ({ role: f.role, sha256: f.sha256 }))
    .sort((a,b) => a.role.localeCompare(b.role)));
}
function validateOverride({ document, file, sourceFiles }) {
  if (document?.version !== VERSION || document.source_account !== 'cliniccloud-5880'
    || document.target_clinic_id !== 66 || document.scope !== 'unresolved_origin_only'
    || document.authorization_kind !== 'explicit_user_instruction'
    || typeof document.authorized_by !== 'string' || !document.authorized_by.trim()
    || typeof document.authorization_reference !== 'string' || !document.authorization_reference.trim()
    || typeof document.instruction !== 'string' || !document.instruction.trim()
    || !Number.isFinite(Date.parse(document.recorded_at))
    || document.preserve_known_medical !== true || document.preserve_contact_dates !== true
    || document.keep_notifications_off !== true || document.historical_origin_known !== false
    || !Array.isArray(document.source_keys) || !document.source_keys.length || document.source_keys.length > 2000
    || new Set(document.source_keys).size !== document.source_keys.length
    || document.source_keys.some(key => !/^[a-f0-9]{64}$/.test(key))) fail('FOLLOWUP_ADMINISTRATIVE_OVERRIDE_INVALID');
  if (document.source_manifest_sha256 !== sourceManifestHash(sourceFiles)) fail('FOLLOWUP_OVERRIDE_MANIFEST_CHANGED');
  if (!file || file.role !== ROLE || !/^[a-f0-9]{64}$/.test(file.sha256 || '')
    || !sourceFiles.some(f => f.role === ROLE && f.sha256 === file.sha256)) fail('FOLLOWUP_OVERRIDE_FILE_NOT_IN_MANIFEST');
  return { source_keys: [...document.source_keys], proof: {
    rule: RULE, version: VERSION, file_sha256: file.sha256, document_sha256: hash(document),
    source_manifest_sha256: document.source_manifest_sha256, authorized_by: document.authorized_by,
    authorization_kind: document.authorization_kind, authorization_reference: document.authorization_reference,
    recorded_at: document.recorded_at, instruction: document.instruction,
    target_clinic_id: 66, historical_origin_known: false,
  } };
}

function validateDecisionAuthorization(authorization, sourceFiles) {
  if (!authorization || authorization.rule !== RULE || authorization.version !== VERSION
    || authorization.target_clinic_id !== 66 || authorization.historical_origin_known !== false
    || authorization.authorization_kind !== 'explicit_user_instruction'
    || typeof authorization.authorized_by !== 'string' || !authorization.authorized_by.trim()
    || typeof authorization.authorization_reference !== 'string' || !authorization.authorization_reference.trim()
    || typeof authorization.instruction !== 'string' || !authorization.instruction.trim()
    || !Number.isFinite(Date.parse(authorization.recorded_at))
    || !/^[a-f0-9]{64}$/.test(authorization.document_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(authorization.file_sha256 || '')
    || !sourceFiles.some(f => f.role === ROLE && f.sha256 === authorization.file_sha256)
    || authorization.source_manifest_sha256 !== sourceManifestHash(sourceFiles)) fail('FOLLOWUP_OVERRIDE_AUTHORIZATION_REQUIRED');
}

function validateBatchScope({ document, file, sourceFiles }) {
  if (document?.version !== SCOPE_VERSION || document.source_account !== 'cliniccloud-5880'
    || JSON.stringify(document.authorized_clinic_ids) !== '[66,72]'
    || document.authorization_kind !== 'clarification_of_existing_user_authorization'
    || typeof document.authorized_by !== 'string' || !document.authorized_by.trim()
    || typeof document.recorded_by !== 'string' || !document.recorded_by.trim()
    || typeof document.authorization_reference !== 'string' || !document.authorization_reference.trim()
    || typeof document.instruction !== 'string' || !document.instruction.trim()
    || !Number.isFinite(Date.parse(document.recorded_at)) || document.preserve_known_medical !== true
    || document.preserve_primary_clinics_and_memberships !== true || document.preserve_contact_dates_and_states !== true
    || document.keep_notifications_off !== true || document.unknown_shared_target_clinic_id !== 66
    || document.unknown_exclusive_uses_current_clinic !== true || document.historical_origin_known !== false) fail('FOLLOWUP_BATCH_SCOPE_INVALID');
  const manifest = sourceManifestHash(sourceFiles.filter(f => f.role !== SCOPE_ROLE));
  if (document.source_manifest_sha256 !== manifest) fail('FOLLOWUP_BATCH_SCOPE_MANIFEST_CHANGED');
  if (!file || file.role !== SCOPE_ROLE || !sourceFiles.some(f => f.role === SCOPE_ROLE && f.sha256 === file.sha256)) fail('FOLLOWUP_BATCH_SCOPE_FILE_NOT_IN_MANIFEST');
  return { rule: MEDICAL_RULE, version: SCOPE_VERSION, file_sha256: file.sha256, document_sha256: hash(document),
    source_manifest_sha256: manifest, authorization_kind: document.authorization_kind,
    authorization_reference: document.authorization_reference, authorized_by: document.authorized_by,
    recorded_by: document.recorded_by, recorded_at: document.recorded_at, instruction: document.instruction,
    target_clinic_id: 72, historical_origin_known: false };
}

function validateScopeDecisionAuthorization(authorization, sourceFiles) {
  if (!authorization || authorization.rule !== MEDICAL_RULE || authorization.version !== SCOPE_VERSION
    || authorization.target_clinic_id !== 72 || authorization.historical_origin_known !== false
    || authorization.authorization_kind !== 'clarification_of_existing_user_authorization'
    || typeof authorization.authorized_by !== 'string' || !authorization.authorized_by.trim()
    || typeof authorization.recorded_by !== 'string' || !authorization.recorded_by.trim()
    || typeof authorization.authorization_reference !== 'string' || !authorization.authorization_reference.trim()
    || typeof authorization.instruction !== 'string' || !authorization.instruction.trim()
    || !Number.isFinite(Date.parse(authorization.recorded_at)) || !/^[a-f0-9]{64}$/.test(authorization.document_sha256 || '')
    || !sourceFiles.some(f => f.role === SCOPE_ROLE && f.sha256 === authorization.file_sha256)
    || authorization.source_manifest_sha256 !== sourceManifestHash(sourceFiles.filter(f => f.role !== SCOPE_ROLE))) fail('FOLLOWUP_BATCH_SCOPE_AUTHORIZATION_REQUIRED');
}

module.exports = { ROLE, RULE, VERSION, SCOPE_ROLE, SCOPE_VERSION, MEDICAL_RULE, sourceManifestHash,
  validateOverride, validateDecisionAuthorization, validateBatchScope, validateScopeDecisionAuthorization };
