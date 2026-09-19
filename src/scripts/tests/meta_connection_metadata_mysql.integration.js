'use strict';
const assert = require('node:assert/strict'), http = require('node:http');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report, registerOwnedLoopbackServer }) => {
  for (const [name, file] of [['Usuario','usuario'],['Clinica','clinica'],['GrupoClinica','grupoclinica'],
    ['MetaConnection','MetaConecction'],['MetaConnectionAssignment','metaconnectionassignment'],['MetaScopeBlock','metascopeblock'],
    ['ClinicMetaAsset','ClinicMetaAsset'],['AuthSession','authsession'],['PlatformAuditEvent','platformauditevent']]) {
    models[name] = require('../../../models/'+file)(sql,D);
    for (const attribute of Object.values(models[name].rawAttributes)) delete attribute.references;
    models[name].refreshAttributes(); await models[name].sync();
  }
  models.MetaConnectionAssignment.belongsTo(models.MetaConnection,{as:'metaConnection',foreignKey:'metaConnectionId'});
  models.ClinicMetaAsset.belongsTo(models.MetaConnection,{as:'metaConnection',foreignKey:'metaConnectionId'});
  models.ClinicMetaAsset.belongsTo(models.Clinica,{as:'clinica',foreignKey:'clinicaId'});
  models.UsuarioClinica = sql.define('UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false}); await models.UsuarioClinica.sync();
  await models.GrupoClinica.create({id_grupo:5,nombre_grupo:'Grupo ficticio'});
  await models.Clinica.bulkCreate([59,71].map(id=>({id_clinica:id,nombre_clinica:id===59?'Clínica ficticia A':'Clínica ficticia B',grupoClinicaId:5,estado_clinica:true})));
  const user = await models.Usuario.create({id_usuario:91002,nombre:'Fictitious reader',email_usuario:'metadata@example.invalid',password_usuario:'FICTITIOUS_PASSWORD_HASH'});
  const role = require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];
  await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91002,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
  for (const [id, name] of [[1,'Responsable ficticio A'],[2,'Responsable ficticio B']]) {
    await models.MetaConnection.create({id,userId:91002,metaUserId:String(1000000+id),userName:name,accessToken:'SENTINEL_META_ACCESS',expiresAt:new Date(Date.now()-86400000)});
    await models.MetaConnectionAssignment.create({scopeKey:'clinic:'+(id===1?59:71),assignmentScope:'clinic',clinicaId:id===1?59:71,metaConnectionId:id,status:'active'});
    await models.ClinicMetaAsset.create({id,metaConnectionId:id,clinicaId:id===1?59:71,assignmentScope:'clinic',assetType:'ad_account',metaAssetId:'act_'+(1000000+id),metaAssetName:'Cuenta ficticia '+(id===1?'A':'B'),pageAccessToken:'SENTINEL_PAGE',waAccessToken:'SENTINEL_WA',additionalData:{access_key:'SENTINEL_OTHER'}});
  }
  await models.MetaConnectionAssignment.create({scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,metaConnectionId:1,status:'active'});
  let tokenReads=0, mappingReads=0, hook=null, failSql=false, queries=0;
  sql.addHook('beforeQuery',()=>queries++);
  models.MetaConnection.addHook('beforeFind',opts=>{ if (!opts.attributes || opts.attributes.includes('accessToken')) tokenReads++; });
  models.ClinicMetaAsset.addHook('beforeFind',opts=>{ if (!opts.attributes || opts.attributes.some(k=>['pageAccessToken','waAccessToken','additionalData'].includes(k))) tokenReads++; });
  const access = require('../../services/accessSession.service');
  const sessions = access.createService({models,config:()=>({mode:'enforce',ttl:3600,secret:'FICTITIOUS_SESSION_METADATA_SECRET'})});
  let token=(await sessions.authenticated(user)).body.token;
  const auth=require('../../lib/oauthMarketingScopeAccess'), scopeAccess=require('../../lib/marketingScopeAccess');
  const resolver=require('../../services/scopeConnectionResolver.service');
  const contract=require('../../services/metaConnectionMetadata.service');
  const repository=contract.createMetaMetadataRepository(models);
  const deps={
    session:async req=>{try{return await sessions.verify(access.bearer(req.headers.authorization));}catch{throw Object.assign(Error('meta_metadata_session_required'),{code:'meta_metadata_session_required',httpStatus:401});}},
    authorize:req=>auth.authorizeRequestedMarketingConnectionScope({userId:req.userData.userId,...auth.marketingScopeInputFromRequest(req),access:'read',
      findClinicGroupId:async id=>(await models.Clinica.findByPk(id,{attributes:['grupoClinicaId']}))?.grupoClinicaId,
      findGroupClinicIds:async id=>(await models.Clinica.findAll({where:{grupoClinicaId:id},attributes:['id_clinica']})).map(r=>r.id_clinica),authorizeClinicIds:scopeAccess.hasMarketingClinicScopeAccess}),
    resolve:async req=>{if(failSql)throw Error('SENTINEL_SQL_PASSWORD');return resolver.resolveMetaConnectionForScope({userId:req.userData.userId,...auth.marketingScopeInputFromRequest(req),allowLegacyUserFallback:false,metadataOnly:true});},
    loadMappings:async (...args)=>{mappingReads++;const rows=await repository(...args);if(hook){const fn=hook;hook=null;await fn();}return rows;},
    scopeResponse:(scope,assignment)=>({...scope,authorizedByUserId:assignment?.authorizedByUserId||null})
  };
  const reader=contract.createMetaConnectionMetadata(deps), app=require('express')();
  const gates=[];
  app.use((req,res,next)=>{const json=res.json;res.json=function(body){const gate=gates.find(g=>!g.captured&&g.path===req.path&&String(req.query.clinic_id)===g.clinic);if(gate){gate.captured=true;gate.deliver=()=>json.call(this,body);return this;}return json.call(this,body);};next();});
  app.use((req,_res,next)=>{req.userData={userId:91002};next();});
  app.get(['/oauth/meta/connection-status','/api/oauth/meta/connection-status'],reader.handler());
  app.get(['/oauth/meta/mappings','/api/oauth/meta/mappings'],reader.handler(true));
  app.get(['/oauth/meta/assets','/api/oauth/meta/assets'],require('../../lib/metaQuarantineHttp').middleware);
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));registerOwnedLoopbackServer(server);
  const agent=new http.Agent();
  const get=path=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path,headers:{authorization:'Bearer '+token},agent},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)}));});req.on('error',reject);});
  const status='/oauth/meta/connection-status?clinic_id=59', mappings='/oauth/meta/mappings?clinic_id=59';
  try {
    const baseline=queries,start=Date.now();const stored=await get(status);
    assert.equal(stored.status,200);assert.equal(stored.body.connected,false);assert.equal(stored.body.connectionStored,true);assert.equal(stored.body.reauthorizationRequired,false);assert.equal(stored.body.availability.available,false);assert.match(stored.headers['cache-control'],/no-store/);
    const assets=await get(mappings);assert.equal(assets.status,200);assert.equal(assets.body.totalMappings,1);assert.equal(assets.body.mappings[0].assets.ad_accounts[0].metaAssetName,'Cuenta ficticia A');assert(!JSON.stringify([stored,assets]).includes('SENTINEL'));
    report.firstOpen={queries:queries-baseline,elapsedMs:Date.now()-start};report.checks.push('Expired local credential is not diagnosed remotely: saved identity + paused availability; metadata-only SELECTs and closed mapping projection');
    for(const query of ['', '?clinic_id=59junk','?clinic_id[]=59','?clinic_id=59&group_id=6']) assert.equal((await get('/oauth/meta/connection-status'+query)).status,400);
    report.checks.push('Explicit scope required, malformed IDs/arrays and mismatched group rejected without user fallback');
    await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:71}});
    assert.equal((await get('/oauth/meta/connection-status?group_id=5')).status,403);
    await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:71}});
    assert.equal((await get('/oauth/meta/connection-status?group_id=5')).status,200);
    report.checks.push('Group read requires access to every clinic, not a representative clinic');
    hook=()=>models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:59}});
    assert.equal((await get(mappings)).status,403);await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:59}});
    report.checks.push('Membership revoked during mapping SELECT discards the entire response');
    hook=()=>models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});
    assert.equal((await get(mappings)).status,401);token=(await sessions.authenticated(user)).body.token;
    report.checks.push('Real SQL session revoked during read returns 401 and no metadata');
    hook=()=>models.MetaConnectionAssignment.update({metaConnectionId:2},{where:{scopeKey:'clinic:59'}});
    assert.equal((await get(mappings)).status,409);await models.MetaConnectionAssignment.update({metaConnectionId:1},{where:{scopeKey:'clinic:59'}});
    report.checks.push('Connection reassignment during read returns 409, never a mixed identity/inventory');
    hook=()=>models.MetaScopeBlock.create({scope_key:'meta:clinic:59',reason:'scope_disconnected',connection_id:1,created_at:new Date()});
    assert.equal((await get(mappings)).status,409);assert.equal((await get(status)).body.connectionStored,false);assert.equal((await get(mappings)).body.totalMappings,0);
    await models.MetaScopeBlock.destroy({where:{}}); // owned fixture reset, never production
    report.checks.push('Durable non-WhatsApp scope block prevents fallback and suppresses stored inventory');
    failSql=true;const failure=await get(status);assert.equal(failure.status,503);assert.equal(failure.body.error,'meta_metadata_unavailable');assert(!JSON.stringify(failure).includes('SENTINEL'));failSql=false;
    assert.equal((await get('/oauth/meta/assets?clinic_id=59')).status,503);
    report.checks.push('SQL failure sanitized; live inventory remains quarantined before credentials');
    await models.ClinicMetaAsset.bulkCreate(Array.from({length:1000},(_,i)=>({id:100+i,metaConnectionId:1,clinicaId:59,assignmentScope:'clinic',assetType:'ad_account',metaAssetId:'act_'+(3000000+i),metaAssetName:'Cuenta de límite ficticia'})));
    const overLimit=await get(mappings);assert.equal(overLimit.status,503);assert.equal(overLimit.body.error,'meta_metadata_limit');assert.equal(overLimit.body.mappings,undefined);
    await models.ClinicMetaAsset.destroy({where:{id:{[require('sequelize').Op.gte]:100}}});
    report.checks.push('1001 mappings rejected as a bounded error, never presented as a partial inventory');
    const durations=[],startQueries=queries;
    for(let i=0;i<8;i++){const t=Date.now();assert.equal((await get(status)).status,200);assert.equal((await get(mappings)).status,200);durations.push(Date.now()-t);}
    report.repeatedOpens={count:8,queries:queries-startQueries,minMs:Math.min(...durations),maxMs:Math.max(...durations)};
    if(process.env.META_METADATA_VISUAL==='1') await require('./fixtures/meta_connection_metadata_visual.fixture')({app,server,report,token:()=>token,reads:()=>mappingReads,models,gates});
    assert.equal(tokenReads,0);report.tokenSelects=tokenReads;report.mappingReads=mappingReads;
    report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};
    assert.equal(report.pool.inUse,0);assert.equal(report.pool.waiting,0);
  } finally {agent.destroy();await new Promise(r=>{server.close(r);server.closeAllConnections();});}
}).catch(()=>{process.exitCode=1;});
