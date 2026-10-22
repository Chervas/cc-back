'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeEurodentCatalogItem:catalog,normalizeEurodentDentalLocation:location,decodeEurodentSurfaces:surfaces,decodeEurodentDentition:dentition,expandEurodentRange:range,projectEurodentOdontogram:project}=require('../../lib/eurodent-odontogram');
const cat={ID:'filling',Nombre:'Obturación',Familia:'2',Grafico:'1'};
const row=(table,id,record={},c=cat)=>({source_instance:'synthetic-unit-fixture',source_database:'EDD',source_table:table,source_pk:{ID:id},record:{ID:id,'Nº Trat':c.Familia,Pieza:'16',Fecha:'10/09/2026 00:00:00','Gráfico':'1',...record},catalog:c});

test('source-verified physical sector codes depend on FDI quadrant and arch',()=>{
 assert.deepEqual(surfaces(26,17).surfaces,['O']);assert.deepEqual(surfaces(12,18).surfaces,['V']);assert.deepEqual(surfaces(14,15).surfaces,['M']);assert.deepEqual(surfaces(18,14).surfaces,['P']);assert.deepEqual(surfaces(14,27).surfaces,['D']);assert.deepEqual(surfaces(12,44).surfaces,['L']);assert.deepEqual(surfaces(31,16).surfaces,['D','M','O']);
});
test('permanent and primary quadrants maintain anatomical mesial/distal and palatal/lingual',()=>{
 for(const [tooth,left,right,top,bottom]of[[16,'D','M','V','P'],[26,'M','D','V','P'],[36,'M','D','L','V'],[46,'D','M','L','V'],[55,'D','M','V','P'],[65,'M','D','V','P'],[75,'M','D','L','V'],[85,'D','M','L','V']]){
  assert.deepEqual(surfaces(11,tooth).surfaces,[left]);assert.deepEqual(surfaces(14,tooth).surfaces,[right]);assert.deepEqual(surfaces(12,tooth).surfaces,[top]);assert.deepEqual(surfaces(18,tooth).surfaces,[bottom]);
 }
 assert.deepEqual(surfaces(26,11).surfaces,['I']);
});
test('legacy invalid surface codes and unknown surfaces never default to a central filling',()=>{
 for(const value of[6,10,41,'bad'])assert.deepEqual(surfaces(value,16),{surfaces:[],warnings:['surface_code_unresolved']});
 const result=location({'Nº Trat':'2',Pieza:'16',Cuadrante:'0','Gráfico':'1'},cat);assert.deepEqual(result.surfaces,[]);assert.ok(result.warnings.includes('surface_not_recorded'));
});
test('source-verified old reconstruction editor preserves 35/O=5 and 44/V=3',()=>{
 assert.deepEqual(surfaces(5,35).surfaces,['O']);assert.deepEqual(surfaces(3,44).surfaces,['V']);assert.deepEqual(surfaces(1,44).surfaces,['L']);assert.deepEqual(surfaces(2,44).surfaces,['M']);
});
test('registered source family survives catalogue reassignment and archival',()=>{
 const changed=location({'Nº Trat':'9',Pieza:'16','Gráfico':'1'},{ID:'x',Familia:'5',Nombre:'Source label',Grafico:'1'});assert.equal(changed.visual_type,'corona');assert.equal(changed.catalog_family_id,'5');assert.equal(changed.needs_review,false);assert.ok(changed.warnings.includes('registered_family_differs_from_current_catalog'));
 assert.equal(catalog({ID:'old',Familia:'99',FamOldOcu:'11',Grafico:'1'}).visual_type,'puente');assert.equal(catalog({ID:'old',Familia:'99',FamOldOcu:'11',Grafico:'1'}).hidden,true);
});
test('ranges follow the dental arch, including midline, rather than a numeric interval',()=>{
 assert.deepEqual(range(24,26),[24,25,26]);assert.deepEqual(range(36,46),[36,35,34,33,32,31,41,42,43,44,45,46]);assert.deepEqual(range(64,65),[64,65]);assert.equal(range(16,46),null);assert.equal(range(55,16),null);
 const invalid=location({'Nº Trat':'2',Pieza:'3646','Gráfico':'1'},cat);assert.deepEqual(invalid.teeth,[]);assert.equal(invalid.needs_review,true);
});
test('prosthesis lists specify exact teeth; bridge roots specify abutments',()=>{
 const prosthesis=location({'Nº Trat':'24',Pieza:'0',PzasProt:'111321','Gráfico':'1'},{Familia:'24',Grafico:'1'});assert.deepEqual(prosthesis.teeth,[11,13,21]);assert.equal(prosthesis.kind,'prosthesis');
 const bridge=row('Historial','bridge',{'Nº Trat':'11',Pieza:'2426',ResPza:'2426'},{Familia:'11',Grafico:'1'});const p=project([bridge]);assert.equal(p.teeth.find(x=>x.number===24).marks[0].root_role,'abutment');assert.equal(p.teeth.find(x=>x.number===25).marks[0].visual_type,'puente-pontico');
});
test('dental layout preserves deciduous/mixed teeth without declaring empty slots missing',()=>{
 const values=[151,152,153,154,155,100,100,100,161,162,163,164,165,100,100,100,171,172,173,174,175,100,100,100,181,182,183,184,185,100,100,100];
 const d=dentition({}, {Piezas:String.fromCharCode(...values)});assert.equal(d.teeth.length,20);assert.deepEqual(d.warnings,[]);
 const p=project([{source_table:'Piezas',record:{},decoded_fields:{Piezas:String.fromCharCode(...values)}}]);assert.equal(p.dentition,'temporary');assert.equal(p.teeth.filter(x=>x.status==='observed').length,0);
});
test('actual object-shaped source primary keys keep all distinct evidence identities',()=>{
 const p=project([row('Historial','a',{Cuadrante:'26'}),row('Historial','b',{Cuadrante:'14'}),row('Historial','c',{Cuadrante:'12'})],{at:'2026-10-09'});
 assert.equal(new Set(p.items.map(x=>x.id)).size,3);assert.ok(p.items.every(x=>!x.id.includes('[object Object]')));assert.equal(p.source_instance,'synthetic-unit-fixture');assert.equal(p.cutoff,'2026-10-09');
});
test('performed, pre-existing, pending and budget marks retain distinct states',()=>{
 const p=project(['Historial','Primera_Visita','Trabajo_Pendiente','Presupuesto'].map((table,i)=>row(table,String(i),{Cuadrante:'26',IDPre:'budget'})));
 assert.deepEqual(p.items.map(x=>x.state),['performed','prior','pending','budget']);assert.deepEqual(p.items.map(x=>x.origin),['performed','existing','proposed','proposed']);assert.equal(p.items[3].budget_source_id,'budget');
});
test('financial and non-graphic source entries do not fabricate restorative marks',()=>{
 const p=project([row('Historial','cash',{'Nº Trat':'0'},{Familia:'0',Grafico:'1'}),row('Historial','advance',{Tipolin:'A'}),row('Historial','non',{'Nº Trat':'23'},{Familia:'23',Grafico:'1'})]);assert.equal(p.counts.financial,2);assert.equal(p.counts.non_graphic,1);assert.equal(p.teeth.flatMap(x=>x.marks).length,0);
});
test('later extraction and implant retire older drawings while retaining original evidence',()=>{
 const p=project([row('Historial','old',{Cuadrante:'26',Fecha:'01/01/2020 00:00:00'}),row('Historial','extract',{'Nº Trat':'3',Fecha:'01/01/2021 00:00:00'},{Familia:'3',Grafico:'1'}),row('Historial','implant',{'Nº Trat':'19',Fecha:'01/01/2022 00:00:00'},{Familia:'19',Grafico:'1'})]);const marks=p.teeth.find(x=>x.number===16).marks;assert.equal(marks.length,3);assert.deepEqual(marks.map(x=>x.visible),[false,false,true]);assert.equal(marks[2].visual_type,'implante');
});
