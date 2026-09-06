'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

const controllerSource = fs.readFileSync(
  path.resolve(__dirname, '../../controllers/citas.controller.js'),
  'utf8'
);
const rescheduleCancellation = controllerSource.match(
  /cancelActiveExecutionsForCita\(cita, \{\s*reason: 'appointment_rescheduled_cancelled_previous_active_flow',[\s\S]*?\}\);/
);
assert.ok(rescheduleCancellation, 'la reprogramación debe cancelar los flujos anteriores de la cita');
assert.doesNotMatch(
  rescheduleCancellation[0],
  /exclude_trigger_types/,
  'una nueva reprogramación también debe cancelar reprogramaciones anteriores que sigan esperando'
);

console.log('appointment_reschedule_reason.test.js: OK');
process.exit(0);
