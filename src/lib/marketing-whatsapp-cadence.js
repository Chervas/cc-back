'use strict';

const MIN_DELAY_MS = 2 * 60 * 1000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 1000;
const EDITABLE_STATUSES = ['queued', 'scheduled', 'waiting_next_batch'];

function normalizeCadence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Revisa el ritmo de WhatsApp.'), { status: 400 });
  }
  const { batch_size, delay_ms } = value;
  if (!Number.isSafeInteger(batch_size) || batch_size < 1 || batch_size > MAX_BATCH_SIZE
    || !Number.isSafeInteger(delay_ms) || delay_ms < MIN_DELAY_MS || delay_ms > MAX_DELAY_MS) {
    throw Object.assign(new Error('Indica de 1 a 1.000 mensajes por lote y una pausa de 2 minutos a 30 días.'), { status: 400 });
  }
  return { batch_size, delay_ms };
}

function draftCadence(body, criteria = {}) {
  const value = body.whatsapp_cadence === undefined ? criteria.whatsapp_cadence : body.whatsapp_cadence;
  return value == null ? value : normalizeCadence(value);
}

function earliestDelayChange({ dispatch, job, cadence }) {
  if (dispatch.status !== 'waiting_next_batch' || job.status !== 'waiting'
    || job.result_summary?.reason !== 'batch_delay' || cadence.delay_ms <= dispatch.delay_ms) return null;
  const lastBatch = Date.parse(dispatch.last_batch_completed_at || '');
  const scheduled = Math.max(Date.parse(job.next_run_at || ''), Date.parse(dispatch.next_allowed_at || ''));
  const earliest = lastBatch + cadence.delay_ms;
  return Number.isFinite(scheduled) && earliest > scheduled ? new Date(earliest) : null;
}

module.exports = { EDITABLE_STATUSES, normalizeCadence, draftCadence, earliestDelayChange };
