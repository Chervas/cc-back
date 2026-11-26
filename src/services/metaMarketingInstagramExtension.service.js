'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const C = require('./metaMarketingOAuth.contract');
const E = require('./metaMarketingEnrollment.contract');
const F = require('./metaMarketingEffectiveCredential.service');
const { createOrder } = require('./metaMarketingTransactionOrder.service');
const I = require('../../services/integrations-broker/src/meta-marketing-instagram-extension-contract');
const D = require('../../services/integrations-broker/src/meta-marketing-discovery-contract');
const M = require('../../services/integrations-broker/src/meta-marketing-contract');

const fail = (code = 'meta_instagram_unavailable', status = 503) => C.fail(code, status);
const hashPattern = /^[a-f0-9]{64}$/;
const disabled = () => ({ enabled: false });
const view = (status, flowId = null, candidate = null) => ({ enabled: true, status, flowId, candidate });
const plain = row => row?.get ? row.get({ plain: true }) : row;
const destinationKey = input => input.scopeKey.startsWith('group:') ? 'clinic:' + input.destinationClinicId : input.scopeKey;
const actor = row => ({ scopeKey: row.scope_key,
  ...(row.scope_key.startsWith('group:') ? { destinationClinicId: Number(row.reserved_scope?.split(':')[1]) } : {}), actorId: Number(row.actor_user_id), sessionRef: row.session_ref, sessionExpiresAt: row.session_expires_at });
const ownedBy = (row, input) => Number(row.actor_user_id) === input.actorId && row.session_ref === input.sessionRef;
const safeName = (value, length) => typeof value === 'string' && !!value.trim() && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);

function credentialFailure(error) {
  if (error?.code === 'meta_credential_renewal_required') fail('meta_instagram_expired', 409);
  throw error;
}

function configuration(environment = process.env) {
  if (environment.META_MARKETING_INSTAGRAM_EXTENSION_ENABLED !== 'true') return null;
  const scopeKey = environment.META_MARKETING_INSTAGRAM_EXTENSION_SCOPE;
  const parentPageId = environment.META_MARKETING_INSTAGRAM_EXTENSION_PAGE;
  const legacy = scopeKey || parentPageId;
  if (legacy && (!/^clinic:[1-9][0-9]{0,9}$/.test(scopeKey) || !C.positive(Number(scopeKey.slice(7))) || !M.graphId(parentPageId))) fail();
  if (!environment.META_MARKETING_INSTAGRAM_EXTENSION_TARGETS) {
    if (!legacy && environment.META_MARKETING_INSTAGRAM_EXTENSION_SELF_SERVICE_ENABLED === 'true') return [];
    if (!legacy) fail();
    return { scopeKey, parentPageId };
  }
  let targets;
  try { targets = JSON.parse(environment.META_MARKETING_INSTAGRAM_EXTENSION_TARGETS); } catch { fail(); }
  if (!Array.isArray(targets) || !targets.length || targets.length > 1000) fail();
  if (legacy && !targets.some(item => item?.scopeKey === scopeKey && item.parentPageId === parentPageId)) {
    targets.push({ scopeKey, clinicId: Number(scopeKey.slice(7)), parentPageId });
  }
  const clinics = new Set(), pages = new Set();
  for (const item of targets) {
    if (!C.exact(item, 'scopeKey,parentPageId,clinicId') || !C.positive(item.clinicId)
        || !/^(clinic|group):[1-9][0-9]{0,9}$/.test(item.scopeKey) || !C.positive(Number(item.scopeKey.split(':')[1]))
        || item.scopeKey.startsWith('clinic:') && item.scopeKey !== 'clinic:' + item.clinicId
        || !M.graphId(item.parentPageId) || clinics.has(item.clinicId) || pages.has(item.parentPageId)) fail();
    clinics.add(item.clinicId);
    pages.add(item.parentPageId);
  }
  return targets;
}

function targetList(settings) {
  const configured = settings();
  return Array.isArray(configured) ? configured : configured ? [configured] : [];
}

