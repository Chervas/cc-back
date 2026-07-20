'use strict';

const {
  BACKGROUND_INTEGRATION_JOB_TYPES,
} = require('../config/scheduledJobCatalog');

const BACKGROUND_INTEGRATION_TYPES = new Set(BACKGROUND_INTEGRATION_JOB_TYPES);
// Este reconciliador es durable y checkpointable sobre N publicaciones.
// Promise.race no cancela el handler original y podría dejar dos ejecuciones
// mutando el mismo outbox si el timeout global lo diese por terminado.
const NO_EXECUTION_TIMEOUT_TYPES = new Set([
  'web_intake_runtime_reconcile',
  // El rollout guarda un checkpoint tras cada plantilla/WABA. Interrumpir una
  // llamada a Meta con Promise.race no la cancela y podría duplicar el alta.
  'whatsapp_language_rollout',
]);

function normalizeJobType(value) {
  return String(value || '').trim().toLowerCase();
}

function isBackgroundIntegrationJob(jobType) {
  return BACKGROUND_INTEGRATION_TYPES.has(normalizeJobType(jobType));
}

function shouldUseExecutionTimeout(jobType) {
  const normalized = normalizeJobType(jobType);
  return !BACKGROUND_INTEGRATION_TYPES.has(normalized)
    && !NO_EXECUTION_TIMEOUT_TYPES.has(normalized);
}

module.exports = {
  isBackgroundIntegrationJob,
  normalizeJobType,
  shouldUseExecutionTimeout,
};
