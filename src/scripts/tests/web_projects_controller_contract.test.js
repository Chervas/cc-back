'use strict';

const assert = require('node:assert/strict');
const {
  requestIdFor,
  sendError,
  withRequestContext,
} = require('../../controllers/webProjects.controller');

function responseDouble() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

async function main() {
  assert.equal(
    requestIdFor({ get: () => 'client-request_123' }),
    'client-request_123'
  );
  assert.match(
    requestIdFor({ get: () => 'contains spaces and\nnewlines' }),
    /^[0-9a-f-]{36}$/
  );

  const req = { get: () => 'web-save:12345678' };
  const res = responseDouble();
  const handler = withRequestContext(async () => {
    const error = new Error('Conflicto de edición');
    error.code = 'draft_conflict';
    error.status = 409;
    error.details = { current_lock_version: 4 };
    throw error;
  }, 'No se pudo guardar.');
  await handler(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.headers['X-Request-Id'], 'web-save:12345678');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.payload, {
    success: false,
    error: {
      code: 'draft_conflict',
      message: 'Conflicto de edición',
      details: { current_lock_version: 4 },
    },
    request_id: 'web-save:12345678',
  });

  const accessResponse = responseDouble();
  const accessError = new Error('access_policy_forbidden');
  accessError.status = 403;
  sendError(accessResponse, accessError, 'access:12345678', 'Error interno');
  assert.equal(accessResponse.statusCode, 403);
  assert.equal(accessResponse.payload.error.code, 'access_policy_forbidden');

  const documentResponse = responseDouble();
  const documentError = new Error('documento inválido');
  documentError.name = 'WebDocumentValidationError';
  documentError.code = 'WEB_DOCUMENT_INVALID';
  documentError.errors = [{ keyword: 'required' }];
  sendError(documentResponse, documentError, 'document:12345678', 'Error interno');
  assert.equal(documentResponse.statusCode, 422);
  assert.equal(documentResponse.payload.error.code, 'web_document_invalid');
  assert.deepEqual(documentResponse.payload.error.details.issues, [{ keyword: 'required' }]);

  const uniqueResponse = responseDouble();
  const uniqueError = new Error('duplicate');
  uniqueError.name = 'SequelizeUniqueConstraintError';
  sendError(uniqueResponse, uniqueError, 'unique:12345678', 'Error interno');
  assert.equal(uniqueResponse.statusCode, 409);
  assert.equal(uniqueResponse.payload.error.code, 'resource_conflict');

  console.log('web projects controller contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
