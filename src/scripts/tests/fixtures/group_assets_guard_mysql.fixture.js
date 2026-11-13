'use strict';
// Runs only inside the owned --skip-networking MySQL fixture, after a real
// typed Meta enrollment has committed. No guard, repository or helper is mocked.
const assert=require('node:assert/strict'),{DataTypes:D}=require('sequelize');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const barrier=()=>{let resolve;return{promise:new Promise(done=>resolve=done),resolve:()=>resolve()};};
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('GROUP_GUARD_TIMEOUT_'+label)),10000);})]);}finally{clearTimeout(timer);}};
module.exports=async({models,sql,report,now,enrollmentId,commands,providerCalls})=>{
 assert.equal(report.database,'campaign_optimization_qa');assert(/^\/tmp\/cc-campaign-opt-mysql-[A-Za-z0-9]+$/.test(report.root));
 const [[server]]=await sql.query('SELECT @@skip_networking isolated,@@log_bin binlogs');assert.equal(Number(server.isolated),1);assert.equal(Number(server.binlogs),0);
 const commandsBefore=commands.length,providerBefore=providerCalls();
 for(const [name,file] of [['GoogleConnection','googleconnection'],['GoogleConnectionAssignment','googleconnectionassignment'],['GoogleOAuthBrokerBinding','googleoauthbrokerbinding'],
  ['ClinicWebAsset','clinicwebasset'],['ClinicAnalyticsProperty','clinicanalyticsproperty'],['ClinicBusinessLocation','clinicbusinesslocation'],['ClinicGoogleAdsAccount','clinicgoogleadsaccount'],
  ['SearchConsoleBrokerBinding','searchconsolebrokerbinding'],['AnalyticsBrokerBinding','analyticsbrokerbinding'],['BusinessProfileBrokerBinding','businessprofilebrokerbinding'],
  ['GoogleAdsBrokerBinding','googleadsbrokerbinding'],['GooglePropertyBrokerRevocation','googlepropertybrokerrevocation'],['BusinessProfileBrokerRevocation','businessprofilebrokerrevocation'],['GoogleAdsBrokerRevocation','googleadsbrokerrevocation']]){
  if(!models[name]){models[name]=require('../../../../models/'+file)(sql,D);for(const attribute of Object.values(models[name].rawAttributes))delete attribute.references;models[name].refreshAttributes();await models[name].sync();}
 }
 if(!models.GrupoClinica.associations.clinicas)models.GrupoClinica.hasMany(models.Clinica,{foreignKey:'grupoClinicaId',as:'clinicas',constraints:false});
 const E=models.MetaMarketingEnrollmentRequest,B=models.MetaMarketingBrokerBinding,A=models.GroupAssetClinicAssignment,M=models.ClinicMetaAsset;
 const enrollment=await E.findByPk(enrollmentId,{raw:true});assert.equal(enrollment.state,'active');
 const meta=await M.findAll({where:{id:JSON.parse(enrollment.mapping_ids)},attributes:['id','assetType'],raw:true});
 const adId=meta.find(v=>v.assetType==='ad_account').id,igId=meta.find(v=>v.assetType==='instagram_business').id;
 const G=models.ClinicWebAsset,S=models.SearchConsoleBrokerBinding;
 await models.GoogleConnection.create({id:881,googleUserId:'group-guard-google',accessToken:null,refreshToken:null});
 await models.GoogleConnectionAssignment.create({googleConnectionId:881,scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,status:'active'});
 const resource=require('../../../../services/integrations-broker/src/google-search-console-contract').site('https://group-guard.example.invalid/');
 const web=await G.create({clinicaId:59,googleConnectionId:881,siteUrl:resource.siteUrl,isActive:true,broker_read_connection_ref:'group-guard-google',broker_read_asset_ref:resource.assetRef});
 await S.create({site_hash:resource.siteHash,site_url:resource.siteUrl,mapping_id:web.id,connection_ref:'group-guard-google',asset_ref:resource.assetRef,clinica_id:59,google_connection_id:881,google_user_id:'group-guard-google',state:'active'});
 const retired=await G.create({clinicaId:71,googleConnectionId:881,siteUrl:'https://group-guard-retired.example.invalid/',isActive:false});
 const waConnection=await models.MetaConnection.create({id:9881,metaUserId:'9881',accessToken:'FICTITIOUS_GROUP_WA_SENTINEL'});
 const wa=await M.create({metaConnectionId:waConnection.id,clinicaId:59,assetType:'whatsapp_phone_number',metaAssetId:'9882',isActive:true,waAccessToken:'FICTITIOUS_GROUP_PHONE_SENTINEL'});
 await A.create({grupoClinicaId:6,assetType:'meta.ad_account',assetId:987654,clinicaId:88});
 const securityNames=['MetaMarketingEnrollmentRequest','MetaMarketingEnrollmentClaim','MetaMarketingEnrollmentIdentity','MetaMarketingBrokerBinding','MetaMarketingBrokerRevocation','MetaMarketingOAuthRequest','MetaScopeBlock',
  'MetaMarketingEffectiveCredential','MetaMarketingCredentialRenewal','MetaMarketingBusinessHandover','MetaMarketingRecovery'];
 const snapshot=async()=>{
  const values={};for(const name of securityNames)if(models[name])values[name]=await models[name].findAll({raw:true,order:models[name].primaryKeyAttributes.map(key=>[key,'ASC'])});
  values.meta=await M.findAll({attributes:['id','metaConnectionId','assetType','metaAssetId','assignmentScope','clinicaId','grupoClinicaId','isActive','updatedAt'],raw:true,order:[['id','ASC']]});
  values.google=await G.findAll({raw:true,order:[['id','ASC']]});values.googleBindings=await S.findAll({raw:true,order:[['mapping_id','ASC']]});
  const [hashes]=await sql.query('SELECT id,SHA2(COALESCE(accessToken,\'\'),256) credential_hash FROM MetaConnections ORDER BY id');values.connectionHashes=hashes;
  const [waHashes]=await sql.query('SELECT id,SHA2(COALESCE(waAccessToken,\'\'),256) credential_hash FROM ClinicMetaAssets WHERE id=$id',{bind:{id:wa.id}});values.waHashes=waHashes;
  return JSON.stringify(values);
 };
 const choices=async()=>JSON.stringify({groups:await models.GrupoClinica.findAll({raw:true,order:[['id_grupo','ASC']]}),shares:await A.findAll({raw:true,order:[['id','ASC']]})});
 const forbidden={MetaConnection:['accessToken'],ClinicMetaAsset:['pageAccessToken','waAccessToken','additionalData'],GoogleConnection:['accessToken','refreshToken']};
 for(const [name,fields]of Object.entries(forbidden))models[name].addHook('beforeFind','group-guard-no-credential-values',options=>{assert(Array.isArray(options.attributes));assert(!options.attributes.some(v=>typeof v==='string'&&fields.includes(v)));});
 const savedEnv={};for(const key of ['META_MARKETING_BROKER_ENABLED','GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED']){savedEnv[key]=process.env[key];process.env[key]='true';}
 const service=require('../../../services/groupAssets.service');
 const use=()=>({adsAccounts:{meta:{mode:'clinic',clinicAssignments:{59:adId,71:adId}}},google:{searchConsole:{mode:'clinic',clinicAssignments:{59:web.id,71:web.id}}}});
 const reject409=promise=>assert.rejects(promise,e=>e.status===409&&/^group_asset_/.test(e.code));
 let hookInstalled=false;
 try{
  const before=await snapshot(),outside=await A.findAll({where:{grupoClinicaId:6},raw:true});
  await service.updateGroupConfig(5,use());assert.equal(await snapshot(),before);assert.deepEqual(await A.findAll({where:{grupoClinicaId:6},raw:true}),outside);
  assert.equal(await A.count({where:{grupoClinicaId:5,assetType:'meta.ad_account'}}),2);assert.equal(await A.count({where:{grupoClinicaId:5,assetType:'google.search_console'}}),2);
  await service.updateGroupConfig(5,{adsAccounts:{meta:{mode:'clinic',clinicAssignments:{}}}});assert.equal(await snapshot(),before);
  assert.equal(await A.count({where:{grupoClinicaId:5,assetType:'meta.ad_account'}}),0);assert.equal(await A.count({where:{grupoClinicaId:5,assetType:'google.search_console'}}),2);
  assert.deepEqual(await A.findAll({where:{grupoClinicaId:6},raw:true}),outside);
  report.checks.push('Group writer against actual committed non-NULL Meta enrollment and SC bindings shares active resources, then accepts empty Meta selection; immutable enrollment/claims/flows/bindings/credentials, source mappings, sibling IG, inactive Google and foreign group shares are byte-identical');
  await service.updateGroupConfig(5,use());const beforeRejected=await choices();
  await reject409(service.updateGroupConfig(5,{...use(),nombre_grupo:'FICTITIOUS_MUST_ROLL_BACK',google:{searchConsole:{mode:'clinic',clinicAssignments:{59:web.id,71:retired.id}}}}));
  assert.equal(await choices(),beforeRejected);assert.equal(await snapshot(),before);
  const closed=await M.create({metaConnectionId:enrollment.meta_connection_id,assetType:'ad_account',metaAssetId:'9883',assignmentScope:'group',grupoClinicaId:5,isActive:true});
  await B.create({mapping_id:closed.id,enrollment_id:null,asset_ref:'meta-ad_account:9883',meta_connection_id:enrollment.meta_connection_id,meta_user_id:enrollment.meta_user_id,app_id:enrollment.app_id,connection_ref:enrollment.connection_ref,scope_key:'group:5',tenant_clinic_id:59,parent_page_id:null,state:'blocked'});
  await A.create({grupoClinicaId:5,assetType:'meta.ad_account',assetId:closed.id,clinicaId:71});const closedChoices=await choices();
  await reject409(service.updateGroupConfig(5,{adsAccounts:{meta:{mode:'clinic',clinicAssignments:{}}}}));assert.equal(await choices(),closedChoices);
  await A.destroy({where:{grupoClinicaId:5,assetId:closed.id}});await B.destroy({where:{mapping_id:closed.id}});await closed.destroy();
  assert.equal(await snapshot(),before);report.checks.push('A valid plus inactive cross-provider selection rolls back every field/share; an empty selection also validates a previously shared closed Meta resource and rejects atomically instead of deleting its use silently');
  const beforeFailure=await choices();A.addHook('afterBulkCreate','group-guard-write-failure',()=>{throw Error('FICTITIOUS_GROUP_WRITE_FAILURE');});hookInstalled=true;
  await assert.rejects(service.updateGroupConfig(5,{...use(),nombre_grupo:'FICTITIOUS_MUST_ROLL_BACK'}),/FICTITIOUS_GROUP_WRITE_FAILURE/);
  A.removeHook('afterBulkCreate','group-guard-write-failure');hookInstalled=false;assert.equal(await choices(),beforeFailure);assert.equal(await snapshot(),before);
  report.checks.push('Actual InnoDB rollback after group update, share DELETE and attempted INSERT restores all prior assignments and group fields, without touching immutable Meta security history');
  // A competitor owns the real Enrollment fence before the writer gets it.
  const competitor=await sql.transaction(),atFence=barrier();await E.findByPk(enrollmentId,{transaction:competitor,lock:competitor.LOCK.UPDATE});
  let writerSettled=false;const beforeWait=await choices();
  E.addHook('beforeFind','group-guard-observe-fence',options=>{if(options.transaction&&options.transaction.id!==competitor.id&&options.lock)atFence.resolve();});
  const writer=service.updateGroupConfig(5,{...use(),nombre_grupo:'FICTITIOUS_BLOCKED_WRITER'}).then(value=>{writerSettled=true;return {value};},error=>{writerSettled=true;return {error};});
  try{await bounded(Promise.race([atFence.promise,writer.then(result=>{if(result.error)throw result.error;throw Error('WRITER_PASSED_FENCE_EARLY');})]),'writer-fence');await pause(30);assert.equal(writerSettled,false);await B.update({state:'blocked'},{where:{mapping_id:adId},transaction:competitor});await competitor.commit();const outcome=await writer;assert(outcome.error);assert.equal(outcome.error.status,409);}
  finally{E.removeHook('beforeFind','group-guard-observe-fence');if(!competitor.finished)await competitor.rollback();}
  assert.equal(await choices(),beforeWait);await B.update({state:'active'},{where:{mapping_id:adId}});assert.equal(await snapshot(),before);
  report.checks.push('Two real connections: writer waits on the pre-existing Meta Enrollment fence; competitor commits a block, writer observes it and rolls back completely before group/share mutations');
  // Reverse ordering: once the writer has its security locks, the competitor
  // cannot overtake it. The hook pauses a real DELETE, not the authority guard.
  const writing=barrier(),releaseWriter=barrier(),competitorAtFence=barrier();
  A.addHook('beforeBulkDestroy','group-guard-pause-write',async()=>{writing.resolve();await releaseWriter.promise;});
  const writer2=service.updateGroupConfig(5,use()).then(value=>({value}),error=>({error}));await bounded(Promise.race([writing.promise,writer2.then(result=>{if(result.error)throw result.error;throw Error('WRITER_DID_NOT_PAUSE');})]),'writer-holds-locks');
  const competitor2=await sql.transaction();let competitorSettled=false;
  E.addHook('beforeFind','group-guard-observe-competitor',options=>{if(options.transaction?.id===competitor2.id&&options.lock)competitorAtFence.resolve();});
  const withdrawal=(async()=>{await E.findByPk(enrollmentId,{transaction:competitor2,lock:competitor2.LOCK.UPDATE});await B.update({state:'blocked'},{where:{mapping_id:adId},transaction:competitor2});await competitor2.commit();competitorSettled=true;})().then(()=>({}),error=>({error}));
  try{await bounded(Promise.race([competitorAtFence.promise,withdrawal.then(result=>{if(result.error)throw result.error;throw Error('COMPETITOR_PASSED_FENCE_EARLY');})]),'competitor-fence');await pause(30);assert.equal(competitorSettled,false);releaseWriter.resolve();const out=await bounded(writer2,'writer-commit');if(out.error)throw out.error;const c=await bounded(withdrawal,'competitor-commit');if(c.error)throw c.error;}
  finally{releaseWriter.resolve();A.removeHook('beforeBulkDestroy','group-guard-pause-write');E.removeHook('beforeFind','group-guard-observe-competitor');if(!competitor2.finished)await competitor2.rollback();}
  const afterBlock=await choices();await reject409(service.updateGroupConfig(5,{adsAccounts:{meta:{mode:'clinic',clinicAssignments:{}}}}));assert.equal(await choices(),afterBlock);
  await B.update({state:'active'},{where:{mapping_id:adId}});assert.equal(await snapshot(),before);
  report.checks.push('Two real connections in reverse order: competitor cannot pass writer security fences; committed later block makes a following empty selection fail without erasing its existing shares; no deadlock or timeout');
  assert.equal(commands.length,commandsBefore);assert.equal(providerCalls(),providerBefore);assert.equal(report.rejected.length,0);
  report.groupAssetsGuard={realInnoDB:true,nonNullMetaEnrollment:true,crossProvider:true,barrierCases:2,providerRequests:0,whatsappTransports:0,immutablePreserved:true};
 }finally{
  if(hookInstalled)A.removeHook('afterBulkCreate','group-guard-write-failure');
  for(const [name]of Object.entries(forbidden))models[name].removeHook('beforeFind','group-guard-no-credential-values');
  for(const key of Object.keys(savedEnv))savedEnv[key]===undefined?delete process.env[key]:process.env[key]=savedEnv[key];
 }
};
