'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8');

const controller = read('controllers/intake.controller.js');
const model = fs.readFileSync(path.resolve(__dirname, '../../../models/leadintake.js'), 'utf8');

const updateLeadStatus = controller.match(
  /exports\.updateLeadStatus = asyncHandler\(async \(req, res\) => \{[\s\S]*?\n\}\);\n\nexports\.registrarContacto/
)?.[0] || '';

assert.ok(updateLeadStatus, 'the lead status update handler must exist');
assert.match(
  updateLeadStatus,
  /status_lead === 'descartado' && !motivo_descarte/,
  'discarding a lead must require an explicit reason'
);
assert.match(
  updateLeadStatus,
  /if \(motivo_descarte !== undefined\) updatePayload\.motivo_descarte = motivo_descarte/,
  'the backend must persist the structured reason without relabelling it'
);
assert.match(
  updateLeadStatus,
  /raw_payload: \{ status_lead, notas_internas, asignado_a, motivo_descarte \}/,
  'the attribution audit must retain the discard reason for later optimization analysis'
);
assert.match(
  model,
  /motivo_descarte: \{ type: DataTypes\.STRING\(512\), allowNull: true \}/,
  'the lead model must retain structured reasons and optional explanatory notes'
);

console.log('lead_discard_reason_contract.test.js OK');
