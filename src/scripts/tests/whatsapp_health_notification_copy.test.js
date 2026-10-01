'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthTransitionContent } = require('../../lib/whatsappHealthNotification');

test('a lost phone access alert states the exact evidence without claiming a ban or missing card', () => {
  const content = buildHealthTransitionContent({asset:{metaAssetName:'+34 600 000 401'},
    health:{reason_code:'provider_phone_unavailable'},blocked:true});
  assert.match(content.detail,/100\/33/); assert.match(content.detail,/\+34600000401/);
  assert.match(content.action,/reconectar el permiso/);
  assert.doesNotMatch(content.detail,/banead|tarjeta|131042/);
});

test('payment alerts name the emitter and confirmed error without guessing card failure', () => {
  const content = buildHealthTransitionContent({
    asset: { metaAssetName: '+34 618 12 77 29' },
    health: { reason_code: 'meta_error_131042_payment_missing' }, blocked: true,
    paymentHref: 'https://business.facebook.com/latest/billing_hub/accounts/details/?asset_id=358450834017696',
  });
  assert.match(content.detail, /\+34618127729/);
  assert.match(content.detail, /problema de pago.*131042/);
  assert.match(content.detail, /No confirma que falte la tarjeta/);
  assert.match(content.action, /^Revisar pagos en Meta: https:\/\/business.facebook.com\//);
  assert.doesNotMatch(content.action, /apelaci|Clinicaclick|\/ajustes/);
  assert(content.detail.length <= 500); assert(content.action.length <= 220);
});

test('payment recovery states the evidence and never promises retries or campaign activation', () => {
  const input = {
    asset: { metaAssetName: '+34 618 12 77 29', additionalData: { payment: { last_success_status: 'delivered' } } },
    health: { reason_code: 'provider_connected', source: 'secure_inbox_status_payment_recovered' },
    previousReason: 'meta_error_131042_payment_missing', blocked: false,
  };
  const confirmed = buildHealthTransitionContent(input);
  assert.match(confirmed.detail, /mensaje posterior al error de pago 131042/);
  assert.match(confirmed.action, /manualmente.*campa\u00f1as pausadas/);
  assert.match(confirmed.action, /No se reenv\u00edan mensajes fallidos/);
  input.health.source = 'whatsapp_phone_poll';
  assert.match(buildHealthTransitionContent(input).detail, /no acredita.*m\u00e9todo de pago/);
  input.health.source = 'secure_inbox_status_payment_recovered';
  input.asset.additionalData.payment.last_success_status = 'failed';
  assert.match(buildHealthTransitionContent(input).detail, /no acredita.*m\u00e9todo de pago/);
});

test('offboarding and local deactivation are distinct from Meta bans', () => {
  const offboarded = buildHealthTransitionContent({ health: { reason_code: 'account_event_account_offboarded' }, blocked: true });
  assert.match(offboarded.detail, /ACCOUNT_OFFBOARDED/);
  assert.match(offboarded.detail, /No significa por s\u00ed solo.*baneado/);
  assert.match(offboarded.action, /Reconectar el permiso/);
  const inactive = buildHealthTransitionContent({ health: { reason_code: 'asset_inactive' }, blocked: true });
  assert.match(inactive.detail, /desactivado en Clinicaclick/);
  assert.doesNotMatch(inactive.detail, /Meta ha/);
});

test('unknown causes and untrusted strings never expose raw provider data', () => {
  const privateText = 'SECRET_PROVIDER_BODY_123';
  const content = buildHealthTransitionContent({
    asset: { metaAssetName: privateText }, health: { reason_code: privateText }, blocked: true,
  });
  assert.match(content.detail, /no se ha identificado una causa concreta/);
  assert.doesNotMatch(JSON.stringify(content), new RegExp(privateText));
});
