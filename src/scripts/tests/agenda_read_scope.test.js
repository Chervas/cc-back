'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agendaClinicIds, agendaPeerClinicIds, agendaInstallationAliases } = require('../../lib/agenda-read-scope');
test('group read lists are strict and never collapse into a single clinic', () => {
  assert.deepEqual(agendaClinicIds('66,72'), [66,72]);
  assert.deepEqual(agendaClinicIds('72,66,72'), [72,66]);
  for (const value of ['66,no', '66,', '0', '66x', '1e2', '-1', '9007199254740992']) assert.throws(() => agendaClinicIds(value));
  assert.equal(agendaClinicIds('all'), null);
});
test('peer references stay inside the same group and the actor appointment view grant', async () => {
  const calls = [];
  const db = { Clinica: { findByPk: async () => ({ grupoClinicaId:29 }), findAll: async () => [{ id_clinica:66 },{ id_clinica:72 }] } };
  const authorize = async request => { calls.push(request); return [66,35]; };
  assert.deepEqual(await agendaPeerClinicIds({ db, actorId:10, clinicIds:[66], includePeers:true, authorize }), [66]);
  assert.equal(calls[0].featureKey, 'appointments.view');
  assert.deepEqual(calls[0].clinicIds, [66,72]);
  assert.deepEqual(await agendaPeerClinicIds({ db, actorId:10, clinicIds:[66,72], includePeers:true, authorize }), [66,72]);
  assert.equal(calls.length, 1, 'explicit groups are never expanded');
  assert.deepEqual(await agendaPeerClinicIds({ db, actorId:10, clinicIds:[66], includePeers:true, authorize: async () => [66,72] }), [66,72]);
});
test('physical room aliases require explicit evidence and visible canonical resources', () => {
  const rows = [{ installation_id:79, canonical_installation_id:80, group_id:29 }, { installation_id:90, canonical_installation_id:80, group_id:29 }];
  assert.deepEqual(agendaInstallationAliases(rows, [79,80]), { 79:[80,79], 80:[80,79] });
  assert.deepEqual(agendaInstallationAliases(rows, [79]), {});
});
