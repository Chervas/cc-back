'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveOperationalSubroleTargets,
} = require('../../services/flowEngineV2.service');

assert.deepEqual(
  resolveOperationalSubroleTargets('Recepción / Comercial ventas'),
  ['Recepción / Comercial ventas', 'Administrativos', 'Auxiliares y enfermeros'],
);
assert.deepEqual(
  resolveOperationalSubroleTargets('Administrativos'),
  ['Administrativos', 'Recepción / Comercial ventas'],
);
assert.deepEqual(resolveOperationalSubroleTargets('Doctores'), ['Doctores']);

const intakeSource = fs.readFileSync(
  path.resolve(__dirname, '../../controllers/intake.controller.js'),
  'utf8',
);
assert.doesNotMatch(
  intakeSource,
  /hasActiveAppointment\s*\?\s*0\s*:\s*\(pendingState\?\.count/,
  'una cita activa no debe ocultar una respuesta pendiente del paciente',
);
assert.match(
  intakeSource,
  /pending_automation_attention:\s*pendingState\?\.requiresAutomationAttention === true/,
);

require('../../../models').sequelize.close()
  .then(() => {
    console.log('automation operational assignees contract: ok');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
