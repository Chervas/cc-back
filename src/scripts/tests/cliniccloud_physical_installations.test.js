'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { preparePhysicalInstallations, verifyPhysicalPackage } = require('../../lib/cliniccloud-import/physical-installations');
const base = () => ({ sources:[{path:'/private/excel',sha256:'a'.repeat(64)},{path:'/private/protocol',sha256:'b'.repeat(64)}],installations:[],aliases:[],groupId:29,target:'crm' });
test('documented physical rooms exclude unused C4/C5 and keep external hospital manual',()=>{
 const p=preparePhysicalInstallations(base());verifyPhysicalPackage(p);
 assert.equal(p.rows.length,18);assert.equal(p.additions.length,18);assert(!p.rows.some(r=>['C4','C5'].includes(r.key)));
 assert(p.rows.every(r=>r.active===false&&r.capacity===1));
 assert.equal(p.rows.filter(r=>r.key==='C6').length,2);
 assert.equal(p.external_hospital,'manual_capacity_not_assumed');
});
test('shared clinic records have one canonical room and no duplicate capacity',()=>{
 const p=preparePhysicalInstallations(base());
 for(const key of ['C1','C2','C3','C6','C7','C10','C12']){
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
 assert.throws(()=>verifyPhysicalPackage(p),/ROWS_OR_POLICY_CHANGED/);
});

function priorMap() {
 const b=base(), p=preparePhysicalInstallations(b);
 let id=70;
 b.installations=p.rows.filter(r=>!(['C2','C6'].includes(r.key)&&r.clinic_id===72)).map(r=>({
  id:++id,clinica_id:r.clinic_id,nombre:r.name,tipo:r.type,capacidad:1,activo:0,
  descripcion:`Mapa físico documental BS 2026. ${r.key}. Pendiente de activación tras conciliar agenda. Paquete ${'a'.repeat(64)}.`,
 }));
 b.aliases=['C1','C3','C7','C10','C12'].map(key=>({
  installation_id:b.installations.find(i=>i.nombre.startsWith(key+' ·')&&i.clinica_id===66).id,
  canonical_installation_id:b.installations.find(i=>i.nombre.startsWith(key+' ·')&&i.clinica_id===72).id,group_id:29,
 }));
 return b;
}
test('adds only Medical C2/C6 to the prior documentary map and retains canonical Capilar IDs',()=>{
 const b=priorMap(), before=hash(b), p=preparePhysicalInstallations(b);verifyPhysicalPackage(p);
 assert.equal(hash(b),before);assert.equal(p.preserved.length,16);
 assert.deepEqual(p.additions.map(r=>[r.key,r.clinic_id,r.canonical_clinic_id]),[['C2',72,66],['C6',72,66]]);
 assert.deepEqual(p.alias_additions,[{key:'C2',clinic_id:72,canonical_clinic_id:66},{key:'C6',clinic_id:72,canonical_clinic_id:66}]);
});
test('complete map prepares no new rooms or aliases without renaming earlier rooms',()=>{
 const b=priorMap();let id=200;
 for(const key of ['C2','C6']) {
  const canonical=b.installations.find(r=>r.nombre.startsWith(key+' ·'));
  const member={...canonical,id:++id,clinica_id:72};b.installations.push(member);
  b.aliases.push({installation_id:member.id,canonical_installation_id:canonical.id,group_id:29});
 }
 const p=preparePhysicalInstallations(b);verifyPhysicalPackage(p);
 assert.equal(p.additions.length,0);assert.equal(p.alias_additions.length,0);assert.equal(p.preserved.length,18);
});
test('does not reuse active, multi-place, unrelated or wrongly typed rooms',()=>{
 for(const patch of [{activo:1},{capacidad:2},{tipo:'otro'},{descripcion:'Sala C2'}, {descripcion:`Mapa físico documental BS 2026. C99. Paquete ${'a'.repeat(64)}.`}]) {
  const b=priorMap();Object.assign(b.installations[0],patch);assert.throws(()=>preparePhysicalInstallations(b),/REVIEW_REQUIRED/);
 }
});
test('rejects duplicate or cross-room aliases and missing canonical linkage',()=>{
 for(const mutate of [b=>b.installations.push({...b.installations[0],id:999}),b=>b.aliases[0].canonical_installation_id=999,
  b=>b.aliases[0].group_id=99,b=>b.aliases.push({...b.aliases[0]}),b=>b.aliases.shift()]) {
  const b=priorMap();mutate(b);assert.throws(()=>preparePhysicalInstallations(b),/DUPLICATED|TOPOLOGY_CHANGED/);
 }
});
test('cannot turn preserved records into additions by rehashing the package',()=>{
 const p=preparePhysicalInstallations(priorMap());p.additions.push(p.rows[0]);const {package_sha256,...body}=p;p.package_sha256=hash(body);
 assert.throws(()=>verifyPhysicalPackage(p),/ROWS_OR_POLICY_CHANGED/);
});
test('only reviewed customer scope with source hashes is accepted',()=>{
 assert.throws(()=>preparePhysicalInstallations({...base(),target:'dev'}),/SCOPE/);
 assert.throws(()=>preparePhysicalInstallations({...base(),groupId:1}),/SCOPE/);
 assert.throws(()=>preparePhysicalInstallations({...base(),sources:[]}),/SOURCE/);
});
