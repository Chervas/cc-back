'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('native propagation skips historical backfill only when explicitly requested', async () => {
  const source = fs.readFileSync(require.resolve('../../services/automationDefaults.service'), 'utf8');
  const body = source.slice(source.indexOf('async function propagateCatalogAutomationToClinics('),
    source.indexOf('\nasync function enqueueDefaultAutomations('));
  const calls = [];
  const sandbox = {
    AutomationFlowCatalog:{findByPk:async()=>({id:11,is_generic:true,disciplinas:[]})},
    AutomationFlowCatalogDiscipline:{}, Clinica:{findAll:async()=>[{id_clinica:35},{id_clinica:66}]},
    normalizeDisciplines:()=>[], ensureCatalogTemplateForClinic:async(options)=>{
      calls.push(options); return {status:'updated'};
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);
  for (const options of [{catalogId:11},{catalogId:11,backfillScheduled:false}]) {
    calls.length = 0;
    const result = await sandbox.propagateCatalogAutomationToClinics(options);
    assert.equal(result.updated, 2);
    assert.equal(result.failed, 0);
    assert(calls.every((call)=>call.backfillScheduled === (options.backfillScheduled !== false)));
  }
});
