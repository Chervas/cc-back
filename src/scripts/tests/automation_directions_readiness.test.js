'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { usesClinicDirections, directionsReadiness } = require('../../lib/automation-directions-readiness');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

test('both appointment reminders expose location requirements, including catalog-bound sends', () => {
  for (const template_name of ['clinicaclick_recordatorio_mismo_dia', 'clinicaclick_recordatorio_dia_antes']) {
    assert.equal(usesClinicDirections({ nodes: [{ type: 'action/send_whatsapp', config: { template_name } }] }), true);
  }
  assert.equal(usesClinicDirections({ nodes: [{ type: 'action/send_whatsapp', config: { variables: { 4: '{{clinica.url_como_llegar}}' } } }] }), true);
  assert.equal(usesClinicDirections({ nodes: [{ type: 'condition/ai', config: { prompt: 'clinica.url_como_llegar' } }] }), false);
  assert.equal(usesClinicDirections({ nodes: [] }), false);
  for (const nodes of [null, {}, 'legacy malformed graph', [null]]) {
    assert.equal(usesClinicDirections({ nodes }), false);
  }
});

test('only an identified connected location is ready; warnings never imply a WhatsApp block', () => {
  assert.deepEqual(directionsReadiness({}, {}, { place_id: 'ChIJ-test' }), { status: 'ready', reason: null });
  assert.equal(directionsReadiness({ direccion: 'Calle 1' }, {}, {}).reason, 'profile_location_unverified');
  assert.equal(directionsReadiness({ direccion: 'Calle 1' }, null, {}).reason, 'address_fallback');
  assert.equal(directionsReadiness({ nombre_clinica: 'Centro' }, null, {}).reason, 'location_missing');
  assert.equal(directionsReadiness({ url_ficha_local: 'https://maps.google.com/test' }, null, {}).reason, 'location_missing');
});

test('list readiness batches local reads once, keeps scopes separate and never changes activation', async () => {
  const calls = [];
  const models = { Clinica: { findAll: async options => { calls.push(options); return [{ id_clinica: 1, direccion: 'Calle 1' }, { id_clinica: 2 }]; } },
    ClinicBusinessLocation: { findAll: async options => { calls.push(options); return []; } } };
  const service = loadSource('automationDirectionsReadiness.service', { '../../models': models,
    '../lib/automation-directions-readiness': require('../../lib/automation-directions-readiness'),
    './googleLocalLinks.service': { buildLinksFromBusinessLocation: () => { throw Error('no connected profile'); } } });
  const row = id => ({ clinic_id: id, is_active: true, nodes: [{ type: 'action/send_whatsapp', config: { template_name: 'clinicaclick_recordatorio_mismo_dia' } }] });
  const states = await service.forTemplates([row(1), row(2), row(1)]);
  assert.equal(calls.length, 2); assert.deepEqual(Array.from(calls[0].where.id_clinica), [1,2]);
  assert.equal(service.decorate(row(1), row(1), states).directions_readiness.reason, 'address_fallback');
  assert.equal(service.decorate(row(2), row(2), states).directions_readiness.reason, 'location_missing');
  assert.equal(service.decorate(row(1), row(1), states).is_active, true);
  assert.equal(service.decorate(row(0), row(0), states).directions_readiness, undefined);
  const before = calls.length; await service.forTemplates([{ clinic_id: 1, nodes: [] }]); assert.equal(calls.length, before);
});
