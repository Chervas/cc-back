'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requireExpectedVersion,assertCurrentVersion}=require('../../lib/clinical-report-version');
test('explicit version zero is only the first save; positive integer version matches the stored row',()=>{
 assert.equal(requireExpectedVersion({expected_version:0}),0);assertCurrentVersion(0,null);
 assertCurrentVersion(2,{version_number:2});assertCurrentVersion(2,{version_number:'2'});
});
for(const value of [undefined,null,'',false,'0','1',-1,1.2,Infinity,NaN,{},[],Number.MAX_SAFE_INTEGER+1]){
 test('invalid expected version '+String(value)+' fails closed',()=>assert.throws(()=>requireExpectedVersion({expected_version:value}),{statusCode:428,code:'clinical_report_version_required'}));
}
test('stale creation, edition, finalization and reopen all use the same compare-and-save contract',()=>{
 for(const [expected,row]of [[0,{version_number:1}],[1,{version_number:2}],[2,{version_number:1}],[1,null]]){
  assert.throws(()=>assertCurrentVersion(expected,row),e=>e.statusCode===409&&e.code==='clinical_report_version_conflict'&&e.details.expected_version===expected);
 }
});
