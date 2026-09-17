'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {readHealth}=require('../../lib/transportCertificateHealth');
const now=Date.parse('2026-09-17T18:00:00Z');
const healthy={version:1,checkedAt:new Date(now).toISOString(),certificates:['gateway','staging'].map(id=>({id,status:'healthy',expiresAt:'2026-10-15T04:04:15Z'}))};
function options(value=healthy){return {enabled:true,now,read:()=>JSON.stringify(value),stat:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o640,size:512})};}
test('healthy certificates do not generate alerts; disabled monitor does not read files',()=>{
  assert.deepEqual(readHealth(options()),[]);assert.deepEqual(readHealth({enabled:false,read:()=>{throw Error('must_not_read');}}),[]);
});
test('renewal failure yields a readable alert limited to the affected component',()=>{
  const value=structuredClone(healthy);value.certificates[0]={id:'gateway',status:'failed',reason:'not_output_verbatim'};
  const [alert]=readHealth(options(value));assert.equal(alert.entity_id,'gateway');assert.match(alert.detail,/conserva el certificado anterior/);
  assert(!alert.detail.includes('not_output_verbatim'));assert.equal(alert.measured,1);
});
test('stale, future, missing and unsafe status files alert instead of reporting health',()=>{
  for(const offset of [-37*3600000,120000]){const value={...healthy,checkedAt:new Date(now+offset).toISOString()};assert.equal(readHealth(options(value))[0].entity_id,'maintenance');}
  const o=options();o.read=()=>{throw Error('FILE_PATH_MUST_NOT_LEAK');};assert.equal(readHealth(o)[0].entity_id,'maintenance');
  for(const overrides of [{uid:1000},{mode:0o666},{size:20000},{isSymbolicLink:()=>true}]){
    const o=options();const base=o.stat();o.stat=()=>({...base,...overrides});assert.equal(readHealth(o)[0].entity_id,'maintenance');
  }
});
test('expiring and missing certificate validity alert, preserving healthy peers',()=>{
  for(const expiresAt of ['2026-09-20T00:00:00Z','bad']){
    const value=structuredClone(healthy);value.certificates[1].expiresAt=expiresAt;const result=readHealth(options(value));
    assert.equal(result.length,1);assert.equal(result[0].entity_id,'staging');
  }
});
