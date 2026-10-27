'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolvePublicWhatsapp} = require('../../lib/intakePublicWhatsapp');
const clinic={id_clinica:1,grupoClinicaId:5,telefono_whatsapp:'600111222'};
const asset=(id,phone,extra={})=>({id,clinicaId:1,grupoClinicaId:5,assignmentScope:'clinic',isActive:1,
  assetType:'whatsapp_phone_number',metaAssetName:phone,...extra});
const assets=[asset(10,'+34 600 111 222'),asset(11,'+34 600 333 444')];
const bindings=[{clinic_id:1,asset_id:10,role:'primary',is_active:1},{clinic_id:1,asset_id:11,role:'secondary',is_active:1}];
const resolve=(extra={})=>resolvePublicWhatsapp({clinic,assets,bindings,...extra});

test('primary remains public after secondary sync or reversal of asset ordering',()=>{
  assert.equal(resolve().whatsapp,'34600111222');
  assert.equal(resolve({assets:assets.slice().reverse()}).whatsapp,'34600111222');
  assert.deepEqual(resolve().whatsapp_aliases,['34600111222','34600333444']);
});
test('an explicit web selection can use its bound secondary, never a foreign number',()=>{
  assert.equal(resolve({configured:{public_whatsapp:'600333444'}}).whatsapp,'34600333444');
  assert.equal(resolve({configured:{public_whatsapp:'600999888'}}).whatsapp,null);
  assert.equal(resolve({assets:[...assets,asset(12,'600999888',{clinicaId:2})],configured:{public_whatsapp:'600999888'}}).whatsapp,null);
});
test('inactive/missing binding fails closed and never revives the manual or secondary number',()=>{
  assert.equal(resolve({assets:[{...assets[0],isActive:0},assets[1]]}).whatsapp,null);
  assert.equal(resolve({assets:[]}).whatsapp,null);
  assert.equal(resolve({assets:[],bindings:[]}).whatsapp,'34600111222');
});
test('legacy ambiguous assets require selection; a unique primary remains compatible',()=>{
  assert.equal(resolve({bindings:[]}).whatsapp,null);
  assert.equal(resolve({bindings:[],assets:[assets[0]]}).whatsapp,'34600111222');
});
test('group phone only applies to the current group and explicit clinic binding wins',()=>{
  const group=asset(20,'600555666',{assignmentScope:'group',clinicaId:null});
  assert.equal(resolve({assets:[...assets,group]}).whatsapp,'34600111222');
  assert.equal(resolve({assets:[group],bindings:[]}).whatsapp,'34600555666');
  assert.equal(resolve({assets:[{...group,grupoClinicaId:6}],bindings:[]}).whatsapp_source,'clinic_manual');
});
