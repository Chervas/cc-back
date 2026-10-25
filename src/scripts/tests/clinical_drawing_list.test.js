'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Op}=require('sequelize');
const {createService}=require('../../services/clinicalDrawings.service'),C=require('../../lib/clinical-episode-contract');
function fixture(){const calls=[];const asset={id:51,public_id:'asset-original',clinic_id:72,patient_id:1,scope_type:'clinic',status:'active',purpose:'clinical_attachment',content_type:'application/pdf'};
 const db={Paciente:{findOne:async()=>({id_paciente:1,clinica_id:72})},ClinicalPrivateAsset:{findOne:async({where})=>{calls.push({asset:where});return where.public_id===asset.public_id?asset:null;}},ClinicalDrawing:{findAll:async options=>{calls.push({list:options});return[];}}};
 return{calls,service:createService({db,canAccess:async()=>true}),input:{patientIdentifier:1,clinicId:72,actorId:7}};}
test('optional original filter resolves scoped public identity to PK and active descending list; unfiltered cursor remains compatible',async()=>{
 const f=fixture();await f.service.list({...f.input,source_asset_id:'asset-original'});
 assert.deepEqual(f.calls[0].asset,{public_id:'asset-original',patient_id:1,clinic_id:72,scope_type:'clinic',status:'active',purpose:'clinical_attachment'});
 assert.equal(f.calls[1].list.where.source_asset_id,51);assert.equal(f.calls[1].list.where.status,'active');assert.deepEqual(f.calls[1].list.order,[['id','DESC']]);
 const cursor=C.encodeCursor({scope:C.hash([72,1,'active']),id:99});await f.service.list({...f.input,cursor});assert.equal(f.calls.at(-1).list.where.id[Op.lt],99);
 await assert.rejects(f.service.list({...f.input,source_asset_id:'asset-original',cursor}),{code:'clinical_drawing_cursor_invalid'});
});
test('malformed and foreign source filters fail closed before querying drawings',async()=>{
 for(const value of ['',null,[],123,'foreign-original','https://external/asset']){const f=fixture();await assert.rejects(f.service.list({...f.input,source_asset_id:value}));assert(!f.calls.some(row=>row.list));}
});
test('controller forwards source_asset_id query unchanged and retains private response',async()=>{
 let input;const controller=require('../../controllers/clinicalDrawings.controller').createClinicalDrawingsController({service:()=>({list:async value=>{input=value;return{items:[],next_cursor:null};}})});
 const res={headers:{},set(k,v){this.headers[k]=v;return this;},json(value){this.body=value;return this;},status(n){this.code=n;return this;}};
 await controller.list({params:{id:'1'},query:{clinic_id:'72',source_asset_id:'asset-original'},userData:{userId:7}},res);
 assert.equal(input.source_asset_id,'asset-original');assert.equal(input.patientIdentifier,'1');assert.equal(res.headers['Cache-Control'],'private, no-store');
});
