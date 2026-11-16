'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {argumentsOf}=require('../arriaga-site-attribution-repair');
test('explicit readonly plan and exact approved apply commands parse without opening a connector',()=>{
 const p=argumentsOf(['--mode','plan','--target','crm','--bundle','/private/original bundle.json','--out','/private/repair','--actor-id','1']);assert.equal(p.mode,'plan');assert.equal(p.target,'crm');
 const a=argumentsOf(['--mode','apply','--target','crm','--bundle','/private/bundle.json','--out','/private/run','--plan','/private/plan.json','--approve-plan','a'.repeat(64)]);assert.equal(a['approve-plan'],'a'.repeat(64));
});
test('unknown modes, targets, flags, duplicate flags and relative paths are refused',()=>{
 for(const args of [['--mode','apply','--target','prod','--bundle','/a','--out','/b'],['--mode','repair','--target','crm','--bundle','/a','--out','/b'],['--mode','plan','--target','crm','--bundle','a','--out','/b'],['--mode','plan','--mode','apply','--target','crm','--bundle','/a','--out','/b'],['--mode','plan','--target','crm','--bundle','/a','--out','/b','--unsafe','yes']])assert.throws(()=>argumentsOf(args),{safeCode:'ARRIAGA_REPAIR_ARGUMENTS'});
});
