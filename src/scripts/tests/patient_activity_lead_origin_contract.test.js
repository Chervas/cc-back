'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../controllers/paciente.controller.js'),
  'utf8',
);

assert.match(source, /'lead_intake_id'/);
assert.match(source, /model:\s*LeadIntake,[\s\S]*as:\s*'lead'/);
assert.match(source, /Math\.abs\(appointmentCreatedAt\.getTime\(\) - patientCreatedAt\.getTime\(\)\) <= 10 \* 60 \* 1000/);
assert.match(source, /Paciente creado al agendar una cita desde \$\{sourceLabel\}/);
assert.match(source, /id: `patient-created-legacy-\$\{pacienteId\}`/);

console.log('patient activity lead origin contract: ok');
