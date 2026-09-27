'use strict';

// Medical-area publication and clinic adoption belong to the application API.
// The external gateway must not expose its historical, unversioned writer.
// This gate has no DB/provider calls and does not affect inbound scheduling.
function createMedicalAreaApiBoundary(runtimeRole = process.env.RUNTIME_ROLE) {
  const gateway = String(runtimeRole || '').trim().toLowerCase() === 'gateway';
  return function medicalAreaApiBoundary(req, res, next) {
    if (!gateway) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({
      code: 'medical_area_api_required',
      message: 'La configuración de áreas médicas se gestiona desde la API de la aplicación.',
    });
  };
}

module.exports = { createMedicalAreaApiBoundary };
