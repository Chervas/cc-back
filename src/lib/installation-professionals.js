'use strict';

// Empty/null is deliberately unrestricted for installations created before this
// contract. Invalid stored data fails closed instead of granting access.
function normalizeInstallationProfessionals(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200
    || value.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    const error = new Error('Selecciona profesionales válidos de esta clínica.');
    error.status = 400;
    error.code = 'installation_professionals_invalid';
    throw error;
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function installationAllowsStaff(installation, doctorIds = []) {
  let allowed;
  try { allowed = normalizeInstallationProfessionals(installation?.profesionales_permitidos); }
  catch { return false; }
  if (!allowed.length) return true;
  return doctorIds.length > 0 && doctorIds.every(id => allowed.includes(Number(id)));
}

module.exports = { normalizeInstallationProfessionals, installationAllowsStaff };
