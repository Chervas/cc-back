'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { publishLeadCreated, publishLeadDirectorAlert } = require('../../services/leadCreatedRealtime.service');
const { packetFor } = require('../../lib/socket-payload');
const { createPolicy } = require('../../services/socketAccess.service');
const { TEMPORARY_FOCUSED_ACCOUNT, TEMPORARY_DIRECTOR_CLINICS } = require('../../lib/temporary-quickchat-focus');

test('native reception publishes only identifiers to the recipient clinic using the existing guarded packet', () => {
  const sent = [];
  const result = { duplicate: false, lead: { id: 7, clinica_id: 66, nombre: 'Private', telefono: 'private', grupo_clinica_id: 29 } };
  const getIO = () => ({ to: room => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) });
  assert.equal(publishLeadCreated(result, { getIO, alertDirector: false }), true);
  assert.deepEqual(sent, [{ room: 'clinic:66', event: 'lead:created', payload: { type: 'created', lead_id: 7, clinic_id: 66 } }]);
  assert.deepEqual(packetFor(sent[0].event, sent[0].payload).body, sent[0].payload);
});

test('each new lead can alert the clinic director with a closed personal packet, independent of source', async () => {
  const sent = [];
  const io = { to: room => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) };
  const directorFor = async lead => ({ id: lead.clinica_id + 100 });
  for (const [index, source] of ['web', 'meta_ads', 'google_ads', 'whatsapp', 'bulk_email', 'bulk_whatsapp', 'direct'].entries()) {
    assert.equal(await publishLeadDirectorAlert({ id: index + 1, clinica_id: 66, source, nombre: 'Private' }, { io, directorFor }), true);
  }
  assert.equal(sent.length, 7);
  assert.equal(sent[0].room, 'user:166');
  assert.equal(sent[0].event, 'lead:created');
  assert.deepEqual(packetFor(sent[0].event, { ...sent[0].payload, source: { secret: 'Private' } }).body,
    { type: 'created', lead_id: 1, clinic_id: 66, director_alert: true });
  assert.equal(packetFor('lead:created', { lead_id: 1, director_alert: true }), null);
  assert.equal(await publishLeadDirectorAlert({ id: 1, clinica_id: 66 }, { io, directorFor: async () => null }), false);
  assert.equal(sent.length, 7);
});

test('shared reception starts the alert once and keeps live list refreshes for historical recovery', () => {
  const rooms = [];
  const getIO = () => ({ to: room => ({ emit: () => rooms.push(room) }) });
  let alerts = 0;
  const options = { getIO, publishDirector: () => alerts++ };
  const result = { lead: { id: 7, clinica_id: 66 } };
  assert.equal(publishLeadCreated(result, options), true);
  assert.equal(publishLeadCreated({ ...result, duplicate: true }, options), false);
  assert.equal(publishLeadCreated(result, { ...options, alertDirector: false }), true);
  assert.equal(alerts, 1);
  assert.deepEqual(rooms, ['clinic:66', 'clinic:66']);
});

test('the socket rechecks the actual clinic, permissions and expected director on delivery', async () => {
  const clinicId = TEMPORARY_DIRECTOR_CLINICS[0];
  const temporary = TEMPORARY_FOCUSED_ACCOUNT;
  let expectedDirector = 501;
  let allowSensitive = true;
  const savedLead = { id: 1, clinica_id: clinicId, archived_at: null };
  const policy = createPolicy({
    models: {
      LeadIntake: { findByPk: async () => savedLead },
      Clinica: { findByPk: async id => ({ id_clinica: id }) },
      PatientDirectionSetting: { findOne: async () => expectedDirector ? { director_user_id: expectedDirector } : null },
      Usuario: { findByPk: async id => ({ id_usuario: id, email_usuario: temporary.email }) },
    },
    isAdmin: () => false,
    canAccess: async ({ featureKey }) => featureKey !== 'leads.sensitive.view' || allowSensitive,
  });
  const packet = packetFor('lead:created', { lead_id: 1, clinic_id: clinicId, director_alert: true });
  assert.equal(await policy.authorize(501, await policy.resolve(packet)), true);
  assert.equal(await policy.authorize(502, await policy.resolve(packet)), false);
  expectedDirector = null;
  assert.equal(await policy.authorize(501, await policy.resolve(packet)), false);
  assert.equal(await policy.authorize(temporary.userId, await policy.resolve(packet)), true);
  allowSensitive = false;
  assert.equal(await policy.authorize(temporary.userId, await policy.resolve(packet)), false);
  assert.equal(await policy.resolve({ ...packet, body: { ...packet.body, clinic_id: clinicId + 1 } }), null);
  savedLead.archived_at = new Date();
  assert.equal(await policy.resolve(packet), null);
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
