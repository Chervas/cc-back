'use strict';

// Group settings select already authorized mappings. They never mint an OAuth
// grant, revive an inactive mapping or change a registered resource's owner.
const { Op, literal } = require('sequelize');
const { createHash } = require('node:crypto');
const KINDS = Object.freeze({
  searchConsole: { model: 'ClinicWebAsset', registry: 'SearchConsoleBrokerBinding', gate: 'GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED', clinic: 'clinicaId', active: 'isActive', fields: ['siteUrl','googleConnectionId','broker_read_connection_ref','broker_read_asset_ref'] },
  analytics: { model: 'ClinicAnalyticsProperty', registry: 'AnalyticsBrokerBinding', gate: 'GOOGLE_ANALYTICS_BROKER_ENABLED', clinic: 'clinicaId', active: 'isActive', fields: ['propertyName','googleConnectionId','broker_read_connection_ref','broker_read_asset_ref'] },
  businessProfile: { model: 'ClinicBusinessLocation', registry: 'BusinessProfileBrokerBinding', gate: 'GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED', clinic: 'clinica_id', active: 'is_active', fields: ['location_id','google_connection_id','broker_read_connection_ref','broker_read_asset_ref'] },
  googleAds: { model: 'ClinicGoogleAdsAccount', registry: 'GoogleAdsBrokerBinding', gate: 'GOOGLE_ADS_BROKER_ENABLED', clinic: 'clinicaId', active: 'isActive', fields: ['customerId','googleConnectionId','assignmentScope','grupoClinicaId','loginCustomerId','managerCustomerId','broker_read_connection_ref','broker_read_asset_ref'] },
  metaAds: { model: 'ClinicMetaAsset', registry: 'MetaMarketingBrokerBinding', gate: 'META_MARKETING_BROKER_ENABLED', clinic: 'clinicaId', active: 'isActive', type: 'ad_account', fields: ['metaConnectionId','assetType','metaAssetId','assignmentScope','grupoClinicaId'] },
  facebook: { model: 'ClinicMetaAsset', registry: 'MetaMarketingBrokerBinding', gate: 'META_MARKETING_BROKER_ENABLED', clinic: 'clinicaId', active: 'isActive', type: 'facebook_page', fields: ['metaConnectionId','assetType','metaAssetId','assignmentScope','grupoClinicaId'] },
  instagram: { model: 'ClinicMetaAsset', registry: 'MetaMarketingBrokerBinding', gate: 'META_MARKETING_BROKER_ENABLED', clinic: 'clinicaId', active: 'isActive', type: 'instagram_business', fields: ['metaConnectionId','assetType','metaAssetId','assignmentScope','grupoClinicaId'] },
});
const positive = value => (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const active = value => [true, 1, '1'].includes(value);
const plain = value => value?.get ? value.get({ plain: true }) : value;
const digest = value => createHash('sha256').update(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v)).digest('hex');
class GroupAssetSelectionError extends Error {
  constructor(code = 'group_asset_authority_conflict') {
    super(code === 'group_asset_reconnection_required'
      ? 'Uno de los activos seleccionados ya no tiene una conexión válida. Reconéctalo desde Cuentas conectadas antes de asignarlo. No se han guardado cambios.'
      : 'La autorización o la asignación de uno de los activos ha cambiado. Revisa su conexión antes de asignarlo. No se han guardado cambios.');
    this.code = code; this.status = 409;
  }
}
const conflict = () => { throw new GroupAssetSelectionError(); };
const reconnect = () => { throw new GroupAssetSelectionError('group_asset_reconnection_required'); };
const ASSET_TYPES={searchConsole:'google.search_console',analytics:'google.analytics',businessProfile:'google.business_profile',googleAds:'google.ads_account',metaAds:'meta.ad_account',facebook:'meta.facebook_page',instagram:'meta.instagram_business'};
const PRIMARY_FIELDS={searchConsole:['search_console_assignment_mode','search_console_primary_asset_id'],analytics:['analytics_assignment_mode','analytics_primary_property_id'],businessProfile:['business_profile_assignment_mode','business_profile_primary_location_id'],facebook:['facebook_assignment_mode','facebook_primary_asset_id'],instagram:['instagram_assignment_mode','instagram_primary_asset_id']};
const sections=payload=>({searchConsole:payload.google?.searchConsole,analytics:payload.google?.analytics,
  businessProfile:payload.google?.businessProfile,facebook:payload.meta?.facebook,instagram:payload.meta?.instagram,
  googleAds:payload.adsAccounts?.google,metaAds:payload.adsAccounts?.meta});
