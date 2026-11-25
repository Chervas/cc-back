'use strict';

function usesExplicitDispatchWindow(dispatch = {}) {
  const mode = String(dispatch.time_mode || dispatch.timeMode || '')
    .trim()
    .toLowerCase();
  return mode === 'specific_time';
}

function normalizeWhatsappDispatchWindow(window) {
  if (window?.mode === 'clinic_hours') return { mode: 'clinic_hours' };
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (window?.mode === 'custom' && typeof window.start_time === 'string' && typeof window.end_time === 'string'
    && clock.test(window.start_time) && clock.test(window.end_time)
    && window.start_time < window.end_time && typeof window.include_weekends === 'boolean') {
    const { start_time, end_time, include_weekends } = window;
    return { mode: 'custom', start_time, end_time, include_weekends };
  }
  throw Object.assign(new Error('Indica una ventana de WhatsApp con una hora de fin posterior a la de inicio.'), {
    status: 400, code: 'whatsapp_dispatch_window_invalid',
  });
}

module.exports = {
  usesExplicitDispatchWindow,
  normalizeWhatsappDispatchWindow,
};