function targetsFor(row, business, settings = configuration) {
  if (!row || row.state !== 'active' || business) return [];
  // An invalid optional extension must never make the primary enrollment look disconnected.
  let configured;
  try { configured = targetList(settings); } catch { return []; }
  return configured.filter(target => target.scopeKey === row.scope_key
    && (row.scope_key.startsWith('clinic:') || row.clinicIds.includes(target.clinicId))
    && row.selected.some(asset => asset.kind === 'facebook_page' && asset.id === target.parentPageId)
    && !row.selected.some(asset => asset.kind === 'instagram_business' && asset.parentPageId === target.parentPageId));
}

function availableFor(row, business, settings = configuration) {
  try { return targetsFor(row, business, settings).length > 0; } catch { return false; }
}

const selfServiceEnabled = () => process.env.META_MARKETING_INSTAGRAM_EXTENSION_ENABLED === 'true'
  && process.env.META_MARKETING_INSTAGRAM_EXTENSION_SELF_SERVICE_ENABLED === 'true';

// Intersect a confirmed enrollment with the effective Facebook destination. Ambiguous
// assignments must be resolved in the mapping wizard before requesting provider consent.
async function destinationsFor({ models, row, committed, transaction, settings = configuration, selfService = selfServiceEnabled }) {
  if (!row || row.state !== 'active' || committed.business) return [];
  const automatic = selfService();
  const allowed = targetsFor(row, committed.business, settings);
  if (!automatic && !allowed.length) return [];
  const pages = row.selected.filter(asset => asset.kind === 'facebook_page'
    && !row.selected.some(ig => ig.kind === 'instagram_business' && ig.parentPageId === asset.id));
  if (!pages.length) return [];
  const scopeKey = row.scope_key;
  if (scopeKey.startsWith('clinic:')) {
    if (!automatic) return allowed;
    if (allowed.length) return allowed;
    return pages.length === 1 ? [{scopeKey, clinicId:row.clinicIds[0], parentPageId:pages[0].id}] : [];
  }
  const options = {transaction, raw:true, logging:false};
  const groupId = Number(scopeKey.slice(6));
  const mappings = await models.ClinicMetaAsset.findAll({...options, attributes:['id','metaAssetId'],
    where:{id:row.mappingIds, metaConnectionId:row.meta_connection_id, assignmentScope:'group', grupoClinicaId:groupId,
      isActive:true, assetType:'facebook_page', metaAssetId:pages.map(page=>page.id)}});
  if (!mappings.length) return [];
  const group = await models.GrupoClinica.findByPk(groupId,{...options,attributes:['facebook_assignment_mode','facebook_primary_asset_id']});
  if (!group) return [];
  const pageByMapping = new Map(mappings.map(m=>[Number(m.id),String(m.metaAssetId)]));
  const primary = group.facebook_assignment_mode === 'group' && group.facebook_primary_asset_id != null;
  const shares = primary ? [] : await models.GroupAssetClinicAssignment.findAll({...options, attributes:['clinicaId','assetId'],
    where:{grupoClinicaId:groupId, assetType:'meta.facebook_page',clinicaId:row.clinicIds,assetId:[...pageByMapping.keys()]}});
  return row.clinicIds.flatMap(clinicId=>{
    const ids = primary ? [Number(group.facebook_primary_asset_id)] : shares.filter(s=>Number(s.clinicaId)===clinicId).map(s=>Number(s.assetId));
    const eligible = [...new Set(ids.map(id=>pageByMapping.get(id)).filter(Boolean))];
    if (eligible.length !== 1 || !automatic && !allowed.some(t=>t.clinicId===clinicId && t.parentPageId===eligible[0])) return [];
    return [{scopeKey,clinicId,parentPageId:eligible[0]}];
  });
}