function selections(payload, clinicIds) {
  const result = [];
  for (const [kind, section] of Object.entries(sections(payload))) {
    if (!KINDS[kind] || !section) continue;
    if (!['clinic','group'].includes(section.mode)) conflict();
    const ids = new Map();
    if (section.mode === 'group') {
      const id = section.primaryAccountId ?? section.primaryAssetId;
      if (!positive(id)) conflict();
      ids.set(Number(id), clinicIds.slice());
    } else {
      for (const [clinic, id] of Object.entries(section.clinicAssignments || {})) {
        if (id == null || id === '') continue;
        if (!/^[1-9]\d*$/.test(clinic) || !clinicIds.includes(Number(clinic))) conflict();
        if (!positive(id)) conflict();
        if (!ids.has(Number(id))) ids.set(Number(id), []);
        ids.get(Number(id)).push(Number(clinic));
      }
    }
    for (const [id, destinations] of ids) result.push({kind,id,destinations});
  }
  if (result.length > 1000) conflict();
  return result.sort((a,b) => a.kind.localeCompare(b.kind) || a.id-b.id);
}

async function prepareGroupAssetSelectionGuard({ models, payload, groupId, clinicIds, env = process.env }) {
  const selected = selections(payload || {}, clinicIds);
  const touched=Object.keys(sections(payload||{})).filter(kind=>KINDS[kind]&&sections(payload||{})[kind]);
  const shareOptions={attributes:['assetType','assetId','clinicaId','grupoClinicaId'],where:{grupoClinicaId:groupId,assetType:{[Op.in]:touched.map(kind=>ASSET_TYPES[kind])}},order:[['assetType','ASC'],['assetId','ASC'],['clinicaId','ASC']],raw:true,logging:false,limit:1001};
  const primaryFields=[...new Set(touched.flatMap(kind=>PRIMARY_FIELDS[kind]||[]))];
  let previousShares=[],previousGroup=null;
  try {
    if(touched.length)previousShares=await models.GroupAssetClinicAssignment.findAll(shareOptions);
    if(!Array.isArray(previousShares)||previousShares.length>1000)conflict();
    if(primaryFields.length)previousGroup=plain(await models.GrupoClinica.findByPk(groupId,{attributes:primaryFields,raw:true,logging:false}));
    const include=(kind,id,destinations)=>{
      if(!positive(id)||destinations.some(id=>!clinicIds.includes(Number(id))))conflict();
      const found=selected.find(v=>v.kind===kind&&v.id===Number(id));
      if(found)found.destinations=[...new Set([...found.destinations,...destinations])];else selected.push({kind,id:Number(id),destinations});
    };
    for(const share of previousShares){const kind=touched.find(kind=>ASSET_TYPES[kind]===share.assetType);if(!kind)conflict();include(kind,share.assetId,[Number(share.clinicaId)]);}
    for(const kind of touched){const fields=PRIMARY_FIELDS[kind];if(fields&&previousGroup?.[fields[0]]==='group'&&previousGroup?.[fields[1]]!=null)include(kind,previousGroup[fields[1]],clinicIds.slice());}
    if(selected.length>1000)conflict();selected.sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id);
  }catch(error){if(error instanceof GroupAssetSelectionError)throw error;conflict();}
  const managed = new Set(), originals = new Map(), securityReads = [];
  const excluded = new Set(['GrupoClinica','GroupAssetClinicAssignment',...Object.values(KINDS).map(v=>v.model)]);
  let transaction, recording = true, order = null, prefixes = null;
  const metaIds = selected.filter(v=>KINDS[v.kind].type).map(v=>v.id);
  let metaHints = [];
  try {
    if (metaIds.length) {
      metaHints = await models.MetaMarketingBrokerBinding.findAll({ attributes: ['mapping_id','enrollment_id','scope_key','app_id'],
        where: {mapping_id:{[Op.in]:metaIds}},raw:true,logging:false,limit:1001 });
      if (!Array.isArray(metaHints) || metaHints.length > 1000) conflict();
      const ids = [...new Set(metaHints.map(v=>v.enrollment_id).filter(Boolean))];
      if (ids.length) {
        order = require('./metaMarketingTransactionOrder.service').createOrder({models,unavailable:conflict});
        prefixes = await order.prepareScopes([...new Set(metaHints.map(v=>v.scope_key))].sort(),ids.sort());
      }
    }
  } catch (error) { if (error instanceof GroupAssetSelectionError) throw error; conflict(); }
  // Reuse the established metadata guards with this transaction's locks. No
  // broker transport, credential value, Graph request or model bootstrap occurs.
  const view = new Proxy(models, { get(target, name) {
    const model = target[name];
    if (!model || typeof model.findAll !== 'function') return model;
    return new Proxy(model, { get(source, method) {
      const fn = source[method];
      if (!['findAll','findOne','findByPk'].includes(method)) return typeof fn === 'function' ? fn.bind(source) : fn;
      return async (...args) => {
        const at = method === 'findByPk' ? 1 : 0;
        args[at] = {...args[at],transaction,lock:transaction.LOCK.UPDATE,logging:false};
        const read = () => fn.apply(source,args), value = await read();
        if (recording && !excluded.has(name)) securityReads.push({read,expected:digest(value)});
        return value;
      };
    } });
  } });
  async function googleAuthority(row, item, spec) {
    const connectionId = Number(row.googleConnectionId ?? row.google_connection_id);
    if (!positive(connectionId)) conflict();
    const cohort = {searchConsole:'search_console',analytics:'analytics',businessProfile:'business_profile',googleAds:'ads'}[item.kind];
    const oauth = await view.GoogleOAuthBrokerBinding.findOne({attributes:['google_user_id','cohort','google_connection_id','connection_ref','asset_ref','clinica_id','scope_key','policy_version','confirmed_at'],
      where:{google_connection_id:connectionId,cohort},raw:true});
    if (oauth) {
      require('./googleOAuthCohort.contract').validate(oauth);
      if (!oauth.confirmed_at) conflict();
    }
    if (!await view.GoogleConnection.findByPk(connectionId,{attributes:['id'],raw:true})) conflict();
    const required = !!oauth || env[spec.gate]==='true';
    const grants = await view.GoogleConnectionAssignment.findAll({attributes:['scopeKey','googleConnectionId','status','assignmentScope','clinicaId','grupoClinicaId'],
      where:{scopeKey:{[Op.in]:['group:'+groupId,...item.destinations.map(id=>'clinic:'+id)]}},raw:true,limit:1001});
    if (!Array.isArray(grants) || grants.length>1000) conflict();
    for (const id of item.destinations) {
      const own = grants.filter(v=>v.scopeKey==='clinic:'+id), inherited=grants.filter(v=>v.scopeKey==='group:'+groupId);
      const selected = own.length?own:inherited;
      if (!selected.length && !required) continue;
      if (selected.length!==1 || selected[0].status!=='active' || Number(selected[0].googleConnectionId)!==connectionId) conflict();
    }
    return {required,oauth};
  }
  async function assertSelection(item, final = false) {
    const spec = KINDS[item.kind], fields = ['id',spec.clinic,spec.active,...spec.fields];
    const row = plain(await view[spec.model].findByPk(item.id,{attributes:[...new Set(fields)],raw:true}));
    if (!row || spec.type && row.assetType !== spec.type) conflict();
    if (!active(row[spec.active])) reconnect();
    if (!clinicIds.includes(Number(row[spec.clinic])) && Number(row.grupoClinicaId) !== Number(groupId)) conflict();
    const key = item.kind+':'+item.id;
    if (final && managed.has(key) && digest(row)!==originals.get(key)) conflict();
    const registry = view[spec.registry]; if (!registry) conflict();
    let registered, isManaged;
    const google = spec.type ? null : await googleAuthority(row,item,spec);
    if (spec.type) {
      const assetId = String(row.metaAssetId).replace(/^act_/,'');
      const ref = 'meta-'+spec.type+':'+assetId;
      const records = await registry.findAll({where:{[Op.or]:[{mapping_id:item.id},{asset_ref:ref}]},raw:true,limit:1001});
      if (!Array.isArray(records) || records.length > 1000) conflict();
      const tombstones = await view.MetaMarketingBrokerRevocation.findAll({attributes:['tuple_hash'],where:{asset_ref:ref},raw:true,limit:1001});
      if (!Array.isArray(tombstones) || tombstones.length > 1000) conflict();
      registered = records.some(v=>Number(v.mapping_id)===item.id);
      const connection = await view.MetaConnection.findByPk(Number(row.metaConnectionId),{attributes:['id','credentials_external'],raw:true});
      if (!connection) conflict();
      isManaged = registered || records.length > 0 || Number(connection.credentials_external)===1 || env[spec.gate] === 'true';
      if (isManaged) {
        if (!registered) conflict();
        const own = records.find(v=>Number(v.mapping_id)===item.id);
        if (own.enrollment_id && !prefixes) conflict();
        const S = require('./metaMarketingBrokerScope.service');
        const scope = S.createMetaMarketingBrokerScope({...S.createMetaMarketingScopeRepository(()=>view,{transaction}),enabled:()=>env[spec.gate]==='true'});
        const context = await scope.prepare(item.id), authority = scope.describe(context);
        if (item.destinations.some(id=>!authority.clinicIds.includes(id))) conflict();
      } else {
        if (tombstones.length) reconnect();
        if (await require('./metaScopeBlock.service').blocked({assignmentScope:'group',groupId},{models:view,transaction,purpose:'meta'})) reconnect();
      }
    } else if (item.kind === 'googleAds') {
      const S = require('./googleAdsBrokerScope.service'), customer = S.customer(row.customerId);
      const records = await registry.findAll({where:{[Op.or]:[{mapping_id:item.id},{customer_id:customer}]},raw:true,limit:1001});
      const revoked = await view.GoogleAdsBrokerRevocation.findAll({attributes:['tuple_hash'],where:{customer_id:customer},raw:true,limit:1001});
      if (!Array.isArray(records) || records.length > 1000 || !Array.isArray(revoked)) conflict();
      isManaged = records.length > 0 || revoked.length > 0 || row.broker_read_connection_ref != null || row.broker_read_asset_ref != null || google.required;
      if (isManaged) {
        const scope = S.createGoogleAdsBrokerScope({...S.createGoogleAdsScopeRepository(()=>view),enabled:()=>env[spec.gate]==='true'});
        const context = await scope.prepare(row,{transaction}); if (!context) conflict();
        const authority = await scope.assertContext(context,{transaction});
        if (item.destinations.some(id=>!authority.clinicIds.includes(id))) conflict();
      }
    } else if (item.kind === 'businessProfile') {
      const C = require('./businessProfileAssociation.contract'), id=C.location(row.location_id);
      const record = await registry.findByPk(id,{raw:true});
      if (await view.BusinessProfileBrokerRevocation.findByPk(id,{attributes:['external_location_id'],raw:true})) reconnect();
      isManaged = !!record || row.broker_read_connection_ref != null || row.broker_read_asset_ref != null || google.required;
      // A retired legacy owner may point at a separately committed successor.
      // Only the typed resolver can accept that exact mapping/head generation.
      if (record && record.current_generation_id == null && record.state!=='active') reconnect();
      if (isManaged) {
        if (!google.oauth || google.oauth.connection_ref!==row.broker_read_connection_ref || !google.oauth.confirmed_at) conflict();
        const connection=await view.GoogleConnection.findOne({attributes:['id','googleUserId',[literal('(accessToken IS NULL AND refreshToken IS NULL)'),'credentials_external']],
          where:{id:Number(row.google_connection_id)},raw:true});
        if (!connection || connection.googleUserId!==google.oauth.google_user_id || Number(connection.credentials_external)!==1) conflict();
        const S = require('./businessProfileBroker.service');
        const reader = S.createBusinessProfileBroker({enabled:()=>env[spec.gate]==='true',
          loadLocation:id=>view.ClinicBusinessLocation.findByPk(id,{attributes:fields,raw:true}),
          loadManagedBinding:(_id,_options,mapping)=>require('./businessProfileBindingGeneration.service').resolveMappingBinding({models:view,mapping,transaction}),
          loadRevocation:id=>view.BusinessProfileBrokerRevocation.findByPk(id,{attributes:['external_location_id'],raw:true})});
        if (!await reader.prepare(row,conflict,new Map())) conflict();
      }
    } else {
      const C = require('./googlePropertyRevocation.contract'), kind=item.kind==='searchConsole'?'search_console':'analytics', specC=C.KINDS[kind];
      const resource = kind==='search_console'?specC.contract.site(row.siteUrl):specC.contract.property(row.propertyName);
      const records = await registry.findAll({where:{[Op.or]:[{mapping_id:item.id},{asset_ref:resource.assetRef}]},raw:true,limit:1001});
      const revoked = await view.GooglePropertyBrokerRevocation.findAll({where:{kind,asset_ref:resource.assetRef},raw:true,limit:1001});
      if (!Array.isArray(records) || records.length > 1000 || !Array.isArray(revoked)) conflict();
      C.inspectRevocations(kind,resource.assetRef,row.clinicaId,row.broker_read_connection_ref,revoked);
      if (records.some(v=>Number(v.mapping_id)===item.id && v.state!=='active')) reconnect();
      isManaged = records.length > 0 || revoked.length > 0 || row.broker_read_connection_ref != null || row.broker_read_asset_ref != null || google.required;
      if (isManaged) {
        const S = require(kind==='search_console'?'./searchConsoleBroker.service':'./analyticsBroker.service');
        const reader = kind==='search_console'?S.createSearchConsoleBroker({...S.createSearchConsoleRepository(()=>view),enabled:()=>env[spec.gate]==='true'})
          : S.createAnalyticsBroker({...S.createAnalyticsRepository(()=>view),enabled:()=>env[spec.gate]==='true'});
        if (!await reader.prepare(row)) conflict();
      }
    }
    if (isManaged) { managed.add(key); if (!final) originals.set(key,digest(row)); }
  }
  const guarded = work => async (...args) => {
    try { return await work(...args); } catch (error) {
      if (error instanceof GroupAssetSelectionError) throw error;
      if (['asset_revoked','meta_credential_renewal_required','meta_broker_not_active','meta_enrollment_not_active','meta_enrollment_scope_blocked'].includes(error?.code)) reconnect();
      conflict();
    }
  };
  return {
    managed:(kind,id)=>managed.has(kind+':'+Number(id)),
    lock:guarded(async tx => {
      transaction=tx; if (!transaction?.LOCK?.UPDATE || transaction.finished) conflict();
      if (prefixes) await order.lockScopes(prefixes,transaction);
      if(touched.length&&digest(await models.GroupAssetClinicAssignment.findAll({...shareOptions,transaction,lock:transaction.LOCK.UPDATE}))!==digest(previousShares))conflict();
      if(primaryFields.length&&digest(plain(await models.GrupoClinica.findByPk(groupId,{attributes:primaryFields,raw:true,logging:false,transaction,lock:transaction.LOCK.UPDATE})))!==digest(previousGroup))conflict();
      if (touched.length) {
        // Lock the current cohort and any expected clinic that may have left
        // it since _loadGroupContext. Neither a stale exit nor a new member
        // can silently change the scope authorized by this request.
        const members = await view.Clinica.findAll({attributes:['id_clinica','grupoClinicaId'],
          where:{[Op.or]:[{grupoClinicaId:Number(groupId)},{id_clinica:{[Op.in]:clinicIds}}]},
          order:[['id_clinica','ASC']],raw:true,limit:1001});
        const expected = [...clinicIds].sort((a,b)=>a-b);
        if (members.length > 1000 || members.length !== expected.length
          || members.some((row,index)=>!positive(row.id_clinica)||Number(row.id_clinica)!==Number(expected[index])
            ||Number(row.grupoClinicaId)!==Number(groupId))) conflict();
      }
      if (prefixes) await order.validateScopes(prefixes,transaction);
      for (const item of selected) await assertSelection(item);
      recording=false;
    }),
    assertFinal:guarded(async () => {
      // Compare original security observations, never bless a freshly computed
      // fingerprint after our writes. Only group choices/shares may change.
      for (const snapshot of securityReads) if (digest(await snapshot.read())!==snapshot.expected) conflict();
      if (prefixes) await order.validateScopes(prefixes,transaction);
      for (const item of selected) await assertSelection(item,true);
    }),
  };
}
module.exports = {prepareGroupAssetSelectionGuard,GroupAssetSelectionError,KINDS,selections};
