'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createGoogleOAuthAdmissionPublication } = require('../../services/googleOAuthAdmissionPublication.service');
const { createGoogleOAuthAdmissionAuthority } = require('../../services/googleOAuthAdmissionAuthority.service');
const { createGoogleOAuthAdmissionAttempts } = require('../../services/googleOAuthAdmissionAttempt.repository');
const { createGoogleOAuthAdmissionCoordinator } = require('../../services/googleOAuthAdmissionCoordinator.service');
const oauth = require('../../services/googleOAuthCohort.contract');
const { authorizeConnection,authorize } = require('../../services/googleOAuthCohortScope.service');
const { createReviewedAnalyticsMapping } = require('../../services/googleReviewedAnalyticsMapping.service');
const { createReviewedPropertyReader } = require('../../services/analyticsBroker.service');
const { site } = require('../../../services/integrations-broker/src/google-search-console-contract');
const { BrokerStore } = require('../../../services/integrations-broker/src/store');
const { createFirstGoogleJournal,stateDigest } = require('../../../services/integrations-broker/src/google-first-identity-journal');
const { createFirstGooglePublicationJournal } = require('../../../services/integrations-broker/src/google-first-publication-journal');
const { requiredScopesFor } = require('../../../services/integrations-broker/src/google-first-identity-provider');
const { createGoogleOAuthAdmissionRuntime } = require('../../services/googleOAuthAdmissionRuntime.service');

const migration = file => require('../../../migrations/' + file);
const relative = {
  Clinica:'clinica', GrupoClinica:'grupoclinica', UsuarioClinica:'usuarioclinica', GoogleConnection:'googleconnection',
  GoogleConnectionAssignment:'googleconnectionassignment', ClinicBusinessLocation:'clinicbusinesslocation',
  BusinessProfileBrokerBinding:'businessprofilebrokerbinding', BusinessProfileBrokerRevocation:'businessprofilebrokerrevocation',
  ClinicGoogleAdsAccount:'clinicgoogleadsaccount', GoogleAdsBrokerBinding:'googleadsbrokerbinding', GoogleAdsBrokerRevocation:'googleadsbrokerrevocation',
  GroupAssetClinicAssignment:'groupassetclinicassignment',
};

async function prepare(sql, models) {
  for (const [name,file] of Object.entries(relative)) {
    const model = require('../../../models/' + file)(sql,DataTypes);
    models[name] = model;
    for (const attribute of Object.values(model.rawAttributes)) delete attribute.references;
    model.refreshAttributes();
    await model.sync();
  }
  const qi = sql.getQueryInterface();
  for (const name of ['20250910094000-create-clinic-web-assets','20250918120000-create-clinic-analytics-properties',
    '20260913020000-create-google-oauth-broker-flows','20260913030000-add-search-console-broker-read-binding',
    '20260913050000-scope-search-console-bindings-by-mapping',
    '20260913040000-add-analytics-broker-read-binding','20260913060000-create-google-property-broker-revocations',
    '20260913070000-scope-google-oauth-by-service','20260912210000-create-platform-audit-events',
    '20260913003000-add-platform-audit-result-part',
    '20261122223000-create-google-oauth-admission-attempts','20261122224500-create-google-oauth-admission-returns',
    '20261122225000-create-google-oauth-admission-publications']) await migration(name).up(qi,require('sequelize'));
  for (const [name,file] of Object.entries({ ClinicWebAsset:'clinicwebasset',SearchConsoleBrokerBinding:'searchconsolebrokerbinding',
    ClinicAnalyticsProperty:'clinicanalyticsproperty', AnalyticsBrokerBinding:'analyticsbrokerbinding',
    GoogleOAuthBrokerBinding:'googleoauthbrokerbinding', GooglePropertyBrokerRevocation:'googlepropertybrokerrevocation',
    GoogleOAuthAdmissionAttempt:'googleoauthadmissionattempt', GoogleOAuthAdmissionPublication:'googleoauthadmissionpublication',
    GoogleOAuthAdmissionReturn:'googleoauthadmissionreturn',PlatformAuditEvent:'platformauditevent' })) {
    models[name] = require('../../../models/' + file)(sql,DataTypes);
  }
  await sql.query('CREATE TABLE fixture_google_first_audit (attempt_id CHAR(36) PRIMARY KEY)');
  models.GoogleOAuthBrokerRequest = require('../../../models/googleoauthbrokerrequest')(sql,DataTypes);
  models.Usuario = require('../../../models/usuario')(sql,DataTypes);
  models.AuthSession = require('../../../models/authsession')(sql,DataTypes);
}