async function savedGroupDestinations({models,row,committed,targets,transaction,now}) {
  if (!targets.length || !row.scope_key.startsWith('group:')) return targets;
  const journals = await models.MetaMarketingInstagramExtension.findAll({transaction,raw:true,logging:false,
    attributes:['reserved_scope','structure_hash','selected_instagram_id','selected_candidate_digest','confirmed_at'],
    where:{enrollment_id:row.enrollment_id, connection_ref:row.connection_ref,scope_key:row.scope_key,status:'active',
      reserved_scope:targets.map(target=>'clinic:'+target.clinicId)}});
  if (!journals.length) return targets;
  const assetDigest=F.assetSetDigest(row.selected);
  const saved = new Map();
  for (const target of targets) {
    const j=journals.find(item=>item.reserved_scope==='clinic:'+target.clinicId);
    const structureHash=C.hash(JSON.stringify([committed.digest,target.parentPageId,assetDigest,row.meta_user_id]));
    if (j && j.structure_hash===structureHash && hashPattern.test(j.selected_candidate_digest||'')
        && j.confirmed_at && Number.isFinite(+j.confirmed_at) && +j.confirmed_at<=+now && M.graphId(j.selected_instagram_id)) {
      saved.set(target.clinicId,j.selected_instagram_id);
    }
  }
  if (!saved.size) return targets;
  const removed=await models.MetaMarketingBrokerRevocation.findAll({transaction,raw:true,logging:false,attributes:['asset_ref'],
    where:{asset_ref:[...saved.values()].map(id=>'meta-instagram_business:'+id)}});
  const revoked=new Set(removed.map(entry=>entry.asset_ref));
  return targets.map(target=>{
    const id=saved.get(target.clinicId);
    return id && !revoked.has('meta-instagram_business:'+id) ? {...target,savedInstagramId:id} : target;
  });
}

function authUrl(raw, source, state) {
  let url;
  try { url = new URL(raw); } catch { fail(); }
  const query = url.searchParams;
  const scopes = [...new Set([...JSON.parse(source.scopes), 'instagram_basic'])].sort().join(',');
  if (typeof raw !== 'string' || raw.length > 2048 || url.origin !== 'https://www.facebook.com'
      || url.username || url.password || url.pathname !== '/' + M.GRAPH_VERSION + '/dialog/oauth' || url.hash
      || [...query.keys()].sort().join(',') !== 'client_id,redirect_uri,response_type,scope,state'
      || query.get('client_id') !== source.app_id || query.get('redirect_uri') !== source.redirect_uri
      || query.get('response_type') !== 'code' || query.get('scope') !== scopes || query.get('state') !== state) fail();
  return url.href;
}

function receipt(data, row, now) {
  if (!C.exact(data, 'flowId,status,candidate') || data.flowId !== row.flow_id
      || !['not_found','awaiting','interrupted','staged','active','aborted'].includes(data.status)) fail();
  const candidate = data.candidate;
  if (!['staged','active'].includes(data.status)) {
    if (candidate !== null) fail();
    return data;
  }
  if (!C.exact(candidate, 'profile,digest,expiresAt') || !hashPattern.test(candidate.digest)
      || !Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= +now) fail('meta_instagram_expired', 409);
  const profile = candidate.profile;
  if (!C.exact(profile, Object.hasOwn(profile || {}, 'avatarUrl') ? 'assetRef,kind,id,name,username,avatarUrl' : 'assetRef,kind,id,name,username')
      || profile.kind !== 'instagram_business' || !M.graphId(profile.id) || profile.assetRef !== 'meta-instagram_business:' + profile.id
      || !safeName(profile.name, 256) || !safeName(profile.username, 100)
      || (profile.avatarUrl !== undefined && D.assetAvatarUrl(profile.avatarUrl) !== profile.avatarUrl)) fail();
  return structuredClone(data);
}

