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
// These routes predate the shared JSON error boundary. Expected domain errors
// must not fall through to Express' HTML handler (which can expose a stack).
function clinicalReportHandler(action) {
  return (req, res, next) => Promise.resolve().then(() => action(req, res)).catch(error => {
    if ([400, 401, 403, 404, 409, 428].includes(error?.statusCode) && typeof error.code === 'string') {
      const body = { code: error.code, message: error.message };
      if (error.code === 'clinical_report_version_conflict') body.details = error.details;
      return res.status(error.statusCode).json({ error: body });
    }
    return next(error);
  });
}
module.exports = { requireExpectedVersion, assertCurrentVersion, clinicalReportHandler };
