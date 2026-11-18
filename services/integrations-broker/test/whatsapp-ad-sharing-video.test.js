'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/whatsapp-authorized-contract');

const raw = format => ({ id: '501', name: 'clinicaclick_compartir_promocion_video', language: 'es', status: 'APPROVED',
  components: [{ type: 'HEADER', format }, { type: 'BODY', text: 'Hola {{1}}, promoción de {{2}}: {{3}}.' }] });
const message = kind => ({ messaging_product: 'whatsapp', to: '34000000123', type: 'template', template: {
  name: 'clinicaclick_compartir_promocion_video', language: { code: 'es' }, components: [
    { type: 'header', parameters: [{ type: kind, [kind]: { link: 'https://video.cdninstagram.com/original.mp4' } }] },
    { type: 'body', parameters: ['Alex', 'Clinic', 'Original text'].map(text => ({ type: 'text', text })) },
  ] } });

test('native VIDEO header validates unchanged HTTPS payload and the same approved content pin', () => {
  const definition = raw('VIDEO'); const input = message('video');
  assert.equal(C.validateMessage(input), input);
  const pin = { id: definition.id, name: definition.name, language: 'es', contentDigest: C.templateDigest(definition) };
  assert.equal(C.verifyTemplate(definition, pin, input), true);
  assert.notEqual(C.templateDigest(raw('IMAGE')), pin.contentDigest);
  definition.components[0].example = { header_handle: ['provider example'] };
  assert.equal(C.templateDigest(definition), pin.contentDigest);
});

test('IMAGE/VIDEO mismatches, unapproved source and insecure media stay denied', () => {
  for (const [format, kind] of [['IMAGE', 'video'], ['VIDEO', 'image']]) {
    const definition = raw(format); const pin = { id: definition.id, name: definition.name, language: 'es', contentDigest: C.templateDigest(definition) };
    assert.throws(() => C.verifyTemplate(definition, pin, message(kind)), { code: 'operation_denied' });
    assert.throws(() => C.verifyTemplate({ ...definition, status: 'PENDING' }, pin, message(kind)), { code: 'operation_denied' });
  }
  const input = message('video'); input.template.components[0].parameters[0].video.link = 'http://example.invalid/video.mp4';
  assert.throws(() => C.validateMessage(input), { code: 'invalid_request' });
  const injected = message('video'); injected.template.components[0].parameters[0].video.caption = 'Forbidden extra field';
  assert.throws(() => C.validateMessage(injected), { code: 'invalid_request' });
  const freeVideo = { messaging_product: 'whatsapp', to: '34000000123', type: 'video', video: { link: 'https://video.cdninstagram.com/original.mp4' } };
  assert.throws(() => C.validateMessage(freeVideo), { code: 'invalid_request' });
});
