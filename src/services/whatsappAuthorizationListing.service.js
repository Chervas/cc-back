'use strict';
// Durable authorization receipts, independent of the session that performed OAuth.
// Reads metadata only; never starts, finishes, cancels or activates a connection.
const { Op } = require('sequelize'); const { randomUUID } = require('node:crypto');
const S = require('./whatsappAuthorizationState.contract');
const { STAFF_ROLES, isGlobalAdmin } = require('../lib/role-helpers');
const scopeBlocks = require('./metaScopeBlock.service');
const { configuredClient, configuration } = require('../lib/whatsappOnboardingBrokerClient');
const { project, safe } = require('./whatsappOnboardingGateway.service');
const phoneMetadata = require('./whatsappAuthorizationPhoneMetadata.service');
const ATTRIBUTES = ['request_id','user_id','session_ref','session_expires_at','scope_type','scope_id','original_clinic_ids',
  'scope_digest','state_hash','context_digest','state','created_at','expires_at','claimed_at','channel_role'];
function input(value) {
  S.exact(value, ['scope','userId','sessionRef','sessionExpiresAt']);
  const { scope, ...actor } = value; S.request({ ...actor, requestId: randomUUID() }, 'status');
  if (scope !== null) { S.exact(scope, ['type','id']); if (!['clinic','group'].includes(scope.type) || !S.id(scope.id)) S.fail(); }
  return structuredClone(value);
}
function integrity(row, key) {
  if (!row || !S.uuid(row.request_id) || !S.id(row.user_id) || !S.uuid(row.session_ref)
    || !['clinic','group'].includes(row.scope_type) || !S.id(row.scope_id) || row.state !== 'claimed'
    || !Array.isArray(row.original_clinic_ids) || !row.original_clinic_ids.length || row.original_clinic_ids.length > 1000
    || row.original_clinic_ids.some((id,i,all)=>!S.id(id) || i > 0 && id <= all[i-1])
    || !['session_expires_at','created_at','expires_at','claimed_at'].every(k=>row[k] instanceof Date && Number.isFinite(row[k].getTime()))
    || row.expires_at <= row.created_at || row.expires_at - row.created_at > 30 * 60 * 1000 || row.expires_at > row.session_expires_at
    || row.claimed_at < row.created_at || row.claimed_at > row.expires_at || !/^[a-f0-9]{64}$/.test(row.scope_digest)) S.fail('whatsapp_authorization_unavailable',503);
  // Preserve the original actor/session in the MAC. The viewer is authorized separately.
  const context = S.contextDigest(row);
  if (!S.equalHash(context,row.context_digest) || !S.equalHash(S.digest(S.stateFor(key,row)),row.state_hash)) S.fail('whatsapp_authorization_unavailable',503);
  return row;
}
function createService({ models, sessions, broker = configuredClient(), config = S.settings,
  loadBindings = () => configuration(process.env).bindings, isBlocked = scopeBlocks.blocked, now = () => new Date(), clock = () => Date.now() } = {}) {
  const db = () => typeof models === 'function' ? models() : models || require('../../models');
  const sessionApi = () => sessions || require('./accessSession.service');
  const keyFor = scope => scope.type + ':' + scope.id;
  async function verifyActor(actor) {
    // Regular MFA or a valid trusted-device session is sufficient for reading.
    // requireEmail:true is reserved for authorizing a new credential.
    await sessionApi().verifyReference({ userId:actor.userId,sessionRef:actor.sessionRef,
      expiresAt:new Date(actor.sessionExpiresAt*1000) }, { requireEmail:false });
  }
  async function snapshot(scope, actor) {
    const clinics = await db().Clinica.findAll({ where:scope.type === 'clinic' ? {id_clinica:scope.id} : {grupoClinicaId:scope.id},
      attributes:['id_clinica','grupoClinicaId'],order:[['id_clinica','ASC']],limit:1001,raw:true });
    if (!clinics.length || clinics.length > 1000 || clinics.some((c,i)=>!S.id(c.id_clinica)
      || !(c.grupoClinicaId === null || S.id(c.grupoClinicaId)) || i > 0 && c.id_clinica <= clinics[i-1].id_clinica)) S.fail('whatsapp_authorization_forbidden',403);
    const ids = clinics.map(c=>c.id_clinica);
    if (!isGlobalAdmin(actor.userId)) {
      const memberships = await db().UsuarioClinica.findAll({ where:{id_usuario:actor.userId,id_clinica:{[Op.in]:ids},
        rol_clinica:{[Op.in]:STAFF_ROLES},[Op.or]:[{estado_invitacion:'aceptada'},{estado_invitacion:null}]},attributes:['id_clinica'],raw:true });
      const allowed = new Set(memberships.map(m=>m.id_clinica));
      if (ids.some(id=>!allowed.has(id))) S.fail('whatsapp_authorization_forbidden',403);
    }
    const blocked = await isBlocked(scope.type === 'clinic' ? {assignmentScope:'clinic',clinicId:scope.id}
      : {assignmentScope:'group',groupId:scope.id}, {models:db(),purpose:'whatsapp'});
    return {ids,blocked,digest:S.digest(JSON.stringify({scope,clinics:clinics.map(c=>({id:c.id_clinica,groupId:c.grupoClinicaId}))}))};
  }
  async function list(raw) {
    let cfg;
    try {
      const actor = input(raw); cfg = config();
      if (!Buffer.isBuffer(cfg?.key) || cfg.key.length !== 32) S.fail('whatsapp_onboarding_configuration_invalid',503);
      await verifyActor(actor);
      const bindings = structuredClone(loadBindings());
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 64
        || new Set(bindings.map(b=>b.scopeKey)).size !== bindings.length) S.fail('whatsapp_onboarding_configuration_invalid',503);
      const candidates = actor.scope ? [actor.scope] : bindings.map(b=>({type:b.scopeKey.split(':')[0],id:Number(b.scopeKey.split(':')[1])}));
      const allowed = new Map(); let incomplete = false;
      for (const scope of candidates) {
        try {
          const snap = await snapshot(scope,actor); const binding = bindings.find(b=>b.scopeKey === keyFor(scope));
          if (!binding) continue;
          if (JSON.stringify(binding.clinicIds) !== JSON.stringify(snap.ids)) { incomplete = true; continue; }
          allowed.set(keyFor(scope),{scope,snap,binding});
        } catch (error) {
          if (error?.code === 'whatsapp_authorization_forbidden' && actor.scope === null) continue;
          throw error;
        }
      }
      if (!allowed.size) return {authorizations:[],incomplete};
      const rows = await db().WhatsappAuthorizationState.findAll({ where:{state:'claimed',
        [Op.or]:[...allowed.values()].map(({scope})=>({scope_type:scope.type,scope_id:scope.id}))},
        attributes:ATTRIBUTES,order:[['created_at','DESC'],['request_id','DESC']],limit:50,raw:true });
      if (rows.length >= 50) incomplete = true;
      const seen = new Set(); const authorizations = []; const metadataDigests = new Map(); const remoteDeadline = clock()+12000;
      for (const row of rows) {
        const scopeKey = row.scope_type + ':' + row.scope_id;
        const selected = allowed.get(scopeKey); if (!selected) { incomplete = true; continue; }
        try {
          integrity(row,cfg.key);
          if (JSON.stringify(row.original_clinic_ids) !== JSON.stringify(selected.snap.ids)
            || row.scope_digest !== selected.snap.digest) { incomplete = true; continue; }
          const local = {requestId:row.request_id,status:row.expires_at <= now() ? 'expired' : 'claimed',scope:selected.scope,
            clinicIds:[...row.original_clinic_ids],expiresAt:row.expires_at.toISOString(),scopeDigest:row.scope_digest,
            clinicSetDigest:S.digest(JSON.stringify(row.original_clinic_ids)),channelRole:S.channelRole(row.channel_role)};
          await verifyActor(actor); const before = await snapshot(selected.scope,actor);
          if (before.digest !== selected.snap.digest || JSON.stringify(loadBindings()) !== JSON.stringify(bindings)) { incomplete = true; continue; }
          // The read-only client has a 5s timeout. Reserve its entire budget so
          // an unavailable broker cannot turn the all-scopes page into 50 waits.
          if (clock()+5000 > remoteDeadline) { incomplete = true; break; }
          const remote = await broker.statusReadOnly(local);
          await verifyActor(actor); const after = await snapshot(selected.scope,actor);
          const current = await db().WhatsappAuthorizationState.findByPk(row.request_id,{attributes:ATTRIBUTES,raw:true});
          if (after.digest !== before.digest || JSON.stringify(loadBindings()) !== JSON.stringify(bindings)) { incomplete = true; continue; }
          if (!current || current.state !== 'claimed') continue;
          integrity(current,cfg.key);
          if (JSON.stringify(current) !== JSON.stringify(row)) { incomplete = true; continue; }
          // A confirmed terminal attempt without a candidate says nothing about
          // other attempts, but it is not an uncertainty in this inventory.
          if (['aborted','interrupted'].includes(remote?.status) && remote.candidate === null) continue;
          if (remote?.status !== 'staged' || !remote.candidate) { incomplete = true; continue; }
          const result = project(local,{...remote,accessBlocked:remote.accessBlocked || after.blocked});
          if (!['awaiting_activation','blocked'].includes(result.authorizationStatus)) { incomplete = true; continue; }
          const phoneKey = scopeKey + ':' + remote.candidate.phoneId;
          if (seen.has(phoneKey)) continue;
          // Receipt identity is verified before any local metadata query. A
          // blocked receipt never exposes its phone, including historical data.
          result.localPhone = null;
          if (result.authorizationStatus === 'awaiting_activation') {
            try {
              const metadata = await phoneMetadata.read({models:db(),authorization:result,now:now()});
              result.localPhone = metadata.phone; metadataDigests.set(result.requestId,metadata.digest);
            } catch { incomplete = true; }
          }
          seen.add(phoneKey); authorizations.push(result);
        } catch (error) {
          // Revoked viewer sessions fail the whole request, never disclose stale results.
          if (['auth_invalid','auth_email_verification_required','auth_configuration_invalid'].includes(error?.code)) throw error;
          if (error?.code === 'whatsapp_authorization_forbidden') { if (actor.scope) throw error; continue; }
          incomplete = true;
        }
      }
      await verifyActor(actor);
      // Complete metadata re-reads before the final ACL sweep; a later phone
      // lookup must not leave an earlier scope with only its old permission check.
      for (const dto of authorizations) {
        if (!dto.localPhone) continue;
        try {
          const fresh = await phoneMetadata.read({models:db(),authorization:dto,now:now()});
          if (fresh.digest !== metadataDigests.get(dto.requestId)) { dto.localPhone = null; incomplete = true; }
        } catch { dto.localPhone = null; incomplete = true; }
      }
      // Recheck every emitted scope after all remote work, covering revocation
      // while another scope's status was being fetched.
      const visible = [];
      for (const dto of authorizations) {
        try {
          const latest = await snapshot(dto.scope,actor), initial = allowed.get(keyFor(dto.scope)).snap;
          if (latest.digest !== initial.digest || JSON.stringify(loadBindings()) !== JSON.stringify(bindings)) { incomplete = true; continue; }
          const current = await db().WhatsappAuthorizationState.findByPk(dto.requestId,{attributes:ATTRIBUTES,raw:true});
          if (!current || current.state !== 'claimed') continue;
          integrity(current,cfg.key);
          if (JSON.stringify(current) !== JSON.stringify(rows.find(row=>row.request_id === dto.requestId))) { incomplete = true; continue; }
          if (latest.blocked) visible.push({...dto,authorizationStatus:'blocked',pending:false,selected:null,phoneState:null,localPhone:null});
          else visible.push(dto);
        } catch (error) { if (error?.code === 'whatsapp_authorization_forbidden' && actor.scope === null) continue; throw error; }
      }
      await verifyActor(actor);
      return {authorizations:visible,incomplete};
    } catch (error) {
      const clean = safe(error); throw Object.assign(Error(clean.code),{code:clean.code,status:clean.status,httpStatus:clean.status});
    } finally { cfg?.key?.fill(0); }
  }
  return Object.freeze({list});
}
module.exports = {createService,...createService()};
