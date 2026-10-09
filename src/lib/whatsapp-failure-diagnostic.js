'use strict';
// Public, bounded diagnostics only. Never expose transport/SQL errors or infer
// a past appointment from the generic authorization wrapper.
const REASONS = new Set(['whatsapp_appointment_past', 'whatsapp_appointment_provisional',
  'whatsapp_appointment_status_ineligible', 'whatsapp_appointment_start_invalid', 'whatsapp_appointment_rescheduled',
  'whatsapp_appointment_care_stage_ineligible', 'whatsapp_appointment_import_held', 'whatsapp_appointment_scope_changed',
  'whatsapp_appointment_suppressed', 'whatsapp_appointment_already_confirmed', 'whatsapp_appointment_wrong_day',
  'whatsapp_patient_import_held', 'whatsapp_automation_scope_changed', 'whatsapp_inbox_reception_delayed']);
function reasonCode(error) {
  for (const value of [error?.details?.reason_code, error?.reason_code, error?.code]) if (REASONS.has(value)) return value;
  return null;
}
function diagnosticMetadata(error) {
  const code = reasonCode(error);
  return code ? { technical_failure_reason_code: code } : {};
}
module.exports = { reasonCode, diagnosticMetadata };
