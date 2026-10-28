'use strict';

// Presentation only. This field never determines a clinical role or permission.
function professionalTitlePatch(body) {
  if (!Object.hasOwn(body || {}, 'tratamiento_profesional')) return {};
  const value = body.tratamiento_profesional;
  if (value !== null && value !== 'Dr.' && value !== 'Dra.') {
    throw Object.assign(new Error('El tratamiento profesional debe ser Dr., Dra. o sin tratamiento.'), {
      code: 'professional_title_invalid', status: 400,
    });
  }
  return { tratamiento_profesional: value };
}

module.exports = { professionalTitlePatch };