withIsolatedCampaignMysql(async ({ sql,models,report }) => {
  await prepare(sql,models);
  const stamp = Math.floor(Date.now()/1000)*1000;
  const sessionRef = randomUUID(), actorId = 501, exp = (stamp+1800000)/1000;
  const state = { now:stamp, denySession:false, roleAfterAudit:null, heldOwnerRead:null, ownerVerifier:null, calls:0, aborts:0 };
  const now = () => new Date(state.now);
  const sessions = {
    async verifyNormal(token) {
      assert.equal(token,'fictitious.publisher.jwt');
      if (state.denySession) throw Object.assign(Error('PRIMARY_AUTH_FAILURE'),{ status:401 });
      return { type:'cc_access',sessionVersion:1,userId:actorId,jti:sessionRef,exp };
    },
    async verifyNormalReference({ userId,sessionRef:requested,expiresAt },{ transaction }) {
      assert(transaction?.LOCK?.UPDATE);
      assert.deepEqual({ userId,requested,expiresAt },{ userId:actorId,requested:sessionRef,expiresAt:new Date(exp*1000) });
      if(state.denySession) throw Object.assign(Error('PRIMARY_AUTH_FAILURE'),{ status:401 });
    },
  };
  sessions.verifyReference = sessions.verifyNormalReference;
  const readSession = { headers:{ authorization:'Bearer fictitious.publisher.jwt' }, userData:{ userId:actorId }, authSession:{ id:sessionRef,expiresAt:exp } };
  const authority = createGoogleOAuthAdmissionAuthority({ models,sessions,now });
  const unused = async () => assert.fail('Unexpected Owner operation');
  const coordinator = createGoogleOAuthAdmissionCoordinator({
    model:models.GoogleOAuthAdmissionAttempt, publicationModel:models.GoogleOAuthAdmissionPublication,
    sequelize:sql, authority, now, owner:{
      begin:unused, status:unused, finish:unused,
      async abort(proof) {
        state.aborts++;
        return { ...proof,state:'aborted',authorizationConfirmed:false,connected:false };
      },
    },
  });
  const replies = new Map();
  const publisher = createGoogleOAuthAdmissionPublication({ models,authority,now,owner:{ async verifyPublication(input) {
    state.calls++;
    assert.deepEqual(Object.keys(input).sort(),['assetRef','attemptId','bindingDigest','clinicId','clinicSetDigest','expiresAt','scopeKey','service']);
    assert(!JSON.stringify(input).includes('jwt') && !JSON.stringify(input).includes(sessionRef));
    if (state.ownerVerifier) return state.ownerVerifier(input);
    const receipt = replies.get(input.attemptId);
    assert(receipt);
    if (state.heldOwnerRead) await state.heldOwnerRead();
    return { ...receipt, bindingDigest:input.bindingDigest, clinicSetDigest:input.clinicSetDigest };
  } },async audit(record,{ transaction }) {
    await sql.query('INSERT INTO fixture_google_first_audit (attempt_id) VALUES (?)',{ replacements:[record.attempt_id],transaction });
    if (state.roleAfterAudit !== null) {
      await models.UsuarioClinica.update({ rol_clinica:'personaldeclinica' },{ where:{ id_usuario:actorId,id_clinica:state.roleAfterAudit },transaction });
    }
  } });

  const clinics = { 51:9, 52:9, 53:10, 54:10, 61:null, 62:null, 63:null, 64:null, 74:20, 75:20 };
  await models.GrupoClinica.bulkCreate([9,10,20].map(id_grupo => ({ id_grupo,nombre_grupo:`Grupo ficticio ${id_grupo}` })));
  await models.Clinica.bulkCreate(Object.entries(clinics).map(([id,grupoClinicaId]) => ({ id_clinica:Number(id),
    nombre_clinica:'Sede ficticia',grupoClinicaId,estado_clinica:true })));
  await models.UsuarioClinica.bulkCreate(Object.keys(clinics).map(id_clinica => ({ id_usuario:actorId,id_clinica:Number(id_clinica),
    rol_clinica:'propietario',estado_invitacion:'aceptada' })));

  const oldSubject = 'fictitious_shared_google', anchorId = 81, inheritedVersion = randomUUID();
  await models.GoogleConnection.create({ id:anchorId,googleUserId:oldSubject,userId:null,accessToken:null,refreshToken:null });
  await models.GoogleConnectionAssignment.bulkCreate([9,10].map(grupoClinicaId => ({ googleConnectionId:anchorId,
    scopeKey:'group:'+grupoClinicaId,assignmentScope:'group',grupoClinicaId,status:'active' })));
  const earlier = (await models.GoogleOAuthBrokerBinding.create({ google_connection_id:anchorId,google_user_id:oldSubject,
    cohort:'analytics',clinica_id:51,connection_ref:'fixture:ga:canonical',asset_ref:'ga4:99',scope_key:'connection:81',
    policy_version:oauth.POLICY,secret_version:inheritedVersion,confirmed_at:new Date(stamp-5000) })).get({ plain:true });
  await models.GoogleConnection.create({ id:82,googleUserId:'fictitious_other_google',userId:null,accessToken:null,refreshToken:null });
  await models.GoogleConnectionAssignment.create({ googleConnectionId:82,scopeKey:'clinic:75',assignmentScope:'clinic',clinicaId:75,status:'active' });

  const all = () => models.GoogleConnectionAssignment.findAll({ raw:true,order:[['scopeKey','ASC']] });
  const allBindings = () => models.GoogleOAuthBrokerBinding.findAll({ raw:true,order:[['google_user_id','ASC'],['cohort','ASC']] });
  const earlierAssignments = await all();
  const previousBindings = await allBindings();
  const countAudit = async () => Number((await sql.query('SELECT COUNT(*) AS count FROM fixture_google_first_audit'))[0][0].count);

  async function begin(scopeKey,clinicId,service,assetRef,changes) {
    const attemptId = randomUUID(), selection = { attemptId,scopeKey,service,clinicId,assetRef };
    const captured = await authority.capture(readSession,{ attemptId,scopeKey,service });
    const attempts = createGoogleOAuthAdmissionAttempts({ model:models.GoogleOAuthAdmissionAttempt,sequelize:sql,
      authorize:captured.authorize,now });
    await attempts.prepare(captured.context);
    replies.set(attemptId,{ ...selection, receiptId:randomUUID(), googleUserId:'fictitious_new_'+clinicId,
      connectionRef:`google-first:${service}:${scopeKey}`, secretVersion:attemptId, mode:'provisioned',
      observedAt:stamp,validUntil:stamp+300000,status:'confirmed_resource_access',...changes });
    return selection;
  }

  const reused = await begin('group:20',74,'analytics','ga4:123',{ googleUserId:oldSubject,connectionRef:earlier.connection_ref,
    secretVersion:inheritedVersion,mode:'reuse' });
  const [saved,dup] = await Promise.all([publisher.publish(readSession,reused),publisher.publish(readSession,reused)]);
  assert.deepEqual([saved.replayed,dup.replayed].sort(),[false,true]);
  for (const receipt of [saved,dup]) assert.deepEqual({ ...receipt,replayed:false },{ attemptId:reused.attemptId,
    scopeKey:'group:20',service:'analytics',authorizationConfirmed:true,connected:false,configurationPending:true,replayed:false });
  assert.deepEqual(await allBindings(),previousBindings);
  assert.deepEqual((await all()).filter(row => row.scopeKey !== 'group:20'),earlierAssignments);
  assert.equal(await models.GoogleConnection.count(),2);
  assert.equal(await countAudit(),1);
  const requested = scopeKey => sql.transaction(transaction => authorizeConnection({ models,connectionId:anchorId,subject:oldSubject,
    requestScopeKey:scopeKey,actorId,sessionRef,expiresAt:new Date(exp*1000),transaction,sessions }));
  assert.deepEqual((await requested('clinic:74')).clinicIds,[74]);
  await assert.rejects(requested('clinic:75'));
  report.checks.push('Two concurrent publications converge on the same scope and never replace the shared credential or another clinic override. The existing scoped reader authorizes only the correct clinic.');

  const cancel = ({ attemptId,scopeKey,service }) => coordinator.cancel(readSession,{ attemptId,scopeKey,service },{ expectedRevision:0 });
  await assert.rejects(cancel(reused),{ status:409 });
  assert.equal(state.aborts,0);
  assert.equal(await models.GoogleOAuthAdmissionPublication.count({ where:{ attempt_id:reused.attemptId } }),1);
  const inFlight = await begin('clinic:63',63,'analytics','ga4:789',{});
  const reading = Promise.withResolvers(), release = Promise.withResolvers();
  state.heldOwnerRead = () => { reading.resolve(); return release.promise; };
  const rejected = assert.rejects(publisher.publish(readSession,inFlight),{ status:409 });
  await reading.promise;
  try {
    assert.equal((await cancel(inFlight)).state,'cancelled');
    assert.equal(state.aborts,1);
  } finally {
    state.heldOwnerRead = null;
    release.resolve();
  }
  await rejected;
  assert.equal(await models.GoogleOAuthAdmissionPublication.count({ where:{ attempt_id:inFlight.attemptId } }),0);
  assert.equal(await models.GoogleConnection.count({ where:{ googleUserId:'fictitious_new_63' } }),0);
  report.checks.push('After confirmation, the normal cancel path leaves it intact and never asks Owner to abort. Cancellation during the trusted Owner read wins before publication and creates no mapping or identity.');

  const sameSubject = await begin('clinic:61',61,'analytics','ga4:333',{ googleUserId:oldSubject });
  await assert.rejects(publisher.publish(readSession,sameSubject),{ status:409 });
  assert.deepEqual(await allBindings(),previousBindings);
  assert.equal(await models.GoogleConnection.count(),2);
  report.checks.push('A new physical credential cannot replace the active native binding for a shared Google subject.');

  const first = await begin('clinic:61',61,'analytics','ga4:333',{});
  assert.equal((await publisher.publish(readSession,first)).configurationPending,true);
  const newGoogle = await models.GoogleConnection.findOne({ where:{ googleUserId:'fictitious_new_61' },raw:true });
  assert.equal(newGoogle.accessToken,null);
  assert.equal(newGoogle.refreshToken,null);
  const newBinding = await models.GoogleOAuthBrokerBinding.findOne({ where:{ google_connection_id:newGoogle.id,cohort:'analytics' },raw:true });
  assert.equal(newBinding.secret_version,first.attemptId);
  assert.equal(newBinding.asset_ref,'ga4:333');
  const descriptor = { descriptorId:randomUUID(),clinicId:61,scopeKey:'clinic:61',clinicIds:[61],connectionId:newGoogle.id,
    googleUserId:newGoogle.googleUserId,connectionRef:newBinding.connection_ref,authorizationBindingDigest:oauth.digest(newBinding),
    propertyName:'properties/333',assetRef:'ga4:333',credentialVersion:newBinding.secret_version,reviewedAtEpochMs:stamp,expiresAtEpochMs:stamp+300000 };
  const readProperty = createReviewedPropertyReader({ async execute(command) {
    assert.equal(command.tenantRef,'clinic:61'); assert.equal(command.assetRef,'ga4:333');
    return { data:{ name:'properties/333',displayName:'Consulta ficticia',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/9',account:'accounts/9' } };
  } });
  const mapper = createReviewedAnalyticsMapping({ models,sessions,readProperty,descriptors:() => [descriptor],enabled:() => true,now:() => stamp });
  const mapped = await mapper.map({ scopeKey:'clinic:61',actorId,sessionRef,sessionExpiresAt:exp*1000,connectionId:newGoogle.id,
    clinicIds:[61],revalidate:async () => {} },{ mappings:[{ clinicaId:61,propertyName:'properties/333' }] });
  assert.equal((await models.ClinicAnalyticsProperty.findByPk(mapped.assets[0].id)).clinicaId,61);
  assert.equal(await models.AnalyticsBrokerBinding.count(),1);
  assert.deepEqual((await sql.transaction(transaction => authorize({ models,binding:newBinding,requestScopeKey:'clinic:61',
    actorId,sessionRef,expiresAt:new Date(exp*1000),transaction,sessions }))).clinicIds,[61]);
  report.checks.push('The first confirmed identity creates the connection and native GA4 authorization metadata atomically. The reviewed GA4 writer adds the exact first property, after which the unchanged native reader authorizes the scope.');

  const denied = await begin('clinic:62',62,'analytics','ga4:555',{});
  state.roleAfterAudit = 62;
  await assert.rejects(publisher.publish(readSession,denied),{ status:403 });
  state.roleAfterAudit = null;
  assert.equal(await models.GoogleConnection.count({ where:{ googleUserId:'fictitious_new_62' } }),0);
  assert.equal(await models.GoogleOAuthAdmissionPublication.count({ where:{ attempt_id:denied.attemptId } }),0);
  assert.equal(await countAudit(),2);
  assert.equal((await models.UsuarioClinica.findOne({ where:{ id_usuario:actorId,id_clinica:62 } })).rol_clinica,'propietario');
  report.checks.push('A role denial after writing the publication and audit rolls back the new identity, scope, binding, audit and role mutation together.');

  const incorrect = await begin('clinic:63',63,'analytics','ga4:777',{ assetRef:'ga4:888' });
  await assert.rejects(publisher.publish(readSession,incorrect),{ status:409 });
  const revoked = await begin('clinic:63',63,'analytics','ga4:777',{});
  await models.GooglePropertyBrokerRevocation.create({ tuple_hash:'f'.repeat(64),kind:'analytics',resource:'properties/777',
    connection_ref:'fixture:prior',asset_ref:'ga4:777',clinica_id:63,google_connection_id:81,google_user_id:oldSubject,
    request_id:randomUUID(),actor_user_id:actorId,requested_at:now(),next_attempt_at:now(),state:'confirmed',confirmed_at:now() });
  await assert.rejects(publisher.publish(readSession,revoked),{ status:409 });
  assert.equal(await models.GoogleConnection.count({ where:{ googleUserId:'fictitious_new_63' } }),0);
  await models.GoogleConnectionAssignment.destroy({ where:{ scopeKey:'group:20' } });
  await assert.rejects(publisher.publish(readSession,reused),{ status:409 });
  assert.equal(await models.GoogleConnectionAssignment.count({ where:{ scopeKey:'group:20' } }),0);
  await assert.rejects(migration('20261122225000-create-google-oauth-admission-publications').down(sql.getQueryInterface()),
    { message:'google_oauth_admission_publications_have_history' });
  report.checks.push('A mismatched asset receipt, explicit tombstone or removed assignment after a committed attempt is never repaired or silently reactivated. The migration preserves history.');

  const firstSite = site('sc-domain:fictitious-first.example'), prefix = site('https://fictitious-first.example/another/');
  const resource = { siteUrl:firstSite.siteUrl,permissionLevel:'siteFullUser' };
  const badSite = await begin('clinic:62',62,'search_console',firstSite.assetRef,{ resource:{ ...resource,siteUrl:prefix.siteUrl } });
  await assert.rejects(publisher.publish(readSession,badSite),{ status:409 });
  const badPermission = await begin('clinic:62',62,'search_console',firstSite.assetRef,{ resource:{ ...resource,permissionLevel:'siteUnverifiedUser' } });
  await assert.rejects(publisher.publish(readSession,badPermission),{ status:409 });
  assert.equal(await models.ClinicWebAsset.count(),0);
  assert.equal(await models.GoogleConnection.count({ where:{ googleUserId:'fictitious_new_62' } }),0);
  report.checks.push('An unrelated Search Console property locator or an unverified permission cannot create an identity or mapping.');

  const exactSite = await begin('clinic:62',62,'search_console',firstSite.assetRef,{ resource });
  state.roleAfterAudit = 62;
  await assert.rejects(publisher.publish(readSession,exactSite),{ status:403 });
  state.roleAfterAudit = null;
  assert.equal(await models.ClinicWebAsset.count() + await models.SearchConsoleBrokerBinding.count(),0);
  assert.equal(await models.GoogleOAuthAdmissionPublication.count({ where:{ attempt_id:exactSite.attemptId } }),0);
  assert.equal(await models.GoogleConnection.count({ where:{ googleUserId:'fictitious_new_62' } }),0);
  const scResult = await publisher.publish(readSession,exactSite);
  assert.deepEqual(scResult,{ attemptId:exactSite.attemptId,scopeKey:'clinic:62',service:'search_console',
    authorizationConfirmed:true,connected:true,configurationPending:false,replayed:false });
  const canonicalBinding = await models.GoogleOAuthBrokerBinding.findOne({ where:{ google_user_id:'fictitious_new_62',cohort:'search_console' },raw:true });
  assert.deepEqual((await sql.transaction(transaction => authorize({ models,binding:canonicalBinding,
    requestScopeKey:'clinic:62',actorId,sessionRef,expiresAt:new Date(exp*1000),transaction,sessions }))).clinicIds,[62]);
  const scMapping = await models.ClinicWebAsset.findOne({ where:{ clinicaId:62 },raw:true });
  assert.equal(scMapping.siteUrl,firstSite.siteUrl);
  assert.equal(scMapping.permissionLevel,resource.permissionLevel);
  assert.equal((await publisher.publish(readSession,exactSite)).replayed,true);
  await models.ClinicWebAsset.destroy({ where:{ id:scMapping.id } });
  await assert.rejects(publisher.publish(readSession,exactSite),{ status:409 });
  assert.equal(await models.ClinicWebAsset.count(),0);
  assert.equal(await models.SearchConsoleBrokerBinding.count(),1);
  report.checks.push('The first Search Console property, native binding, identity and audit roll back together. Once confirmed the ordinary reader accepts the fresh binding, exact retry does not write, and a removed mapping is never restored by replay.');

  // Join the real SQLite Owner journals to the real SQL publisher. Google
  // resource approval and Secrets Manager readback remain explicit fixtures.
  const ownerDir = fs.mkdtempSync(path.join(os.tmpdir(),'cc-first-owner-sql-'));
  const store = new BrokerStore(path.join(ownerDir,'qa.sqlite'));
  try {
    const proofClock = () => stamp;
    const first = createFirstGoogleJournal({ store,now:proofClock });
    const ledger = createFirstGooglePublicationJournal({ store,journal:first,now:proofClock,
      approvedScopes:[{ scopeKey:'group:9',clinicIds:[51,52],services:['search_console'] }] });
    const exact = site('sc-domain:fictitious-group.example');
    const selection = await begin('group:9',51,'search_console',exact.assetRef,{});
    let activations = 0;
    const stateNonce = randomBytes(32).toString('base64url');
    const contextDigest = 'a'.repeat(64);
    state.ownerVerifier = async request => {
      const { attemptId,bindingDigest,service,expiresAt,scopeKey,clinicId,assetRef,clinicSetDigest } = request;
      const proof = { attemptId,bindingDigest,service,expiresAt };
      const owner = { principalId:'crm:qa:google-first-oauth',tenantRef:'clinic:51',
        connectionRef:'google-first:'+attemptId,assetRef:'google-oauth:'+service+':'+scopeKey };
      const chosen = { scopeKey,clinicId,assetRef };
      if (activations) return ledger.read(proof,owner).receipt;
      const application = { stateHash:stateDigest(stateNonce),providerContextDigest:contextDigest,
        applicationVersion:randomUUID(),clientId:'fictitious-first.apps.googleusercontent.com' };
      first.prepare(proof,owner,application);
      const exchange = first.consume(proof,owner,{ state:stateNonce,code:Buffer.from('FICTITIOUS_CODE'),providerContextDigest:contextDigest });
      first.exchangeReady(exchange,{ version:1,attemptId,bindingDigest,service,provider:'google_'+service,
        googleUserId:oldSubject,clientId:application.clientId,scopes:requiredScopesFor(service),observedAt:stamp,
        accessExpiresAt:stamp+3600000,refreshTokenExpiresAt:null,connected:false,authorizationConfirmed:false });
      const stage = { stageRequestId:randomUUID(),versionId:attemptId,digest:'b'.repeat(64),slotDigest:'c'.repeat(64),
        baselineVersion:randomUUID(),metadataDigest:first.getPrivateState(proof,owner).metadataDigest };
      first.commitStageIntent(proof,owner,stage);
      first.acceptStageReceipt(proof,owner,{ ...stage,status:'staged',accessBlocked:true });
      const pinned = ledger.preflight(proof,owner,chosen);
      assert.equal(pinned.clinicSetDigest,clinicSetDigest);
      ledger.approve(proof,owner,chosen,{ approvalId:randomUUID(),selectionDigest:pinned.selectionDigest,
        credentialDigest:pinned.credentialDigest,observedAt:stamp,validUntil:stamp+60000,
        resource:{ siteUrl:exact.siteUrl,permissionLevel:'siteOwner' } });
      const activationRequestId = randomUUID();
      const permit = ledger.commitActivationIntent(proof,owner,{ activationRequestId });
      assert.equal(ledger.consumeActivationPermit(permit,proof,owner),true);
      activations++;
      return ledger.acceptActivationReceipt(proof,owner,{ activationRequestId,version:attemptId,
        secretDigest:stage.digest,status:'confirmed_current' }).receipt;
    };
    assert.equal((await publisher.publish(readSession,selection)).connected,true);
    assert.equal((await publisher.publish(readSession,selection)).replayed,true);
    assert.equal(activations,1);
    assert.equal(await models.GoogleConnection.count({ where:{ googleUserId:oldSubject } }),1);
    assert.deepEqual(await models.GoogleOAuthBrokerBinding.findOne({ where:{ google_user_id:oldSubject,cohort:'analytics' },raw:true }),earlier);
    assert.equal(await models.ClinicWebAsset.count({ where:{ clinicaId:51,siteUrl:exact.siteUrl } }),1);
    assert.equal(await models.ClinicWebAsset.count({ where:{ clinicaId:52,siteUrl:exact.siteUrl } }),0);
    report.checks.push('The real Owner and CRM journals accept the same immutable scoped Search Console receipt. Group confirmation binds only the selected clinic, keeps its Analytics cohort, and never repeats activation.');
  } finally {
    state.ownerVerifier = null;
    store.close();
    fs.rmSync(ownerDir,{ recursive:true,force:true });
  }

  const signedSite = site('sc-domain:fictitious-signed-runtime.example');
  const signedSelection = await begin('clinic:64',64,'search_console',signedSite.assetRef,{
    resource:{ siteUrl:signedSite.siteUrl,permissionLevel:'siteOwner' },
  });
  const { attemptId } = signedSelection;
  const requests = [];
  const selectedScope = { attemptId,scopeKey:'clinic:64',service:'search_console' };
  const selectedAsset = { assetRef:signedSite.assetRef,siteUrl:signedSite.siteUrl,clinicIds:[64] };
  const readChecks = [];
  let readerAvailable = false;
  let nativeVerified = false;
  let catalogue = [selectedAsset];
  let loseRoleDuringCatalogue = false;
  let expireAfterCatalogueLookup = false;
  const originalFindPublication = models.GoogleOAuthAdmissionPublication.findByPk;
  const runtime = createGoogleOAuthAdmissionRuntime({
    config:{ schema:'clinicaclick-google-first-admission-crm/1',environment:'staging',startsEnabled:false,publicationEnabled:true,
      origin:'https://owner.example.invalid/',keyId:'test-only',keyFile:'/etc/example/key',caFile:'/etc/example/ca',
      clientId:'fictitious.apps.googleusercontent.com',redirectUri:'https://crm.example.invalid/oauth/google/callback',
      scopes:[{ scopeKey:'clinic:64',clinicIds:[64],services:['search_console'] }],
    },
    environment:'staging',models,sessions,now,readFile:() => Buffer.from('FICTITIOUS_PIN'),
    readAuthority:{
      available({ scopeKey,service,clinicIds }) {
        assert.deepEqual({ scopeKey,service,clinicIds },{ scopeKey:'clinic:64',service:'search_console',clinicIds:[64] });
        return readerAvailable;
      },
      async verify({ receipt,context }) {
        assert.equal(receipt.resource.siteUrl,signedSite.siteUrl);
        assert.equal(receipt.secretVersion,attemptId);
        assert.deepEqual(context.clinicIds,[64]);
        readChecks.push(receipt.receiptId);
        return nativeVerified;
      },
    },
    clientFactory:() => ({ async execute(request,options) {
      assert.equal(request.tenantRef,'clinic:64');
      assert.equal(request.connectionRef,'google-first:'+attemptId);
      assert.equal(request.assetRef,'google-oauth:search_console:clinic:64');
      assert(!JSON.stringify(request).includes(sessionRef));
      let data;
      if (request.operation === 'google.oauth.admission.status.v1') {
        const { clinicSetDigest,...proof } = request.payload;
        assert.equal(options.timeoutMs,10000);
        data = { ...proof,state:'candidate_staged',authorizationConfirmed:false,connected:false };
      } else if (request.operation === 'google.oauth.admission.catalogue.ready.v1') {
        assert.equal(options.timeoutMs,10000);
        data = { ...selectedScope,canChooseAssets:true };
      } else if (request.operation === 'google.oauth.admission.catalogue.v1') {
        assert.equal(options.timeoutMs,25000);
        if (loseRoleDuringCatalogue) await models.UsuarioClinica.update({ rol_clinica:'personaldeclinica' },
          { where:{ id_usuario:actorId,id_clinica:64 } });
        if (expireAfterCatalogueLookup) {
          models.GoogleOAuthAdmissionPublication.findByPk = async function(id,options) {
            const result = await originalFindPublication.call(this,id,options);
            if (id === attemptId && options?.attributes?.[0] === 'attempt_id') state.now = stamp+600001;
            return result;
          };
        }
        data = { ...selectedScope,assets:catalogue };
      } else {
        assert.equal(request.operation,'google.oauth.admission.publication.verify.v1');
        assert.equal(request.payload.selectedAssetRef,signedSite.assetRef);
        assert.equal(request.payload.clinicId,64);
        assert.equal(options.timeoutMs,25000);
        requests.push(request.requestId);
        data = { ...replies.get(attemptId),bindingDigest:request.payload.bindingDigest,clinicSetDigest:request.payload.clinicSetDigest };
      }
      return { requestId:request.requestId,replayed:false,data };
    } }),
  });

  assert.equal((await runtime.status(readSession,selectedScope)).canChooseAssets,undefined);
  await assert.rejects(runtime.assets(readSession,selectedScope),{ status:503 });
  await assert.rejects(runtime.publish(readSession,signedSelection),{ status:503 });
  assert.equal(requests.length,0);
  readerAvailable = true;
  assert.equal((await runtime.status(readSession,selectedScope)).canChooseAssets,true);
  assert.deepEqual(await runtime.assets(readSession,selectedScope),{ ...selectedScope,assets:[selectedAsset] });
  catalogue = [{ ...selectedAsset,clinicIds:[63] }];
  await assert.rejects(runtime.assets(readSession,selectedScope),{ status:503 });
  catalogue = [selectedAsset];
  loseRoleDuringCatalogue = true;
  await assert.rejects(runtime.assets(readSession,selectedScope),{ status:403 });
  loseRoleDuringCatalogue = false;
  await models.UsuarioClinica.update({ rol_clinica:'propietario' },{ where:{ id_usuario:actorId,id_clinica:64 } });
  expireAfterCatalogueLookup = true;
  await assert.rejects(runtime.assets(readSession,selectedScope),{ status:409 });
  models.GoogleOAuthAdmissionPublication.findByPk = originalFindPublication;
  state.now = stamp;
  expireAfterCatalogueLookup = false;
  assert.equal(await models.ClinicWebAsset.count({ where:{ siteUrl:signedSite.siteUrl } }),0);
  assert.equal(await models.PlatformAuditEvent.count(),0);
  report.checks.push('The status and signed catalogue require the original session and normal reader. Revocation during catalogue and foreign destinations never release a property.');

  await assert.rejects(runtime.publish(readSession,signedSelection),{ status:503 });
  assert.equal(await models.ClinicWebAsset.count({ where:{ siteUrl:signedSite.siteUrl } }),0);
  assert.equal(await models.PlatformAuditEvent.count(),0);
  nativeVerified = true;
  assert.equal((await runtime.publish(readSession,signedSelection)).connected,true);
  assert.equal((await runtime.publish(readSession,signedSelection)).replayed,true);
  assert.equal(requests.length,3);
  assert.equal(new Set(readChecks).size,1);
  await assert.rejects(runtime.status(readSession,selectedScope),{ status:409 });
  const events = await models.PlatformAuditEvent.findAll({ raw:true });
  assert.equal(events.length,1);
  const event = JSON.parse(events[0].body);
  assert.equal(event.reason,'activation_confirmed');
  assert.equal(event.correlationId,attemptId);
  assert.deepEqual(event.scope,{ type:'clinic',id:'64' });
  assert.equal(event.assetRef,signedSite.assetRef);
  assert.equal(event.actor.id,String(actorId));
  report.checks.push('The CRM runtime builds its signed publication context from the same authorized scope and commits the native audit event with Search Console; replay adds no audit event.');

  const nativeGa = await begin('clinic:62',62,'analytics','ga4:777',{});
  const gaResource = { name:'properties/777',displayName:'Primera GA ficticia',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/9',account:'accounts/9' };
  let allowGaNative=false,gaVerifyCount=0,gaDuringVerify=null;
  const subjectDigest=require('../../../services/integrations-broker/src/google-property-discovery-contract').firstAnalyticsSubjectDigest;
  const gaPublisher=createGoogleOAuthAdmissionPublication({ models,authority,now,owner:{
   async previewIdentity(input) { const receipt=replies.get(input.attemptId);return { attemptId:input.attemptId,scopeKey:input.scopeKey,service:'analytics',googleUserId:receipt.googleUserId,subjectDigest:subjectDigest(receipt.googleUserId) }; },
   async verifyPublication(input) {
    gaVerifyCount++;assert.equal(input.expectedSubjectDigest,subjectDigest(replies.get(input.attemptId).googleUserId));await gaDuringVerify?.();
    return { ...replies.get(input.attemptId),bindingDigest:input.bindingDigest,clinicSetDigest:input.clinicSetDigest };
  } },verifyNativeAccess:async ({ receipt,context })=>{
    assert.equal(receipt.assetRef,'ga4:777');assert.equal(receipt.service,'analytics');assert.deepEqual(context.clinicIds,[62]);
    return allowGaNative ? gaResource : false;
  },async audit(record,{ transaction }) { await sql.query('INSERT INTO fixture_google_first_audit (attempt_id) VALUES (?)',{ replacements:[record.attempt_id],transaction }); } });
  const gaCounts = async()=>({ connections:await models.GoogleConnection.count(),mappings:await models.ClinicAnalyticsProperty.count(),
    bindings:await models.AnalyticsBrokerBinding.count(),publications:await models.GoogleOAuthAdmissionPublication.count(),audit:await countAudit() });
  const beforeGa=await gaCounts();await assert.rejects(gaPublisher.publish(readSession,nativeGa),{ status:503 });assert.deepEqual(await gaCounts(),beforeGa);
  allowGaNative=true;
  assert.deepEqual(await gaPublisher.publish(readSession,nativeGa),{ attemptId:nativeGa.attemptId,scopeKey:'clinic:62',service:'analytics',authorizationConfirmed:true,connected:true,configurationPending:false,replayed:false });
  const nativeGaConnection=await models.GoogleConnection.findOne({ where:{ googleUserId:'fictitious_new_62' },raw:true });
  assert.equal(nativeGaConnection.accessToken,null);assert.equal(nativeGaConnection.refreshToken,null);
  const nativeGaMapping=await models.ClinicAnalyticsProperty.findOne({ where:{ clinicaId:62,propertyName:'properties/777' },raw:true });
  assert.equal(nativeGaMapping.googleConnectionId,nativeGaConnection.id);assert.equal(nativeGaMapping.propertyDisplayName,gaResource.displayName);
  assert.equal(nativeGaMapping.propertyType,gaResource.propertyType);assert.equal(nativeGaMapping.parent,gaResource.parent);
  assert.equal(nativeGaMapping.broker_read_connection_ref,'google-first:analytics:clinic:62');assert.equal(nativeGaMapping.broker_read_asset_ref,'ga4:777');
  const nativeGaBinding=await models.AnalyticsBrokerBinding.findOne({ where:{ mapping_id:nativeGaMapping.id },raw:true });
  assert.equal(nativeGaBinding.property_name,'properties/777');assert.equal(nativeGaBinding.google_user_id,'fictitious_new_62');assert.equal(nativeGaBinding.state,'active');
  const afterGa=await gaCounts();assert.equal((await gaPublisher.publish(readSession,nativeGa)).replayed,true);assert.deepEqual(await gaCounts(),afterGa);
  await models.ClinicAnalyticsProperty.update({ isActive:false },{ where:{ id:nativeGaMapping.id } });
  await assert.rejects(gaPublisher.publish(readSession,nativeGa),{ status:409 });
  assert.equal((await models.ClinicAnalyticsProperty.findByPk(nativeGaMapping.id)).isActive,false);
  assert.deepEqual(await gaCounts(),afterGa);
  report.checks.push('GA4 native verification denies before business SQL writes; exact projected native metadata, identity, allocation, OAuth binding, mapping, scoped Analytics binding and audit commit together. Exact retry is inert and never restores a disabled mapping.');

  const gaRuntimeSelection=await begin('clinic:63',63,'analytics','ga4:888',{}),gaSelectedScope={ attemptId:gaRuntimeSelection.attemptId,scopeKey:'clinic:63',service:'analytics' };
  const gaRuntimeResource={ ...gaResource,name:'properties/888' },gaRow={ assetRef:'ga4:888',propertyName:'properties/888',displayName:gaResource.displayName,clinicIds:[63] };
  let gaNative=false,gaCatalogue=[gaRow],gaRevokeRole=false;const gaSigned=[];
  const gaRuntime=createGoogleOAuthAdmissionRuntime({
    config:{ schema:'clinicaclick-google-first-admission-crm/1',environment:'staging',startsEnabled:false,publicationEnabled:true,
      origin:'https://owner.example.invalid/',keyId:'test-only',keyFile:'/etc/example/key',caFile:'/etc/example/ca',
      clientId:'fictitious.apps.googleusercontent.com',redirectUri:'https://crm.example.invalid/oauth/google/callback',
      scopes:[{ scopeKey:'clinic:63',clinicIds:[63],services:['analytics'] }] },environment:'staging',models,sessions,now,
    readFile:()=>Buffer.from('FICTITIOUS_PIN'),readAuthority:{ available:()=>true,verify:async()=>gaNative ? gaRuntimeResource : false },
    clientFactory:()=>({ async execute(request) {
      gaSigned.push(request);assert.equal(request.tenantRef,'clinic:63');assert.equal(request.connectionRef,'google-first:'+gaRuntimeSelection.attemptId);
      assert.equal(request.assetRef,'google-oauth:analytics:clinic:63');assert(!JSON.stringify(request).includes(sessionRef));let data;
      if(request.operation==='google.oauth.admission.identity.preview.v1'){
        const receipt=replies.get(gaRuntimeSelection.attemptId);data={ ...gaSelectedScope,googleUserId:receipt.googleUserId,subjectDigest:subjectDigest(receipt.googleUserId) };
      }else if(request.operation==='google.oauth.admission.status.v1'){ const { clinicSetDigest,...proof }=request.payload;data={ ...proof,state:'candidate_staged',authorizationConfirmed:false,connected:false }; }
      else if(request.operation==='google.oauth.admission.catalogue.ready.v1')data={ ...gaSelectedScope,canChooseAssets:true };
      else if(request.operation==='google.oauth.admission.catalogue.v1'){
        if(gaRevokeRole)await models.UsuarioClinica.update({ rol_clinica:'personaldeclinica' },{ where:{ id_usuario:actorId,id_clinica:63 } });
        data={ ...gaSelectedScope,assets:gaCatalogue };
      }else{ assert.equal(request.operation,'google.oauth.admission.publication.verify.v1');assert.equal(request.payload.clinicId,63);assert.equal(request.payload.selectedAssetRef,'ga4:888');assert.equal(request.payload.expectedSubjectDigest,subjectDigest(replies.get(gaRuntimeSelection.attemptId).googleUserId));
        data={ ...replies.get(gaRuntimeSelection.attemptId),bindingDigest:request.payload.bindingDigest,clinicSetDigest:request.payload.clinicSetDigest }; }
      return { requestId:request.requestId,data,replayed:false };
    } }),
  });
  assert.equal((await gaRuntime.capability(readSession,gaSelectedScope)).enabled,false);
  assert.equal((await gaRuntime.status(readSession,gaSelectedScope)).canChooseAssets,true);
  assert.deepEqual(await gaRuntime.assets(readSession,gaSelectedScope),{ ...gaSelectedScope,assets:[gaRow] });
  gaCatalogue=[{ ...gaRow,propertyName:'properties/889' }];await assert.rejects(gaRuntime.assets(readSession,gaSelectedScope),{ status:503 });
  gaCatalogue=[{ ...gaRow,clinicIds:[62] }];await assert.rejects(gaRuntime.assets(readSession,gaSelectedScope),{ status:503 });
  gaCatalogue=[gaRow];gaRevokeRole=true;await assert.rejects(gaRuntime.assets(readSession,gaSelectedScope),{ status:403 });gaRevokeRole=false;
  await models.UsuarioClinica.update({ rol_clinica:'propietario' },{ where:{ id_usuario:actorId,id_clinica:63 } });
  const beforeGaRuntime=await gaCounts();await assert.rejects(gaRuntime.publish(readSession,gaRuntimeSelection),{ status:503 });assert.deepEqual(await gaCounts(),beforeGaRuntime);
  gaNative=true;const gaPublished=await gaRuntime.publish(readSession,gaRuntimeSelection);assert.equal(gaPublished.connected,true);assert.equal(gaPublished.configurationPending,false);
  assert.equal((await gaRuntime.publish(readSession,gaRuntimeSelection)).replayed,true);
  assert.equal(await models.PlatformAuditEvent.count(),2);
  const gaNativeMapping=await models.ClinicAnalyticsProperty.findOne({ where:{ clinicaId:63,propertyName:'properties/888' },raw:true });assert(gaNativeMapping?.isActive);
  assert.equal(await models.AnalyticsBrokerBinding.count({ where:{ mapping_id:gaNativeMapping.id,state:'active' } }),1);
  report.checks.push('Paused GA4 starts preserve current own-session signed readiness/catalogue/confirmation. Noncanonical properties, foreign destinations and a role change during catalogue are closed; rejected normal-reader verification performs zero business writes; exact confirmation/replay creates one native mapping and one transactional platform audit event.');

  const existingOtherClinic=await begin('clinic:74',74,'analytics','ga4:999',{ googleUserId:oldSubject });
  const beforeExistingGa=await gaCounts(),beforeVerify=gaVerifyCount;
  await assert.rejects(gaPublisher.publish(readSession,existingOtherClinic),{ status:409 });
  assert.equal(gaVerifyCount,beforeVerify,'global existing Analytics credential denied before Owner promotion');assert.deepEqual(await gaCounts(),beforeExistingGa);
  const wrongScopeSubject=await begin('clinic:64',64,'analytics','ga4:999',{ googleUserId:'fictitious_wrong_subject' });
  await assert.rejects(gaPublisher.publish(readSession,wrongScopeSubject),{ status:409 });assert.equal(gaVerifyCount,beforeVerify);assert.deepEqual(await gaCounts(),beforeExistingGa);
  const assignmentRace=await begin('clinic:74',74,'analytics','ga4:999',{});
  gaDuringVerify=async()=>{gaDuringVerify=null;await models.GoogleConnectionAssignment.create({ scopeKey:'clinic:74',assignmentScope:'clinic',clinicaId:74,googleConnectionId:anchorId,status:'active' });};
  await assert.rejects(gaPublisher.publish(readSession,assignmentRace),{ status:409 });assert.equal(gaVerifyCount,beforeVerify+1);
  assert.deepEqual(await gaCounts(),beforeExistingGa);assert.equal((await models.GoogleConnectionAssignment.findOne({ where:{ scopeKey:'clinic:74' } })).googleConnectionId,anchorId);
  assert.equal((await models.GoogleOAuthBrokerBinding.findOne({ where:{ google_user_id:oldSubject,cohort:'analytics' } })).secret_version,inheritedVersion);
  report.checks.push('Signed Analytics identity preview checks exact active scope/inheritance and the global canonical subject/cohort before promotion. A different subject and an existing Analytics credential in another clinic make zero promotion calls. Assignment drift during the simulated Owner call blocks native verification and every SQL publication write while preserving the concurrent assignment and established credential. This race may leave an Owner promotion pending, so real activation remains OFF pending reservation/reconciliation design.');

  await models.Clinica.bulkCreate([76,77,78].map(id_clinica=>({ id_clinica,nombre_clinica:'Fixture preclaim',grupoClinicaId:null,estado_clinica:true })));
  await models.UsuarioClinica.bulkCreate([76,77,78].map(id_clinica=>({ id_usuario:actorId,id_clinica,rol_clinica:'propietario',estado_invitacion:'aceptada' })));
  await models.GoogleConnection.create({ id:500,googleUserId:'fictitious_legacy_candidate',userId:null,accessToken:null,refreshToken:null });
  await models.ClinicAnalyticsProperty.create({ clinicaId:61,googleConnectionId:500,propertyName:'properties/445',isActive:true });
  const legacyActive=await begin('clinic:76',76,'analytics','ga4:999',{ googleUserId:'fictitious_legacy_candidate' });
  const beforeLegacyVerify=gaVerifyCount;
  await assert.rejects(gaPublisher.publish(readSession,legacyActive),{ status:409 });assert.equal(gaVerifyCount,beforeLegacyVerify);
  await models.ClinicAnalyticsProperty.create({ clinicaId:77,googleConnectionId:anchorId,propertyName:'properties/999',isActive:false });
  const oldExactTarget=await begin('clinic:77',77,'analytics','ga4:999',{});
  await assert.rejects(gaPublisher.publish(readSession,oldExactTarget),{ status:409 });assert.equal(gaVerifyCount,beforeLegacyVerify);
  await models.GooglePropertyBrokerRevocation.create({ tuple_hash:'e'.repeat(64),kind:'analytics',resource:'properties/999',
    connection_ref:'fixture:prior',asset_ref:'ga4:999',clinica_id:78,google_connection_id:anchorId,google_user_id:oldSubject,
    request_id:randomUUID(),actor_user_id:actorId,requested_at:now(),next_attempt_at:now(),state:'confirmed',confirmed_at:now() });
  const preRevoked=await begin('clinic:78',78,'analytics','ga4:999',{});
  await assert.rejects(gaPublisher.publish(readSession,preRevoked),{ status:409 });assert.equal(gaVerifyCount,beforeLegacyVerify);
  report.checks.push('Known legacy active mappings without a cohort binding, an exact historical/inactive target mapping and resource tombstones all fail the same preclaim before any promotion call; existing rows and credentials remain untouched.');




}).catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