function createService({ models, sessions, client, now = () => new Date(), returnOrigin = C.frontendOrigin(), settings = configuration, selfService = selfServiceEnabled } = {}) {
  const scope = require('./metaMarketingOAuthScope.service').createScope({ models, sessions, now });
  const authorize = require('./metaMarketingInstagramAssignmentAccess').assignmentAuthorization(scope, models.UsuarioClinica);
  const order = createOrder({ models, authorize, unavailable: fail });
  const credentials = F.createEffectiveCredentials({ models, now });
  const bindings = require('./metaMarketingEnrollmentBinding.service').createBindings({ models, sessions, now });
  const Rows = models.MetaMarketingInstagramExtension;
  const lock = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, logging: false });
  const configured = input => targetList(settings).find(target => target.scopeKey === input.scopeKey
    && (!input.scopeKey.startsWith('group:') || target.clinicId === input.destinationClinicId));

  async function capture(input, enrollment, transaction) {
    let target = configured(input);
    if ((!target && !selfService()) || !enrollment) fail('meta_instagram_connection_required', 409);
    const row = E.request(plain(await models.MetaMarketingEnrollmentRequest.findByPk(enrollment.enrollment_id, lock(transaction))));
    const binding = await bindings.committed(row.enrollment_id, transaction).catch(credentialFailure);
    if (!target) {
      target = (await destinationsFor({models,row,committed:binding,transaction,settings,selfService})).find(t=>
        t.scopeKey === input.scopeKey && (!input.scopeKey.startsWith('group:') || t.clinicId === input.destinationClinicId));
    }
    if (!target) fail('meta_instagram_scope_changed', 409);
    const source = plain(await models.MetaMarketingOAuthRequest.findByPk(row.flow_id, lock(transaction)));
    const credential = await credentials.resolve(row, source, transaction).catch(credentialFailure);
    if (row.scope_key !== target.scopeKey || binding.business || source.app_id !== row.app_id
        || credential.metadata.tokenType !== 'USER' || !row.selected.some(asset => asset.kind === 'facebook_page' && asset.id === target.parentPageId)
        || row.selected.some(asset => asset.kind === 'instagram_business' && asset.parentPageId === target.parentPageId)) {
      fail('meta_instagram_scope_changed', 409);
    }
    if (input.scopeKey.startsWith('group:')) {
      if (!row.clinicIds.includes(input.destinationClinicId)) fail('meta_instagram_scope_forbidden', 403);
      const groupId = Number(row.scope_key.slice(6));
      const page = plain(await models.ClinicMetaAsset.findOne({ ...lock(transaction), attributes: ['id'],
        where: { metaConnectionId: row.meta_connection_id, assetType: 'facebook_page', metaAssetId: target.parentPageId,
          assignmentScope: 'group', grupoClinicaId: groupId, isActive: true } }));
      if (!page || !row.mappingIds.includes(Number(page.id))) fail('meta_instagram_scope_changed', 409);
      const group = plain(await models.GrupoClinica.findByPk(groupId, { ...lock(transaction),
        attributes: ['facebook_assignment_mode', 'facebook_primary_asset_id'] }));
      if (!group) fail('meta_instagram_scope_changed', 409);
      if (group.facebook_assignment_mode === 'group' && group.facebook_primary_asset_id != null) {
        if (Number(group.facebook_primary_asset_id) !== Number(page.id)) fail('meta_instagram_scope_changed', 409);
      } else if (!await models.GroupAssetClinicAssignment.findOne({ ...lock(transaction), attributes: ['id'],
        where: { grupoClinicaId: groupId, clinicaId: input.destinationClinicId, assetType: 'meta.facebook_page', assetId: page.id } })) {
        fail('meta_instagram_scope_changed', 409);
      }
    }
    const payload = { enrollmentId: row.enrollment_id, parentPageId: target.parentPageId, assetSetDigest: F.assetSetDigest(row.selected),
      epoch: credential.epoch, versionId: credential.versionId, credentialDigest: credential.digest };
    const structureHash = C.hash(JSON.stringify([binding.digest, target.parentPageId, payload.assetSetDigest, row.meta_user_id]));
    return { source, row, payload, credentialExpiresAt: F.expiry(credential.metadata),
      structureHash, authorityHash: C.hash(JSON.stringify([structureHash, payload])) };
  }

  function matches(journal, authority) {
    if (journal.enrollment_id !== authority.payload.enrollmentId || journal.connection_ref !== authority.row.connection_ref
        || journal.structure_hash !== authority.structureHash
        || journal.status !== 'active' && journal.authority_hash !== authority.authorityHash) fail('meta_instagram_scope_changed', 409);
  }

  const inScope = (input, work) => order.scope(input, { active: true }, work);
  const current = (input, transaction) => Rows.findOne({ where: { reserved_scope: destinationKey(input), scope_key: input.scopeKey }, ...lock(transaction) });
  async function unassigned(instagramId, transaction) {
    if (await models.ClinicMetaAsset.findOne({ ...lock(transaction), attributes: ['id'],
      where: { assetType: 'instagram_business', metaAssetId: instagramId, isActive: true } })) fail('meta_instagram_scope_changed', 409);
  }
  async function call(row, name, payload) {
    const requestId = name === 'begin' ? row.flow_id : randomUUID();
    let tenantRef = row.scope_key;
    if (row.scope_key.startsWith('group:')) {
      const enrollment = plain(await models.MetaMarketingEnrollmentRequest.findByPk(row.enrollment_id, {
        attributes: ['clinic_ids', 'scope_key', 'connection_ref'], logging: false }));
      if (!enrollment || enrollment.scope_key !== row.scope_key || enrollment.connection_ref !== row.connection_ref) fail('meta_instagram_scope_changed', 409);
      tenantRef = 'clinic:' + E.clinics(enrollment.clinic_ids)[0];
    }
    let result;
    try {
      result = await client.execute({ requestId, operation: I.OPERATIONS[name], tenantRef, connectionRef: row.connection_ref,
        assetRef: 'meta-enroll:' + row.scope_key, payload }, { timeoutMs: 30000 });
    } catch (error) {
      if (error?.code === 'rate_limited') fail('meta_instagram_rate_limited', 429);
      if (error?.code === 'credential_revoked') fail('meta_instagram_expired', 409);
      if (error?.code === 'oauth_credentials_incomplete') fail('meta_instagram_permissions_required', 409);
      if (['oauth_identity_mismatch','asset_revoked','scope_denied','idempotency_conflict','oauth_flow_interrupted','oauth_flow_busy'].includes(error?.code)) {
        fail('meta_instagram_scope_changed', 409);
      }
      fail();
    }
    if (!C.exact(result, 'requestId,data,replayed') || result.requestId !== requestId || result.replayed !== false) fail();
    return name === 'begin' ? result.data : receipt(result.data, row, now());
  }

  async function applyActive(input, id, remote) {
    return inScope(input, async ({ transaction, enrollment }) => {
      const row = await current(input, transaction);
      if (!row || row.flow_id !== id || !['processing','active'].includes(row.status)) fail('meta_instagram_scope_changed', 409);
      matches(row, await capture(input, enrollment, transaction));
      if (remote.status !== 'active' || remote.candidate.profile.id !== row.selected_instagram_id
          || remote.candidate.digest !== row.selected_candidate_digest) fail('meta_instagram_scope_changed', 409);
      await unassigned(remote.candidate.profile.id, transaction);
      if (row.status !== 'active') await row.update({ status: 'active', confirmed_at: now() }, { transaction, logging: false });
      return view('active', id, remote.candidate);
    });
  }

  async function savedAssignment(input, previous, expectedAuthorityHash) {
    return inScope(input, async ({ transaction, enrollment }) => {
      const row = await current(input, transaction);
      if (!row || row.status !== 'active' || row.scope_key !== input.scopeKey || row.reserved_scope !== destinationKey(input)
          || row.flow_id !== previous.flow_id || row.selected_instagram_id !== previous.selected_instagram_id
          || row.selected_candidate_digest !== previous.selected_candidate_digest || !M.graphId(row.selected_instagram_id)
          || !hashPattern.test(row.selected_candidate_digest || '') || !row.confirmed_at
          || !Number.isFinite(+row.confirmed_at) || +row.confirmed_at > +now()) return null;

      const authority = await capture(input, enrollment, transaction);
      if (authority.authorityHash !== expectedAuthorityHash) return null;
      matches(row, authority);
      await unassigned(row.selected_instagram_id, transaction);
      // CRM has a durable confirmation and asset id, independently of the
      // provider's current availability. Never turn it into a live profile.
      return { scopeKey: input.scopeKey, enrollmentId: authority.payload.enrollmentId, epoch: authority.payload.epoch,
        versionId: authority.payload.versionId, assetRef: 'meta-instagram_business:' + row.selected_instagram_id,
        kind: 'instagram_business', id: row.selected_instagram_id };
    });
  }

  async function cancel(input, id, denied = false) {
    if (!selfService() && !configured(input)) return disabled();
    const row = await inScope(input, async ({ transaction }) => {
      const journal = await current(input, transaction);
      if (!journal || journal.flow_id !== id) fail('meta_instagram_scope_changed', 409);
      if (journal.status !== 'active' && +journal.expires_at > +now() && !ownedBy(journal, input)) fail('meta_instagram_scope_forbidden', 403);
      if (denied && !['starting','awaiting'].includes(journal.status)) return null;
      await journal.update({ status: 'cancel_pending', cancelled_by: input.actorId }, { transaction, logging: false });
      return plain(journal);
    });
    if (!row) return view('none');
    // A timed-out begin can still arrive. The Owner writes a tombstone even
    // for an unknown attempt, so only its cancellation receipt frees the slot.
    const remote = await call(row, 'abort', { flowId: id });
    if (remote.status !== 'aborted') fail();
    return finishCancellation(input, id);
  }

  async function finishCancellation(input, id) {
    return inScope(input, async ({ transaction }) => {
      const row = await current(input, transaction);
      if (!row || row.flow_id !== id || row.status !== 'cancel_pending') fail('meta_instagram_scope_changed', 409);
      await row.update({ status: 'cancelled', reserved_scope: null, cancelled_at: now() }, { transaction, logging: false });
      return view('none');
    });
  }

  return {
    async overview(input) {
      if (!selfService() && !configured(input)) return disabled();
      const local = await inScope(input, async ({ transaction, enrollment }) => {
        const row = await current(input, transaction);
        if (!row) { await capture(input, enrollment, transaction); return null; }
        if (row.status === 'cancel_pending' || row.status !== 'active' && +row.expires_at <= +now()) {
          return { row: plain(row), cleanup: true };
        }
        if (row.status !== 'active' && !ownedBy(row, input)) fail('meta_instagram_scope_forbidden', 403);
        try {
          const authority = await capture(input, enrollment, transaction);
          matches(row, authority);
          return { row: plain(row), authorityHash: authority.authorityHash };
        } catch (error) { if (error?.httpStatus === 409) return { row: plain(row), cleanup: true }; throw error; }
      });
      if (!local) return view('none');
      const { row } = local;
      if (local.cleanup) return view('requires_cleanup', row.flow_id);
      if (row.status === 'starting' || row.status === 'awaiting') return view('awaiting', row.flow_id);
      let remote;
      try { remote = await call(row, 'status', { flowId: row.flow_id }); }
      catch (error) {
        if (error?.httpStatus === 409) return view('requires_cleanup', row.flow_id);
        if (error?.httpStatus === 429 && error.code === 'meta_instagram_rate_limited' && row.status === 'active') {
          const saved = await savedAssignment(input, row, local.authorityHash);
          if (saved) error.savedAssignment = saved;
        }
        throw error;
      }
      if (remote.status === 'active') return applyActive(input, row.flow_id, remote);
      return inScope(input, async ({ transaction, enrollment }) => {
        const fresh = await current(input, transaction);
        if (!fresh || fresh.flow_id !== row.flow_id || fresh.status !== row.status) fail('meta_instagram_scope_changed', 409);
        matches(fresh, await capture(input, enrollment, transaction));
        if (remote.status !== 'staged') return view(remote.status === 'awaiting' ? 'processing' : 'requires_cleanup', row.flow_id);
        try { await unassigned(remote.candidate.profile.id, transaction); }
        catch (error) { if (error?.httpStatus === 409) return view('requires_cleanup', row.flow_id); throw error; }
        return view('staged', row.flow_id, remote.candidate);
      });
    },
    async begin(input) {
      if (!selfService() && !configured(input)) return disabled();
      const state = randomBytes(32).toString('base64url');
      const captured = await inScope(input, async ({ transaction, enrollment }) => {
        const authority = await capture(input, enrollment, transaction);
        if (await current(input, transaction)) fail('meta_instagram_attempt_in_progress', 409);
        const startedAt = now();
        const sessionExpiry = +input.sessionExpiresAt;
        if (!Number.isSafeInteger(sessionExpiry) || sessionExpiry <= +startedAt) fail('meta_instagram_session_required', 401);
        // The original flow supplies the app and redirect, while the active credential
        // supplies its current lifetime. The Owner also enforces its own slot deadline.
        const expires = Math.min(+startedAt + 600000, sessionExpiry, authority.credentialExpiresAt ?? Infinity);
        if (!Number.isSafeInteger(expires) || expires <= +startedAt) fail('meta_instagram_expired', 409);
        const row = await Rows.create({ flow_id: randomUUID(), scope_key: input.scopeKey, reserved_scope: destinationKey(input),
          enrollment_id: authority.payload.enrollmentId, authority_hash: authority.authorityHash, structure_hash: authority.structureHash,
          connection_ref: authority.row.connection_ref,
          state_hash: C.hash(state), actor_user_id: input.actorId, session_ref: input.sessionRef, session_expires_at: input.sessionExpiresAt,
          requested_at: startedAt, expires_at: new Date(expires), status: 'starting' }, { transaction, logging: false });
        return { row: plain(row), authority };
      });
      const { row, authority } = captured;
      try {
        const remote = await call(row, 'begin', { ...authority.payload, state, expiresAt: +row.expires_at });
        if (!C.exact(remote, 'flowId,authUrl,expiresAt,status') || remote.flowId !== row.flow_id
            || remote.expiresAt !== +row.expires_at || remote.status !== 'awaiting') fail();
        const url = authUrl(remote.authUrl, authority.source, state);
        return await inScope(input, async ({ transaction, enrollment }) => {
          const journal = await current(input, transaction);
          if (!journal || journal.flow_id !== row.flow_id || journal.status !== 'starting') fail('meta_instagram_scope_changed', 409);
          matches(journal, await capture(input, enrollment, transaction));
          await journal.update({ status: 'awaiting' }, { transaction, logging: false });
          return { ...view('awaiting', row.flow_id), authUrl: url };
        });
      } catch (error) {
        try { await cancel(input, row.flow_id); } catch { /* Preserve the journal for retry. */ }
        throw error;
      }
    },
    async callback({ state, code, denied }) {
      if (!C.STATE.test(state) || !denied && (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code))) fail('meta_oauth_state_invalid', 400);
      const row = plain(await Rows.findOne({ where: { state_hash: C.hash(state) }, logging: false }));
      if (!row || !selfService() && !configured(actor(row))) fail('meta_oauth_state_invalid', 400);
      const result = { returnOrigin, requestId: row.flow_id, instagramExtension: true };
      if (row.scope_key.startsWith('group:')) {
        result.instagramGroupId = Number(row.scope_key.slice(6));
        result.instagramClinicId = actor(row).destinationClinicId;
      }
      if (denied) { try { await cancel(actor(row), row.flow_id, true); } catch {} return result; }
      const shouldExchange = await inScope(actor(row), async ({ transaction, enrollment }) => {
        const journal = await current(actor(row), transaction);
        if (!journal || journal.flow_id !== row.flow_id) return false;
        if (journal.code_hash && journal.code_hash !== C.hash(code)) fail('meta_oauth_state_invalid', 400);
        if (journal.status !== 'awaiting') return false;
        if (+journal.expires_at <= +now()) fail('meta_instagram_scope_changed', 409);
        matches(journal, await capture(actor(row), enrollment, transaction));
        await journal.update({ status: 'processing', code_hash: C.hash(code) }, { transaction, logging: false });
        return true;
      });
      if (shouldExchange) {
        try { await call(row, 'finish', { flowId: row.flow_id, state, code }); }
        catch { /* Status distinguishes a staged result, a rejection or an uncertain exchange. */ }
      }
      return result;
    },
    async confirm(input, id, { instagramId, candidateDigest }) {
      if (!selfService() && !configured(input)) return disabled();
      const row = await inScope(input, async ({ transaction, enrollment }) => {
        const journal = await current(input, transaction);
        if (!journal || journal.flow_id !== id || !['processing','active'].includes(journal.status)
            || journal.status !== 'active' && +journal.expires_at <= +now()) fail('meta_instagram_scope_changed', 409);
        if (!ownedBy(journal, input)) fail('meta_instagram_scope_forbidden', 403);
        matches(journal, await capture(input, enrollment, transaction));
        await unassigned(instagramId, transaction);
        if (journal.selected_candidate_digest === null || journal.selected_candidate_digest === undefined) {
          await journal.update({ selected_instagram_id: instagramId, selected_candidate_digest: candidateDigest }, { transaction, logging: false });
        } else if (journal.selected_instagram_id !== instagramId || journal.selected_candidate_digest !== candidateDigest) {
          fail('meta_instagram_scope_changed', 409);
        }
        return plain(journal);
      });
      const remote = await call(row, 'confirm', { flowId: id, instagramId, candidateDigest });
      return applyActive(input, id, remote);
    },
    cancel,
  };
}

let singleton;
function instance() {
  return singleton ||= createService({ models: require('../../models'), sessions: require('./accessSession.service'),
    client: require('./metaMarketingOAuthClient.service').createClient() });
}

module.exports = { createService, configuration, availableFor, targetsFor, destinationsFor, savedGroupDestinations, authUrl, receipt,
  ...Object.fromEntries(['overview','begin','confirm','cancel'].map(name => [name, (...args) => instance()[name](...args)])),
};
