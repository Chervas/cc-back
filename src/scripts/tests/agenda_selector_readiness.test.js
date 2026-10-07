'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Op = require('sequelize').Op;
const scope = require('../../lib/agenda-read-scope');
const flexible = require('../../lib/flexible-agenda');
const plain = value => JSON.parse(JSON.stringify(value));
function controller(file, db, deps = {}) {
  const context = { exports: {}, require: name => {
    if (name === 'express-async-handler') return fn => fn;
    if (name === '../../models') return db;
    if (name === '../lib/agenda-read-scope') return scope;
    if (name === '../lib/flexible-agenda') return flexible;
    if (name === '../lib/role-helpers') return { STAFF_ROLES: ['Personal de clínica'] };
    return deps[name] || {};
  }};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../controllers', file), 'utf8'), context);
  return context.exports;
}
test('agenda selector uses only an active, receiving flexible membership in the authorized clinic', async () => {
  const rows = [
    { doctor_id:50, clinica_id:72, activo:1, recibe_citas:1, agenda_flexible:1 },
    { doctor_id:50, clinica_id:66, activo:1, recibe_citas:1, agenda_flexible:0 },
    { doctor_id:142, clinica_id:66, activo:1, recibe_citas:0, agenda_flexible:1 },
    { doctor_id:143, clinica_id:66, activo:0, recibe_citas:1, agenda_flexible:1 },
  ].map(row => ({ ...row, horarios:[], clinica:{ id_clinica:row.clinica_id, horarios:[{id:1}] } }));
  let query, result;
  const db = { Sequelize:{Op,literal:value=>value}, sequelize:{escape:JSON.stringify},
    DoctorClinica:{findAll:async options=>{query=options;return rows;}} };
  const c=controller('doctores.controller.js',db);
  await c.list({query:{agenda_context:'true'},authorizedDoctorClinicIds:[66,72]}, {json:value=>{result=value;}});
  assert.deepEqual(plain(query.where.clinica_id[Op.in]),[66,72]);
  assert.deepEqual(plain(result.map(row=>[row.id,row.clinica_id,row.agenda_flexible,row.agendable])),
    [['50','72',true,true],['50','66',false,false],['142','66',false,false],['143','66',false,false]]);
  rows[0].clinica.horarios=[];
  await c.list({query:{agenda_context:'true'},authorizedDoctorClinicIds:[72]}, {json:value=>{result=value;}});
  assert.equal(result[0].agendable,false,'clinic timetable readiness remains required');
  const before=query;
  await c.list({query:{agenda_context:'true'},authorizedDoctorClinicIds:[]}, {json:value=>{result=value;}});
  assert.equal(result.length,0); assert.equal(query,before,'no query outside authorized scope');
});
test('room display metadata is one bounded batch, available on empty calendar days and restricted to authorized resources', async () => {
  let calls=0, aliasesQuery, query, result;
  const rooms=[{id:79,activo:true,clinica_id:66},{id:80,activo:true,clinica_id:72},{id:81,activo:false,clinica_id:72}];
  const db={Sequelize:{Op},Instalacion:{findAll:async options=>{query=options;return rooms.map(row=>({...row,toJSON:()=>row}));}},
    InstallationPhysicalAlias:{findAll:async options=>{calls++;aliasesQuery=options;return [
      {installation_id:79,canonical_installation_id:80,group_id:29},
      {installation_id:99,canonical_installation_id:80,group_id:29},
    ];}}};
  const c=controller('instalaciones.controller.js',db,{'../lib/access-policy':{
    getAccessibleClinicIdsForFeature:async args=>{assert.deepEqual(plain(args.clinicIds),[66,72]);return [66,72];}
  }});
  await c.list({query:{clinica_id:'66,72'},userData:{userId:1}}, {json:value=>{result=value;}});
  assert.deepEqual(plain(query.where.clinica_id[Op.in]),[66,72]);
  assert.equal(calls,1);assert.deepEqual(plain(aliasesQuery.where.installation_id[Op.in]),[79,80]);
  assert.deepEqual(plain(result.map(row=>row.agenda_physical_alias_ids)),[[80,79],[80,79],[81]]);
  assert.ok(result.every(row=>!row.agenda_physical_alias_ids.includes(99)));
});
