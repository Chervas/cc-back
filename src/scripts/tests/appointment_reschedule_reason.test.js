'use strict';

const assert = require('node:assert/strict');
const runtime = require('../../services/appointmentAutomationV2Runtime.service');

assert.equal(
  runtime.isRescheduleTemplateEligible({ trigger_config: null }, { reschedule_reason: 'clinic_schedule' }),
  true,
  'los flujos históricos siguen atendiendo cambios por agenda'
);
assert.equal(
  runtime.isRescheduleTemplateEligible({ trigger_config: null }, { reschedule_reason: 'patient_request' }),
  false,
  'un cambio pedido por el paciente no debe disparar el aviso histórico'
);
assert.equal(
  runtime.isRescheduleTemplateEligible(
    { trigger_config: { reschedule_reasons: ['patient_request'] } },
    { reschedule_reason: 'patient_request' }
  ),
  true,
  'el flujo específico atiende la petición del paciente'
);

console.log('appointment_reschedule_reason.test.js: OK');
process.exit(0);
