"use strict";

// This is SQL ordering, never authority. Full OAuth/Business/Recovery guards run
// after the fences. InnoDB absent-key gap locks are compatible, not a mutex.
// Existing rows: current Enrollment -> same-scope ancestors -> Flow -> auth.
// No row: Flow -> FIRST RR Enrollment birth check -> auth. A changed locator
// rolls back before late locks/work and gets at most one SQL-only reconciliation.
const C = require('./metaMarketingOAuth.contract');
const RETRY = Symbol('meta-marketing-sql-order-reconcile');
const plain = row => row?.get ? row.get({ plain: true }) : row;
const pinInput = input => input ? { ...input, sessionExpiresAt: input.sessionExpiresAt instanceof Date ? new Date(+input.sessionExpiresAt) : input.sessionExpiresAt } : null;
const id = row => row?.enrollment_id ?? null;
const E_FIELDS = ['enrollment_id', 'flow_id', 'scope_key', 'app_id'];
const F_FIELDS = ['flow_id', 'scope_key', 'app_id'];
const H_FIELDS = ['handover_id', 'new_enrollment_id', 'old_enrollment_id', 'scope_key', 'app_id'];
const tuple = (row, fields) => JSON.stringify(fields.map(key => row?.[key]));
const changed = () => { const error=Object.assign(Error('meta_marketing_order_changed'),{code:'meta_marketing_order_changed',httpStatus:503});error[RETRY]=true;throw error; };
const isChanged = error => error?.[RETRY] === true;
function createOrder({ models, authorize, unavailable, missingFlow = unavailable }) {
  const E = models.MetaMarketingEnrollmentRequest, F = models.MetaMarketingOAuthRequest, H = models.MetaMarketingBusinessHandover;
  const tx = work => models.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, work);
  const locked = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false });
  const latest = [['requested_at', 'DESC'], ['flow_id', 'DESC']], eLatest = [['requested_at', 'DESC'], ['enrollment_id', 'DESC']];
  const eOptions = { attributes: E_FIELDS, raw: true, logging: false }, fOptions = { attributes: F_FIELDS, raw: true, logging: false };
  async function run(input, work) {
    const pinned = pinInput(input);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (pinned) await tx(transaction => authorize(pinned, transaction));
      try { return await work(pinned); } catch (error) { if (error !== RETRY) throw error; }
    }
    unavailable();
  }
  async function observe(scopeKey, flowId, appId) {
    if (!/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey || '') || !C.UUID.test(flowId) || !/^[1-9][0-9]{0,29}$/.test(appId || '')) unavailable();
    const head = E ? plain(await E.findOne({ ...eOptions, where: { scope_key: scopeKey }, order: eLatest })) : null;
    const prefix = [], edges = [], visited = new Set();let current = head;
    const validate = row => {
      if (!row || !C.UUID.test(row.enrollment_id) || !C.UUID.test(row.flow_id) || row.scope_key !== scopeKey || row.app_id !== appId) unavailable();
    };
    while (current) {
      validate(current);
      if (visited.has(current.enrollment_id) || prefix.length >= 16) unavailable();
      visited.add(current.enrollment_id);prefix.push(current);
      const edge = H ? plain(await H.findByPk(current.flow_id, { attributes: H_FIELDS, raw: true, logging: false })) : null;
      if (!edge) break;
      if (edge.handover_id !== current.flow_id || edge.new_enrollment_id !== current.enrollment_id || edge.scope_key !== scopeKey
        || edge.app_id !== appId || !C.UUID.test(edge.old_enrollment_id)) unavailable();
      edges.push(edge);
      current = plain(await E.findByPk(edge.old_enrollment_id, eOptions));
      if (!current) unavailable();
    }
    const linked = E ? plain(await E.findOne({ ...eOptions, where: { flow_id: flowId, scope_key: scopeKey } })) : null;
    if (linked) {
      validate(linked);
      if (!head) throw RETRY;
      if (!visited.has(linked.enrollment_id)) prefix.push(linked);
    }
    return { scopeKey, flowId, appId, head, linked, prefix, edges };
  }
  async function lockPrefix(observed, transaction) {
    for (const hint of observed.prefix) {
      const saved = plain(await E.findByPk(hint.enrollment_id, { ...eOptions, ...locked(transaction) }));
      if (!saved || tuple(saved, E_FIELDS) !== tuple(hint, E_FIELDS)) throw RETRY;
    }
    // Lock only the locator links after the Enrollment prefix. They convey no
    // grant permission; BusinessSource later validates complete receipts/snapshots.
    for (const hint of observed.edges) {
      const saved = plain(await H.findByPk(hint.handover_id, { attributes: H_FIELDS, ...locked(transaction) }));
      if (!saved || tuple(saved, H_FIELDS) !== tuple(hint, H_FIELDS)) throw RETRY;
    }
  }
  async function birthCheck(observed, transaction) {
    // MUST be the first ordinary read of the main RR transaction. All prior
    // reads are current locking reads. Never run auth/assets/writes before it.
    const linked = E ? plain(await E.findOne({ ...eOptions, where: { flow_id: observed.flowId, scope_key: observed.scopeKey }, transaction })) : null;
    if (tuple(linked, E_FIELDS) !== tuple(observed.linked, E_FIELDS)) throw RETRY;
    const head = E ? plain(await E.findOne({ ...eOptions, where: { scope_key: observed.scopeKey }, order: eLatest, transaction })) : null;
    if (tuple(head, E_FIELDS) !== tuple(observed.head, E_FIELDS)) throw RETRY;
    return { linked, head };
  }
  async function prepareEnrollment(enrollmentId, { scopeKey = null, appId = null } = {}) {
    if (!C.UUID.test(enrollmentId)) return unavailable();
    const hint = plain(await E.findByPk(enrollmentId, eOptions));
    if (!hint) return null;
    if (scopeKey !== null && hint.scope_key !== scopeKey || appId !== null && hint.app_id !== appId) return unavailable();
    const observed = await observe(hint.scope_key, hint.flow_id, hint.app_id);
    if (id(observed.linked) !== enrollmentId) return unavailable();
    return { enrollmentId, observed };
  }
  async function lockPrepared(prepared, transaction) {
    if (!transaction?.LOCK?.UPDATE || transaction.finished || !prepared?.observed) return unavailable();
    try {
      await lockPrefix(prepared.observed, transaction);
      const current = await birthCheck(prepared.observed, transaction);
      if (id(current.linked) !== prepared.enrollmentId) throw RETRY;
      return current;
    } catch (error) {
      // Existing caller-owned transactions cannot restart after an earlier
      // incident/audit operation. Deny temporarily and let their owner roll
      // back; never turn stale metadata or storage failure into withdrawal.
      if (error === RETRY) return unavailable();
      throw error;
    }
  }
  async function prepareScopes(scopeKeys,enrollmentIds=[]){
    if(!Array.isArray(scopeKeys)||scopeKeys.length>1000||!Array.isArray(enrollmentIds)||enrollmentIds.length>1000)return unavailable();
    const scopes=new Map();
    for(const scopeKey of [...new Set(scopeKeys)].sort()){
      if(!/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey))return unavailable();
      const head=E?plain(await E.findOne({...eOptions,where:{scope_key:scopeKey},order:eLatest})):null;
      const flowHint=F?plain(await F.findOne({...fOptions,where:{scope_key:scopeKey},order:latest})):null;
      const observed=head?await observe(scopeKey,head.flow_id,head.app_id):flowHint?await observe(scopeKey,flowHint.flow_id,flowHint.app_id):null;
      if(observed&&flowHint&&flowHint.app_id!==observed.appId)return unavailable();
      scopes.set(scopeKey,{scopeKey,head:observed?.head??null,flowHint,observed,prefix:observed?[...observed.prefix]:[],edges:observed?[...observed.edges]:[]});
    }
    for(const enrollmentId of [...new Set(enrollmentIds)].sort()){
      const prepared=await prepareEnrollment(enrollmentId);if(!prepared)return unavailable();
      const observed=prepared.observed,item=scopes.get(observed.scopeKey);if(!item||!item.observed||tuple(item.head,E_FIELDS)!==tuple(observed.head,E_FIELDS)||item.observed.appId!==observed.appId)return unavailable();
      for(const row of observed.prefix)if(!item.prefix.some(value=>value.enrollment_id===row.enrollment_id))item.prefix.push(row);
      for(const row of observed.edges)if(!item.edges.some(value=>value.handover_id===row.handover_id))item.edges.push(row);
    }
    return {scopes:[...scopes.values()]};
  }
  async function lockScopes(prepared,transaction){
    if(!prepared?.scopes||!transaction?.LOCK?.UPDATE||transaction.finished)return unavailable();
    // Across an overlapping scope set, finish EVERY E prefix before any H,
    // User/Clinic, mapping or tombstone lock. Never acquire an absent E gap.
    for(const item of prepared.scopes)for(const hint of item.prefix){
      const row=plain(await E.findByPk(hint.enrollment_id,{...eOptions,...locked(transaction)}));
      if(!row||tuple(row,E_FIELDS)!==tuple(hint,E_FIELDS))changed();
    }
    for(const item of prepared.scopes)for(const hint of item.edges){
      const row=plain(await H.findByPk(hint.handover_id,{attributes:H_FIELDS,...locked(transaction)}));
      if(!row||tuple(row,H_FIELDS)!==tuple(hint,H_FIELDS))changed();
    }
    for(const item of prepared.scopes)if(item.flowHint){
      const row=plain(await F.findByPk(item.flowHint.flow_id,{...fOptions,...locked(transaction)}));
      if(!row||tuple(row,F_FIELDS)!==tuple(item.flowHint,F_FIELDS))changed();
    }
  }
  async function validateScopes(prepared,transaction){
    // Mixed existing/no-journal scopes cannot share a stale first RR snapshot.
    // After fresh Clinic locks, use current NOWAIT reads: never wait for a late
    // E/Flow owner that may itself be waiting for our Clinic locks. Empty ranges
    // are fenced only NOW, in the creator's Clinic -> first-Flow order.
    async function current(table,fields,order,scopeKey){
      try{
        const [rows]=await models.sequelize.query('SELECT '+fields.map(field=>'`'+field+'`').join(',')+' FROM `'+table+'` WHERE `scope_key`=$scopeKey ORDER BY '+order+' LIMIT 1 FOR UPDATE NOWAIT',
          {bind:{scopeKey},transaction,logging:false});return plain(rows[0])||null;
      }catch(error){if((error?.original?.code||error?.parent?.code||error?.code)==='ER_LOCK_NOWAIT')changed();throw error;}
    }
    for(const item of prepared.scopes){
      const head=E?await current('MetaMarketingEnrollmentRequests',E_FIELDS,'`requested_at` DESC,`enrollment_id` DESC',item.scopeKey):null;
      const flow=F?await current('MetaMarketingOAuthRequests',F_FIELDS,'`requested_at` DESC,`flow_id` DESC',item.scopeKey):null;
      if(tuple(head,E_FIELDS)!==tuple(item.head,E_FIELDS)||tuple(flow,F_FIELDS)!==tuple(item.flowHint,F_FIELDS))changed();
    }
  }
  async function flowAttempt(input, flowId, work) {
    const hint = plain(await F.findByPk(flowId, fOptions));
    if (!hint || input && hint.scope_key !== input.scopeKey) return tx(async transaction => {
      // Unknown IDs never acquire a Flow PK gap or invoke work. First begin can
      // own User/Clinic while inserting into that gap; deny only after fresh auth.
      if (input) await authorize(input, transaction);
      return missingFlow();
    });
    const observed = await observe(hint.scope_key, flowId, hint.app_id);
    return tx(async transaction => {
      await lockPrefix(observed, transaction);
      const flow = plain(await F.findByPk(flowId, { ...fOptions, ...locked(transaction) }));
      if (!flow || tuple(flow, F_FIELDS) !== tuple(hint, F_FIELDS)) throw RETRY;
      const current = await birthCheck(observed, transaction);
      return work({ transaction, flow, enrollment: current.linked, input, observed });
    });
  }
  const flow = (input, flowId, work) => run(input, pinned => flowAttempt(pinned, flowId, async context => {
    if (pinned) await authorize(pinned, context.transaction);
    return work(context);
  }));
  async function scope(input, { active = false } = {}, work) {
    return run(input, async pinned => {
      const hint = F ? plain(await F.findOne({ ...fOptions, where: { scope_key: pinned.scopeKey }, order: latest })) : null;
      if (hint) return flowAttempt(pinned, hint.flow_id, async context => {
        // Current read before fresh User/Clinic locks. Every ordinary begin uses
        // this order too; changed latest Flow reconciles before entering Recovery.
        const current = plain(await F.findOne({ ...fOptions, ...locked(context.transaction), where: { scope_key: pinned.scopeKey }, order: latest }));
        if (!current || tuple(current, F_FIELDS) !== tuple(hint, F_FIELDS)) throw RETRY;
        const selected = active && E ? plain(await E.findOne({ ...eOptions, where: { scope_key: pinned.scopeKey, state: 'active' }, order: eLatest, transaction: context.transaction })) : context.observed.head;
        if (selected && !context.observed.prefix.some(row => row.enrollment_id === selected.enrollment_id)) throw RETRY;
        await authorize(pinned, context.transaction);
        return work({ ...context, flow: current, enrollment: selected, input: pinned, expectedFlowId: current.flow_id });
      });
      const head = E ? plain(await E.findOne({ ...eOptions, where: { scope_key: pinned.scopeKey }, order: eLatest })) : null;
      if (head) return unavailable(); // append-only grants cannot lose originating OAuth history
      return tx(async transaction => {
        // No journals: Clinic locks serialize the first Flow creator. These are
        // the first RR reads; appeared journals reconcile before any late lock.
        // Scope.authorize normal email sessions use locking reads only.
        await authorize(pinned, transaction);
        const currentFlow = F ? await F.findOne({ ...fOptions, where: { scope_key: pinned.scopeKey }, order: latest, transaction }) : null;
        const current = E ? plain(await E.findOne({ ...eOptions, where: { scope_key: pinned.scopeKey }, order: eLatest, transaction })) : null;
        if (currentFlow || current) throw RETRY;
        return work({ transaction, enrollment: null, flow: null, input: pinned, expectedFlowId: null });
      });
    });
  }
  const enrollment = (input, enrollmentId, work) => run(input, async pinned => {
    const hint = plain(await E.findOne({ ...eOptions, where: { enrollment_id: enrollmentId, scope_key: pinned.scopeKey } }));
    if (!hint) return tx(async transaction => { await authorize(pinned, transaction);return work({ transaction, enrollment: null, input: pinned }); });
    const observed = await observe(pinned.scopeKey, hint.flow_id, hint.app_id);
    return tx(async transaction => {
      await lockPrefix(observed, transaction);
      const current = await birthCheck(observed, transaction);
      if (id(current.linked) !== enrollmentId) throw RETRY;
      await authorize(pinned, transaction);
      return work({ transaction, enrollment: current.linked, input: pinned });
    });
  });
  return { flow, scope, enrollment, prepareEnrollment, lockPrepared,prepareScopes,lockScopes,validateScopes,changed,isChanged };
}
module.exports = { createOrder, pinInput, changed, isChanged };
