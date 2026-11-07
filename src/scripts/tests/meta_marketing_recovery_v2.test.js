'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const G=require('../../services/metaMarketingLegacyRecovery.service');
function snapshot(group=28){
  const alias=(id,kind,asset,extra={})=>({id,metaConnectionId:158,assetType:kind,metaAssetId:asset,assignmentScope:'group',clinicaId:1,grupoClinicaId:28,
    isActive:1,whatsappAuthorizationId:null,page_credential_present:0,page_credential_sha256:null,wa_credential_present:0,wa_credential_sha256:null,
    additional_data_present:0,additional_data_sha256:null,...extra});
  const input={version:2,scopeKey:'group:'+group,clinicIds:group===28?[1,70]:[66,72],sourceConnectionId:158,canonicalConnectionId:159,
    appId:'101',subjectId:'201',actorId:1,mappingIds:group===28?[359,361]:[391],newPageCount:group===28?0:2,
    cleanup:group===28?[{mappingId:361,fields:['pageAccessToken'],additionalDataKeys:[],additionalDataSha256:null,archiveEvidenceSha256:null,metadataDisposition:null}]
      :[{mappingId:391,fields:['additionalData'],additionalDataKeys:[...G.METADATA_KEYS],additionalDataSha256:'b'.repeat(64),archiveEvidenceSha256:'d'.repeat(64),metadataDisposition:'archived'}],
    inventory:{clinics:(group===28?[1,70]:[66,72]).map(id_clinica=>({id_clinica,grupoClinicaId:group})),blocks:[],assignments:[],groups:[],shares:[],
      connections:[{id:158,userId:1,metaUserId:'201',broker_app_id:null,credentials_external:0,credential_present:1,credential_sha256:'c'.repeat(64)},
        {id:159,userId:null,metaUserId:'201',broker_app_id:'101',credentials_external:1,credential_present:0,credential_sha256:null}],
      aliases:[alias(359,'ad_account','act_301'),alias(361,'facebook_page','401',{page_credential_present:1,page_credential_sha256:'a'.repeat(64)}),
        alias(391,'ad_account','act_302',{assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,additional_data_present:1,additional_data_sha256:'b'.repeat(64)}),
        alias(392,'whatsapp_phone_number','901',{wa_credential_present:1,wa_credential_sha256:'e'.repeat(64),whatsappAuthorizationId:randomUUID()})]}};
  return G.validateSnapshot(input);
}
function record(s,state='prepared'){
  const at=new Date('2030-01-01T00:00:00Z'),bound=state!=='prepared';
  return {recovery_id:randomUUID(),scope_key:s.scopeKey,clinic_ids:JSON.stringify(s.clinicIds),app_id:s.appId,meta_user_id:s.subjectId,
    source_connection_id:158,canonical_connection_id:null,mapping_ids:JSON.stringify(s.mappingIds),snapshot:G.encode(s),snapshot_digest:G.hash(G.encode(s)),
    prepared_by_user_id:1,prepared_at:at,expires_at:new Date(+at+3600000),state,flow_id:bound?randomUUID():null,candidate_digest:bound?'f'.repeat(64):null,
    enrollment_id:state==='active'?randomUUID():null,bound_at:bound?at:null,activated_at:state==='active'?at:null,retired_at:null};
}
test('two V2 generations share only the pinned canonical ID; SQL NULL never means inactive',()=>{
  for(const group of[28,29])for(const state of['prepared','flow_bound','active']){
    const row=G.snapshotRecord(record(snapshot(group),state));assert.equal(row.canonical_connection_id,null);assert.equal(G.canonicalId(row),159);
    assert.equal(row.snapshot.version,2);
  }
});
test('V2 snapshots require exact clean canonical metadata and archived source metadata disposition',async t=>{
  const cases=[s=>s.canonicalConnectionId=158,s=>s.inventory.connections[1].userId=1,s=>s.inventory.connections[1].credential_present=1,
    s=>s.inventory.connections.push({...s.inventory.connections[1],id:160}),s=>s.newPageCount=3,s=>s.cleanup[0].archiveEvidenceSha256=null,
    s=>s.cleanup[0].metadataDisposition='discard',s=>s.cleanup[0].additionalDataKeys.push('unreviewed'),s=>s.cleanup[0].additionalDataSha256='f'.repeat(64),
    s=>s.inventory.aliases.find(a=>a.id===391).wa_credential_present=1,s=>s.inventory.clinics[0].grupoClinicaId=99];
  for(let i=0;i<cases.length;i++)await t.test(String(i),()=>{const s=snapshot(29);cases[i](s);assert.throws(()=>G.validateSnapshot(s),{code:'meta_recovery_invalid'});});
  const s=snapshot();const row=record(s);row.canonical_connection_id=159;assert.throws(()=>G.snapshotRecord(row),{code:'meta_recovery_invalid'});
});
test('required legacy Ads/Page cannot be omitted; explicit fresh Ads preserve the exact Root-counted pages and total limit',()=>{
  const asset=(kind,id)=>({kind,id,assetRef:'meta-'+kind+':'+id,parentPageId:null});
  const a=snapshot(),proofA={version:2,newPageCount:0,aliases:a.inventory.aliases.filter(x=>a.mappingIds.includes(x.id))};
  assert.equal(G.selection(proofA,[asset('ad_account','301'),asset('facebook_page','401')]).added.length,0);
  assert.throws(()=>G.selection(proofA,[asset('ad_account','301')]),{code:'meta_recovery_selection_changed'});
  const b=snapshot(29),proofB={version:2,newPageCount:2,aliases:b.inventory.aliases.filter(x=>b.mappingIds.includes(x.id))};
  const selected=[asset('ad_account','302'),asset('facebook_page','501'),asset('facebook_page','502')];assert.equal(G.selection(proofB,selected).added.length,2);
  const newAds=[asset('ad_account','303'),asset('ad_account','304')],fresh=[...selected,...newAds];
  assert.equal(G.selection(proofB,fresh).added.length,4);
  assert(newAds.every(value=>G.selectable(proofB,value,fresh)));
  assert(selected.every(value=>G.selectable(proofB,value,fresh)));
  const maximum=[...selected,...Array.from({length:97},(_,i)=>asset('ad_account',String(1000+i)))];
  assert.equal(G.selection(proofB,maximum).added.length,99);
  assert.throws(()=>G.selection(proofB,[...maximum,asset('ad_account','2000')]),{code:'meta_recovery_selection_changed'});
  for(const value of[selected.slice(0,2),[...selected,asset('facebook_page','503')],[selected[0],selected[1],asset('instagram_business','502')],
    [selected[0],selected[1],asset('ad_account','303')],
    [...selected.slice(1),...newAds],[...selected,{...newAds[0],parentPageId:'501'}],
    [selected[0],selected[1],selected[1]]])assert.throws(()=>G.selection(proofB,value),{code:'meta_recovery_selection_changed'});
});
