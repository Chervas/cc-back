'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { publishLeadCreated } = require('../../services/leadCreatedRealtime.service');
const { packetFor } = require('../../lib/socket-payload');

test('native reception publishes only identifiers to the recipient clinic using the existing guarded packet', () => {
  const sent = [];
  const result = { duplicate: false, lead: { id: 7, clinica_id: 66, nombre: 'Private', telefono: 'private', grupo_clinica_id: 29 } };
  const getIO = () => ({ to: room => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) });
  assert.equal(publishLeadCreated(result, { getIO }), true);
  assert.deepEqual(sent, [{ room: 'clinic:66', event: 'lead:created', payload: { type: 'created', lead_id: 7, clinic_id: 66 } }]);
  assert.deepEqual(packetFor(sent[0].event, sent[0].payload).body, sent[0].payload);
});
test('duplicates, archived leads and invalid recipient identifiers never notify browsers', () => {
  for (const result of [{ duplicate: true, lead: { id: 7, clinica_id: 66 } },
    { lead: { id: 7, clinica_id: 66, archived_at: '2026-11-10' } },
    { lead: { id: 7, grupo_clinica_id: 29 } }, { lead: { id: 0, clinica_id: 66 } }]) {
    assert.equal(publishLeadCreated(result, { getIO: () => assert.fail('must not publish') }), false);
  }
});
test('socket unavailability cannot fail an already committed reception', () => {
  let warnings = 0;
  assert.equal(publishLeadCreated({ lead: { id: 7, clinica_id: 66 } }, {
    getIO: () => { throw Error('private provider payload'); }, warn: () => warnings++,
  }), false);
  assert.equal(warnings, 1);
  assert.equal(publishLeadCreated({ lead: { id: 7, clinica_id: 66 } }, { getIO: () => null }), false);
});
