'use strict';

const {
  WEB_DOCUMENT_VERSION,
  WebDocumentValidationError,
  assertValidWebDocument,
} = require('./webDocument');

class WebDocumentHashMismatchError extends WebDocumentValidationError {
  constructor(expectedHash, receivedHash) {
    super([
      {
        keyword: 'documentHash',
        instancePath: '/document_hash',
        message: 'no coincide con el hash canónico del documento',
        params: { expectedHash, receivedHash },
      },
    ], 'El hash de WebDocument no coincide');
    this.name = 'WebDocumentHashMismatchError';
    this.code = 'WEB_DOCUMENT_HASH_MISMATCH';
  }
}

function attachWebDocumentIntegrityHook(Model, options = {}) {
  const documentField = options.documentField || 'document';
  const hashField = options.hashField || 'documentHash';
  const schemaVersionField = options.schemaVersionField || 'schemaVersion';

  Model.addHook('beforeValidate', 'webDocumentV1Integrity', (instance) => {
    const document = instance.get(documentField);
    if (document == null) return;

    const result = assertValidWebDocument(document);
    const receivedHash = instance.get(hashField);
    const documentChanged = typeof instance.changed === 'function' && instance.changed(documentField) === true;
    const hashChanged = typeof instance.changed === 'function' && instance.changed(hashField) === true;
    const mustVerifyReceivedHash = Boolean(receivedHash) && (
      instance.isNewRecord || !documentChanged || hashChanged
    );
    if (mustVerifyReceivedHash && receivedHash !== result.hash) {
      throw new WebDocumentHashMismatchError(result.hash, receivedHash);
    }
    instance.set(hashField, result.hash);
    instance.set(schemaVersionField, WEB_DOCUMENT_VERSION);
  });
}

function validateClinicScope(instance, options = {}) {
  const allowGlobal = options.allowGlobal === true;
  const scopeType = instance.scopeType;
  const clinicId = instance.clinicaId;
  const groupId = instance.grupoClinicaId;

  if (!['clinic', 'group', ...(allowGlobal ? ['global'] : [])].includes(scopeType)) {
    throw new Error('El tipo de alcance no es válido');
  }

  if (scopeType === 'clinic' && (clinicId == null || groupId != null)) {
    throw new Error('El alcance clinic requiere clinica_id y prohíbe grupo_clinica_id');
  }
  if (scopeType === 'group' && (groupId == null || clinicId != null)) {
    throw new Error('El alcance group requiere grupo_clinica_id y prohíbe clinica_id');
  }
  if (scopeType === 'global' && (!allowGlobal || clinicId != null || groupId != null)) {
    throw new Error('El alcance global no admite clinica_id ni grupo_clinica_id');
  }
}

function scopeKeyFor(instance, options = {}) {
  validateClinicScope(instance, options);
  if (instance.scopeType === 'global') return 'global';
  if (instance.scopeType === 'clinic') return `clinic:${instance.clinicaId}`;
  return `group:${instance.grupoClinicaId}`;
}

module.exports = {
  WebDocumentHashMismatchError,
  attachWebDocumentIntegrityHook,
  validateClinicScope,
  scopeKeyFor,
};
