'use strict';

function normalizedNutritionArea(value) {
  const code = value && typeof value === 'object' ? value.code : value;
  return typeof code === 'string'
    ? code.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    : '';
}

function configuredNutritionArea(clinic) {
  let config = clinic?.configuracion;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return false; }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const matches = value => ['nutricion', 'nutricion_clinica'].includes(normalizedNutritionArea(value));
  if (Object.prototype.hasOwnProperty.call(config, 'disciplinas')) {
    return Array.isArray(config.disciplinas) && config.disciplinas.some(matches);
  }
  return matches(config.disciplina);
}

function assertNutritionAreaConfigured(clinic) {
  if (!configuredNutritionArea(clinic)) {
    throw Object.assign(new Error('Esta clínica no tiene habilitada Nutrición. Puedes consultar sus mediciones anteriores.'), {
      status: 403, code: 'nutrition_area_not_configured',
    });
  }
}

module.exports = { configuredNutritionArea, assertNutritionAreaConfigured };
