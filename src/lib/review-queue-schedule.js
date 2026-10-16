'use strict';
const calendar = require('./availability-calendar');

const KEYS = ['mode','time_mode','batch_size','delay_ms','delay_amount','delay_unit','business_hours',
  'scheduled_at','start_date','scheduled_time','window_start_time','window_end_time','include_weekends'];
const LIVE = ['queued','sending','scheduled','waiting_next_batch'];
const TERMINAL = ['completed','archived','failed','cancelled'];
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const pick = value => Object.fromEntries(KEYS.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

function normalize(raw = {}, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('Programación inválida');
  const mode = raw.mode, time_mode = raw.time_mode;
  if (!['all_at_once','custom'].includes(mode) || !['clinic_hours','specific_time'].includes(time_mode)) throw error('Elige un ritmo y un horario válidos');
  const batch_size = mode === 'all_at_once' ? 1 : Number(raw.batch_size);
  const delay_ms = mode === 'all_at_once' ? 600000 : Number(raw.delay_ms);
  if (!Number.isInteger(batch_size) || batch_size < 1 || batch_size > 1000 || !Number.isInteger(delay_ms) || delay_ms < 60000 || delay_ms > 30*86400000) throw error('Ritmo fuera de los límites permitidos');
  const result = { ...pick(raw), mode, time_mode, batch_size, delay_ms };
  if (time_mode === 'specific_time') {
    const h = raw.business_hours || {}, validTime = v => typeof v === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
    if (!validTime(h.start_time) || !validTime(h.end_time) || h.end_time <= h.start_time
      || !validTime(raw.scheduled_time) || raw.scheduled_time < h.start_time || raw.scheduled_time >= h.end_time
      || !/^\d{4}-\d{2}-\d{2}$/.test(raw.start_date || '') || !Number.isFinite(Date.parse(raw.scheduled_at))) throw error('Revisa el inicio y la ventana de envío');
    const start = calendar.localDateTimeToUtc(raw.start_date,raw.scheduled_time,'Europe/Madrid');
    const parts = start && calendar.formatPartsInTimeZone(start,'Europe/Madrid');
    if (!start || calendar.formatDateLocal(start,'Europe/Madrid') !== raw.start_date
      || raw.start_date < calendar.formatDateLocal(now,'Europe/Madrid')
      || `${String(parts.hour).padStart(2,'0')}:${String(parts.minute).padStart(2,'0')}` !== raw.scheduled_time) throw error('El día o la hora de inicio no son válidos');
    const day = new Date(raw.start_date+'T12:00:00Z').getUTCDay();
    if (raw.include_weekends !== true && (day === 0 || day === 6)) throw error('Elige un día laborable o permite fines de semana');
    result.scheduled_at = start.toISOString();
    result.business_hours = { start_time:h.start_time, end_time:h.end_time, timezone:'Europe/Madrid',
      allowed_weekdays:raw.include_weekends === true ? [1,2,3,4,5,6,7] : [1,2,3,4,5] };
  } else {
    result.business_hours = {};
    result.scheduled_at = null;
  }
  return result;
}

function assertQueue(list, scope, isReview, allowTerminal = false) {
  if (!list || !isReview(list) || (!allowTerminal && (TERMINAL.includes(String(list.status)) || TERMINAL.includes(String(list.criteria?.dispatch?.status))))) throw error('Esta cola de reseñas ya no admite cambios de programación',409);
  const ids = [...new Set([list.clinica_id,...(Array.isArray(list.clinic_ids) ? list.clinic_ids : [])].map(Number).filter(Boolean))];
  if (!ids.length || !ids.every(id => (scope.clinicIds || []).includes(id))) throw error('Necesitas acceso a todas las clínicas de esta cola',403);
  return ids;
}

module.exports = { normalize, pick, LIVE, TERMINAL, assertQueue };
