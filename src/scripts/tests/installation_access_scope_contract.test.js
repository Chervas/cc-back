#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controller = fs.readFileSync(
  path.resolve(__dirname, '../../controllers/instalaciones.controller.js'),
  'utf8'
);

assert.match(
  controller,
  /exports\.list[\s\S]*?accessibleClinicScope\(req, 'clinic\.settings\.view'[\s\S]*?clinica_id:[\s\S]*?Op\.in/,
  'installation lists must always be reduced to the actor clinic scope'
);
for (const handler of ['create', 'update', 'remove', 'putHorarios', 'createBloqueo', 'deleteBloqueo']) {
  const start = controller.indexOf(`exports.${handler} = asyncHandler`);
  const end = controller.indexOf('\nexports.', start + 1);
  assert.ok(start >= 0, `${handler} must exist`);
  const block = controller.slice(start, end >= 0 ? end : undefined);
  assert.match(
    block,
    /clinic\.settings\.edit/,
    `${handler} must enforce clinic.settings.edit`
  );
}
for (const handler of ['getById', 'getHorarios', 'getBloqueos']) {
  const start = controller.indexOf(`exports.${handler} = asyncHandler`);
  const end = controller.indexOf('\nexports.', start + 1);
  assert.ok(start >= 0, `${handler} must exist`);
  const block = controller.slice(start, end >= 0 ? end : undefined);
  assert.match(block, /clinic\.settings\.view/, `${handler} must enforce clinic.settings.view`);
}
assert.match(
  controller,
  /exports\.disponibilidad[\s\S]*?assertClinicFeature\(req, 'appointments\.view'/,
  'availability checks must not reveal resources outside the visible appointment scope'
);
assert.match(
  controller,
  /const installationClinicId = Number\(instData\.clinica_id\);[\s\S]*?assertClinicFeature\(req, 'appointments\.view', installationClinicId\)/,
  'availability must authorize the real installation clinic even when the query supplies another clinic'
);
assert.match(
  controller,
  /where: \{ doctor_id, clinica_id: accessClinicId \}/,
  'doctor assignment lookup must use the authorized clinic resolved from the request or installation'
);

console.log('installation access scope contract: ok');
