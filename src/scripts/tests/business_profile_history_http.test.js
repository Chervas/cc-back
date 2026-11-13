'use strict';require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../../services/businessProfileHistoryScope.service'),C=require('../../services/businessProfileAssociation.contract');
const {loadDiscoverySource}=require('./fixtures/business_profile_discovery.fixture');
const Owner=require('../../../services/integrations-broker/src/google-business-profile-enrollment-contract');
function fixture(){
 const state={group:5,role:'agencia',mutate:null};const generationId='20000000-0000-4000-8000-000000000002',attemptId='30000000-0000-4000-8000-000000000003';
 const mapping={id:70,clinica_id:72,google_connection_id:81,is_active:true,location_id:'locations/456',broker_read_connection_ref:'connection:test',broker_read_asset_ref:'gbp:123:456'},source={...mapping,id:2,clinica_id:71,is_active:false};
 const proof={descriptorId:'40000000-0000-4000-8000-000000000004',sourceTenantRef:'clinic:71',sourceConnectionRef:'connection:test',sourceScopeRef:'gbp-enroll:clinic:71',sourceAssetRef:'gbp:123:456',retirementEnrollmentId:'50000000-0000-4000-8000-000000000005',retirementDigest:'a'.repeat(64)};
 const predecessor={mappingId:2,clinicId:71,groupId:5,assetRef:proof.sourceAssetRef,connectionRef:proof.sourceConnectionRef};
 const generation={generation_id:generationId,mapping_id:70,external_location_id:'456',clinica_id:72,google_connection_id:81,connection_ref:'connection:test',asset_ref:'gbp:123:456',scope_ref:'gbp-enroll:clinic:72',previous_asset_ref:null,state:'active',association_attempt_id:attemptId,source_fingerprint:'b'.repeat(64),predecessor:[predecessor],reassociation:proof};
 generation.proof_digest=Owner.reassociationDigest(proof,{tenantRef:'clinic:72',connectionRef:generation.connection_ref,assetRef:generation.scope_ref,payload:{enrollmentId:attemptId,accountId:'123',locationId:'456',previousAssetRef:null,clinicCount:1,clinicSetDigest:C.hash([72]),reassociation:proof}});
 const models={sequelize:{transaction:async fn=>fn({LOCK:{UPDATE:true}})},Clinica:{findByPk:async id=>({id_clinica:Number(id),grupoClinicaId:Number(id)===71?state.group:5})},UsuarioClinica:{findAll:async()=>[{id_clinica:72,rol_clinica:state.role,estado_invitacion:'aceptada'}]},ClinicBusinessLocation:{findByPk:async id=>Number(id)===70?mapping:source},BusinessProfileBrokerRevocation:{findByPk:async()=>null},BusinessProfileBrokerBinding:{findByPk:async()=>({external_location_id:'456',state:'retired',current_generation_id:generationId})},BusinessProfileBrokerBindingGeneration:{findByPk:async()=>generation},BusinessProfileAssociationRequest:{findByPk:async()=>({state:'active',target_mapping_id:70,target_snapshot:{generationId,predecessors:[predecessor]}})}};
 const project=()=>H.createHistoryProjection({models,clinicId:72,userId:9,locations:[mapping],permission:async()=>['agencia','personaldeclinica'].includes(state.role)});
 return {state,project};
}
async function request(router){return new Promise((resolve,reject)=>{
 const req={method:'GET',url:'/clinica/72/overview',headers:{},query:{},userData:{userId:9}},res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});return this;},setHeader(){},end(){resolve({status:this.statusCode});}};
 router.handle(req,res,error=>error?reject(error):reject(Error('route not handled')));
});}
for(const mutation of ['group','role'])test('native local HTTP denies changed '+mutation+' during await with 403 and no historical payload',async()=>{
 const f=fixture();let captured=await f.project(),change=true;
 const local={resolveEffectiveLocations:async()=>({history:captured}),buildOverview:async resolved=>{await Promise.resolve();if(change){if(mutation==='group')f.state.group=6;else f.state.role='personaldeclinica';}await resolved.history.assert();return {success:true,mappingIds:resolved.history.mappingIds};}};
 const router=loadDiscoverySource('routes/local.routes.js',{'express':require('express'),'./auth.middleware':(_req,_res,next)=>next(),'../lib/marketingScopeAccess':{hasMarketingClinicScopeAccess:async()=>true},'../services/businessProfileLocal.service':local});
 const denied=await request(router);assert.equal(denied.status,403);assert.deepEqual(JSON.parse(JSON.stringify(denied.body)),{success:false,error:'scope_denied'});assert.equal(Object.hasOwn(denied.body,'mappingIds'),false);
 change=false;captured=await f.project();const allowed=await request(router);assert.equal(allowed.status,200);assert.deepEqual(allowed.body.mappingIds,mutation==='group'?[70]:[70,2]);
});
