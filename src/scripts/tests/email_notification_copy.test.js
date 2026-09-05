'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260905114000-explain-email-delivery-notifications');

const bounce = migration._test.renderNotification(
  'email_bounces_7d',
  '1 rebote(s) registrado(s) en 7 dias.',
);
assert.equal(bounce.title, 'Correo no entregado');
assert.match(bounce.message, /no pudo entregarse/);
assert.doesNotMatch(JSON.stringify(bounce), /SES|rebote/i);

const blocked = migration._test.renderNotification(
  'email_active_suppressions',
  '3 destinatario(s) suprimidos.',
);
assert.equal(blocked.title, 'Direcciones bloqueadas para nuevos envíos');
assert.match(blocked.message, /3 direcciones/);
assert.doesNotMatch(JSON.stringify(blocked), /supresi/i);

assert.equal(migration._test.renderNotification('other', '1'), null);
console.log('email_notification_copy.test.js OK');
