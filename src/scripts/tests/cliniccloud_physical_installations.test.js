'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { preparePhysicalInstallations, verifyPhysicalPackage } = require('../../lib/cliniccloud-import/physical-installations');
const base = () => ({ sources:[{path:'/private/excel',sha256:'a'.repeat(64)},{path:'/private/protocol',sha256:'b'.repeat(64)}],installations:[],aliases:[],groupId:29,target:'crm' });
test('documented physical rooms exclude unused C4/C5 and keep external hospital manual',()=>{
 const p=preparePhysicalInstallations(base());verifyPhysicalPackage(p);
 assert.equal(p.rows.length,16);assert(!p.rows.some(r=>['C4','C5'].includes(r.key)));
 assert(p.rows.every(r=>r.active===false&&r.capacity===1));
 assert.equal(p.rows.filter(r=>r.key==='C6').length,1);
 assert.equal(p.external_hospital,'manual_capacity_not_assumed');
});
test('shared clinic records have one canonical room and no duplicate capacity',()=>{
 const p=preparePhysicalInstallations(base());
 for(const key of ['C1','C3','C7','C10','C12']){
  const rows=p.rows.filter(r=>r.key===key);assert.equal(rows.length,2);assert(rows.every(r=>r.canonical_clinic_id===72));
 }
});
test('old virtual names are not evidence of the written physical room',()=>{
 const b=base();b.installations=[{id:32,clinica_id:72,nombre:'Cabina 4 (EMMS Y PRESOTERAPIAS)',activo:1}];
 const p=preparePhysicalInstallations(b);assert.deepEqual(p.before.installations,b.installations);assert.equal(p.existing_installations_changed,false);
});
test('existing physical name needs explicit review rather than duplicate creation',()=>{
 const b=base();b.installations=[{id:99,clinica_id:72,nombre:'C9 · Sala'}];
 assert.throws(()=>preparePhysicalInstallations(b),/ALREADY_PRESENT/);
});
test('rehashing a tampered package does not allow activation or arbitrary rows',()=>{
 const p=preparePhysicalInstallations(base());p.rows[0].active=true;const {package_sha256,...body}=p;p.package_sha256=hash(body);
 assert.throws(()=>verifyPhysicalPackage(p),/ROWS_CHANGED/);
});
test('only reviewed customer scope with source hashes is accepted',()=>{
 assert.throws(()=>preparePhysicalInstallations({...base(),target:'dev'}),/SCOPE/);
 assert.throws(()=>preparePhysicalInstallations({...base(),groupId:1}),/SCOPE/);
 assert.throws(()=>preparePhysicalInstallations({...base(),sources:[]}),/SOURCE/);
});
