'use strict';
// A row lock serializes writers; the expected version prevents a stale editor
// from replacing a newer clinical note after it obtains that lock.
function requireExpectedVersion(payload) {
  const value = payload?.expected_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error('Vuelve a abrir el informe para guardar sobre su versión actual. Tu texto no se ha guardado.'), {
      statusCode: 428, code: 'clinical_report_version_required',
    });
  }
  return value;
}
function assertCurrentVersion(expected, report) {
  const actual = report ? Number(report.version_number) : 0;
  if (!Number.isSafeInteger(actual) || actual < 0 || actual !== expected) {
    throw Object.assign(new Error('El informe ha cambiado desde que lo abriste. Conserva tu texto y revisa la última versión antes de guardar.'), {
      statusCode: 409, code: 'clinical_report_version_conflict',
      details: { expected_version: expected, current_version: actual },
    });
  }
}
module.exports = { requireExpectedVersion, assertCurrentVersion };
