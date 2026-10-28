'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const icons = require('../../lib/installation-icons');
const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/instalaciones.controller.js'), 'utf8');
const modelSource = fs.readFileSync(path.resolve(__dirname, '../../../models/instalacion.js'), 'utf8');

function fixture(initialIcon = null) {
  const calls = [], transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const row = { id: 9, clinica_id: 72, nombre: 'C3 · Consulta', tipo: 'consulta', icono: initialIcon,
    capacidad: 1, allow_overlap_confirmation: false, overlap_capacity_unlimited: false, activo: true,
    profesionales_permitidos: [53], descripcion: 'Keep', piso: 'One', color: '#ffffff',
    reload: async () => { calls.push('reload'); return row; },
    update: async (data, options) => { assert.equal(options.transaction, transaction); calls.push('update'); Object.assign(row, data); return row; },
    toJSON: () => ({ ...row }) };
  const db = { Sequelize: { Op: Object.fromEntries(['ne','in','or','lt','gt'].map(key => [key,Symbol(key)])) },
    Instalacion: {
      findByPk: async () => row,
      create: async data => { calls.push('create'); Object.assign(row,data); return row; },
    }, InstalacionHorario: { bulkCreate: async () => { calls.push('hours-write'); } },
    sequelize: { transaction: async mutate => { calls.push('transaction'); return mutate(transaction); } },
  };
  const exports = {};
  const mocks = {
    'express-async-handler': fn => fn, '../../models': db,
    '../services/appointmentCalendarMutation.service': {
      withCalendarMutation: async ({mutate}) => { calls.push('calendar-mutation'); return mutate(transaction); }, sendCalendarMutationError: () => false },
    '../lib/access-policy': { assertUserCanAccessFeature: async data => { assert.equal(data.actorId,1); assert.equal(data.clinicId,72); calls.push('authorize'); }, getAccessibleClinicIdsForFeature: async () => [72] },
    '../lib/installation-icons': icons,
    '../lib/installation-professionals': require('../../lib/installation-professionals'),
    '../lib/installation-overlap': require('../../lib/installation-overlap'),
    '../lib/agenda-read-scope': {}, '../services/installationPhysicalSharing.service': {},
    '../lib/personal-block-scope': {}, '../lib/availability-calendar': {}, '../lib/personal-schedule-recurring': {},
  };
  vm.runInNewContext(source, { exports, console: { error: () => assert.fail('Unexpected controller error') },
    require: name => Object.hasOwn(mocks,name) ? mocks[name] : require(name) });
  const response = { statusCode: 200, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; } };
  const request = body => ({ params:{id:'9'}, body, userData:{userId:1} });
  return { row,calls,response,request,exports };
}

test('only registered canonical symbol identifiers are accepted; empty selection clears', () => {
  for (const value of icons.INSTALLATION_ICONS) assert.equal(icons.normalizeInstallationIcon(value),value);
  for (const value of [undefined,null,'']) assert.equal(icons.normalizeInstallationIcon(value),null);
  for (const value of ['https://example.invalid/a.svg','javascript:x','<svg/>','other:heart','heroicons_outline:missing',{},[],3,true]) {
    assert.throws(() => icons.normalizeInstallationIcon(value), {status:400,code:'installation_icon_invalid'});
  }
});
test('an icon persists through the ordinary create/get response without changing resource rules', async () => {
  const f=fixture();await f.exports.create(f.request({clinica_id:72,nombre:'C3',tipo:'consulta',icono:'heroicons_outline:heart'}),f.response);
  assert.equal(f.response.statusCode,201);assert.equal(f.response.body.icono,'heroicons_outline:heart');
  assert.equal(f.response.body.clinica_id,72);assert.equal(f.response.body.capacidad,1);
});
test('ordinary update preserves an omitted icon and the permitted-professional list', async () => {
  const f=fixture('heroicons_outline:heart');await f.exports.update(f.request({nombre:'C3 updated'}),f.response);
  assert.equal(f.response.statusCode,200);assert.equal(f.row.icono,'heroicons_outline:heart');assert.deepEqual(f.row.profesionales_permitidos,[53]);
  assert(!f.calls.includes('hours-write'));
});
test('a legacy null icon can be chosen and explicitly returned to the type default', async () => {
  const f=fixture();await f.exports.update(f.request({icono:'heroicons_outline:beaker'}),f.response);assert.equal(f.row.icono,'heroicons_outline:beaker');
  await f.exports.update(f.request({icono:null}),f.response);assert.equal(f.row.icono,null);assert(!f.calls.includes('hours-write'));
});
test('invalid icons return 400 before any create/update or calendar transaction', async () => {
  for (const method of ['create','update']) {
    const f=fixture('heroicons_outline:heart');await f.exports[method](f.request({clinica_id:72,nombre:'C3',tipo:'consulta',icono:'https://bad.invalid/x.svg'}),f.response);
    assert.equal(f.response.statusCode,400);assert.equal(f.response.body.code,'installation_icon_invalid');assert.equal(f.row.icono,'heroicons_outline:heart');
    assert.deepEqual(f.calls,['authorize']);
  }
});
test('the additive migration requires both presentation columns and protects selected data on rollback', async () => {
  const name='20261028150000-add-room-icons.js', migration=require('../../../migrations/'+name), additions=[],drops=[];
  const qi={addColumn:async(...data)=>additions.push(data),removeColumn:async(...data)=>drops.push(data),sequelize:{query:async sql=>[[{n:sql.includes('Usuarios')?1:0}]]}};
  await migration.up(qi,{STRING:n=>({string:n})});assert.deepEqual(additions.map(row=>[row[0],row[1],row[2].type.string,row[2].allowNull,row[2].defaultValue]),[
    ['Instalaciones','icono',96,true,null],['Usuarios','tratamiento_profesional',8,true,null] ]);
  await assert.rejects(migration.down(qi),/rollback_requires_cleared_preferences/);assert.equal(drops.length,0);
  qi.sequelize.query=async()=>[[{n:0}]];await migration.down(qi);assert.deepEqual(drops,[['Instalaciones','icono'],['Usuarios','tratamiento_profesional']]);
  const contract=require('../../../ops/security/schema-contract.json');assert.equal(contract.tables.Instalaciones.columns.find(c=>c.COLUMN_NAME==='icono').COLUMN_TYPE,'varchar(96)');
  assert.equal(contract.tables.Usuarios.columns.find(c=>c.COLUMN_NAME==='tratamiento_profesional').COLUMN_TYPE,'varchar(8)');
  assert.equal(contract.migrations.find(m=>m.name===name).sha256,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../../migrations',name))).digest('hex'));
  assert.match(modelSource,/icono:\s*\{ type: DataTypes\.STRING\(96\), allowNull: true/);
});
