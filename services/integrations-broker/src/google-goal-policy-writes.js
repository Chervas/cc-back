'use strict';
const C = require('./google-goal-policy-write-contract');
const R = require('./google-goal-policy-contract');
const ads = require('./google-ads-contract');
const P = require('./google-goal-policy-plan');
const { fail } = require('./errors');
// All provider data below are bounded account metadata, never credentials.
function createGoogleGoalPolicyWrites({ store, http, withDeveloperSecret, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_goal_policy_plans (
    id TEXT PRIMARY KEY,principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,asset TEXT NOT NULL,
    scope_digest TEXT NOT NULL,input_json TEXT NOT NULL,plan_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,
    phases_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','active','complete')),
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS google_goal_policy_locks (customer TEXT NOT NULL,resource TEXT NOT NULL,plan_id TEXT NOT NULL,
    PRIMARY KEY(customer,resource),FOREIGN KEY(plan_id) REFERENCES google_goal_policy_plans(id));`);
  const prepared = new WeakMap();
  const readRow = id => store.db.prepare('SELECT * FROM google_goal_policy_plans WHERE id=?').get(id);
  function load(context, principal) {
    const row = readRow(context.payload.planId);
    if (!row || row.principal !== principal.id || row.tenant !== context.tenantRef || row.connection !== context.binding.connectionRef
      || row.asset !== context.assetRef) fail('scope_denied');
    const input = JSON.parse(row.input_json), plan = JSON.parse(row.plan_json), phases = JSON.parse(row.phases_json);
    if (row.scope_digest !== C.scopeDigest(context.binding, context.assetRef, input, principal)) fail('scope_denied');
    return { row, input, plan, phases, snapshot: JSON.parse(row.snapshot_json) };
  }
  function summary(value) {
    return { planId: value.row.id, state: value.row.state, expiresAt: value.row.expires_at,
      planDigest: value.plan.plan_digest, phases: value.phases.map(p => ({ phase: p.phase,
        state: p.state === 'intent' ? 'unknown' : p.state, requestId: p.requestId, receiptSha256: p.receiptSha256,
        resources: p.resources, knownMutationCount: p.knownMutationCount, attemptedMutationCount: p.attemptedMutationCount })) };
  }
  const valid = value => { if (value.row.expires_at <= now()) fail('action_plan_expired'); };
  function guardPhase(value, payload, target) {
    const index = C.PHASES.indexOf(payload.phase), previous = value.phases[index - 1];
    if (previous && (previous.state !== 'ack' || previous.receiptSha256 !== payload.expectedPreviousAckSha256)
      || !previous && payload.expectedPreviousAckSha256 !== null) fail('action_plan_conflict');
    if (payload.phase === 'goal') { if (payload.ownership !== null) fail('scope_denied'); }
    else {
      const ack = value.phases[0], own = payload.ownership;
      if (!own || own.planId !== value.row.id || own.customerId !== target.customerId || ack.state !== 'ack'
        || own.goalResourceName !== ack.resources[0] || own.goalAckSha256 !== ack.receiptSha256) fail('scope_denied');
    }
  }
  async function inventory(context, target, developerToken) {
    const all = {}, deadline = now() + 120000; let total = 0, bytes = 0;
    for (const section of R.SECTIONS) {
      const rows = [], tokens = new Set(), keys = new Set(); let next = null;
      do {
        context.assertActive(); if (now() >= deadline) fail('provider_timeout');
        const payload = { section, campaignIds: target.account.campaign_ids, pageToken: null };
        const raw = await http({ hostname: 'googleads.googleapis.com', path: `/${ads.API_VERSION}/customers/${target.customerId}/googleAds:search`,
          token: context.secret, developerToken, loginCustomerId: target.loginCustomerId, signal: context.signal,
          json: { query: R.query(payload), ...(next ? { pageToken: next } : {}) } });
        context.assertActive(); if (now() >= deadline || !raw || typeof raw !== 'object' || Array.isArray(raw)
          || Object.keys(raw).some(k => !['results','nextPageToken','fieldMask','totalResultsCount','queryResourceConsumption'].includes(k))
          || raw.results !== undefined && !Array.isArray(raw.results)) fail('provider_failed');
        const page = (raw.results || []).map(row => R.project(row, payload, target));
        for (const row of page) { const key = ads.rowKey(row); if (keys.has(key)) fail('provider_failed'); keys.add(key); }
        rows.push(...page); total += page.length; bytes += Buffer.byteLength(JSON.stringify(page));
        next = raw.nextPageToken || null;
        if (rows.length > R.limit(payload) || next && (typeof next !== 'string' || next.length > 4096 || !page.length
          || rows.length === R.limit(payload) || tokens.has(next)) || total > 25001 || bytes > 33554432) fail('provider_failed');
        if (next) tokens.add(next);
      } while (next);
      if (section === 'tracking' && rows.length !== 1) fail('provider_failed'); all[section] = rows;
    }
    return { conversion_tracking: P.conversionTrackingFromRows(all.tracking, target.customerId),
      conversion_actions: all.actions.map(P.conversionActionFromRow).sort((a,b) => a.id.localeCompare(b.id,'en',{numeric:true})),
      custom_goals: all.custom_goals.map(P.customGoalFromRow).sort((a,b) => a.resource_name.localeCompare(b.resource_name)),
      campaign_configs: all.campaign_configs.map(P.campaignConfigFromRow).sort((a,b) => a.campaign_id.localeCompare(b.campaign_id,'en',{numeric:true})),
      campaign_conversion_goals: all.campaign_goals.map(P.campaignGoalFromRow).sort((a,b) => `${a.campaign_id}:${a.category}:${a.origin}`.localeCompare(`${b.campaign_id}:${b.category}:${b.origin}`)),
      customer_conversion_goals: all.customer_goals.map(P.customerGoalFromRow).sort((a,b) => `${a.category}:${a.origin}`.localeCompare(`${b.category}:${b.origin}`)) };
  }
  function expected(value) {
    const s = structuredClone(value.snapshot), plan = value.plan, phases = value.phases;
    const goalName = phases[0].resources[0] || plan.owned_custom_goal_resource_name;
    if (phases[0].state === 'ack' && plan.operations.custom_goal) {
      const op = plan.operations.custom_goal;
      if (op.create) s.custom_goals.push({ id: goalName.split('/').pop(), resource_name: goalName, name: op.create.name,
        status: 'ENABLED', conversion_actions: [...op.create.conversionActions].sort() });
      else s.custom_goals.find(r => r.resource_name === goalName).conversion_actions = [...op.update.conversionActions].sort();
      s.custom_goals.sort((a,b) => a.resource_name.localeCompare(b.resource_name));
    }
    if (phases[1].state === 'ack') for (const op of plan.operations.campaign_goal_configs) {
      const row = s.campaign_configs.find(r => r.resource_name === op.update.resourceName);
      const goal = s.custom_goals.find(r => r.resource_name === goalName);
      row.custom_conversion_goal = goalName; row.goal_config_level = 'CAMPAIGN'; row.custom_goal_name = goal.name; row.custom_goal_status = goal.status;
    }
    if (phases[2].state === 'ack') for (const op of plan.operations.campaign_conversion_goals)
      s.campaign_conversion_goals.find(r => r.resource_name === op.update.resourceName).biddable = false;
    return s;
  }
  function lockKeys(value, target) {
    return ['goal:' + (target.account.owned_custom_goal_resource_name || target.account.custom_goal_name),
      ...target.account.campaign_ids.map(id => 'campaign:' + id)];
  }
  function reserveLocks(value, target) {
    store.transaction(() => {
      // Only unattempted expired plans may lose locks. ACK/UNKNOWN stay durable.
      store.db.prepare("DELETE FROM google_goal_policy_locks WHERE plan_id IN (SELECT id FROM google_goal_policy_plans WHERE state='prepared' AND expires_at<=?)").run(now());
      for (const key of lockKeys(value, target)) {
        const row = store.db.prepare('SELECT plan_id FROM google_goal_policy_locks WHERE customer=? AND resource=?').get(target.customerId,key);
        if (row && row.plan_id !== value.row.id) fail('action_plan_busy');
        store.db.prepare('INSERT OR IGNORE INTO google_goal_policy_locks VALUES (?,?,?)').run(target.customerId,key,value.row.id);
      }
    });
  }
  const operations = Object.fromEntries(Object.entries(C.OPERATIONS).map(([family, operation]) => [operation, {
    provider: ads.PROVIDER, requiredScopes: ads.SCOPES, effect: family === 'apply' ? 'write' : 'read', persistResult: true,
    secretless: family === 'status', validate: payload => C.validate(operation,payload),
    authorize({ request, principal, binding }) {
      if (family === 'prepare') C.resource(binding,request.assetRef,request.payload);
      else load({ ...request,binding },principal);
    },
    async execute(context) {
      const principal = context.policy.principals.find(r => r.id === context.principalId);
      if (family === 'status') { context.assertActive(); return summary(load(context,principal)); }
      return withDeveloperSecret(context.binding, async developerToken => {
        context.assertActive();
        if (family === 'prepare') {
          const target = C.resource(context.binding,context.assetRef,context.payload);
          const snapshot = await inventory(context,target,developerToken);
          const plan = P.buildClinicaclickGoalPolicyPlan({ account: target.account,snapshot });
          P.assertSafePlanOperations(target.account,plan);
          C.assertResponseBudget(plan,target,context.requestId);
          if (plan.plan_digest !== context.payload.expectedDigest) fail('action_plan_conflict');
          if (plan.operations.custom_goal?.create && !target.policy.allowCreate || plan.operations.custom_goal?.update && !target.policy.allowUpdate) fail('scope_denied');
          const at = now(), phases = C.PHASES.map(phase => ({ phase,state:'pending',requestId:null,receiptSha256:null,
            resources:[],knownMutationCount:0,attemptedMutationCount:0 }));
          const value = { row:{id:context.requestId,state:'prepared',expires_at:at+C.TTL_MS},plan,phases };
          return { ...summary(value),internal:{ at,plan,snapshot,phases,input:context.payload,
            scope:C.scopeDigest(context.binding,context.assetRef,context.payload,principal) } };
        }
        let value = load(context,principal); const target = C.resource(context.binding,context.assetRef,value.input);
        C.assertResponseBudget(value.plan,target,value.row.id);
        guardPhase(value,context.payload,target);
        const index = C.PHASES.indexOf(context.payload.phase), phase = value.phases[index];
        if (phase.state === 'intent' || phase.state === 'unknown') fail('outcome_unknown');
        if (family === 'apply' && phase.state === 'ack') return summary(value); // Observation, never a repeat.
        valid(value);
        const drift = async () => {
          context.assertActive(); valid(value);
          const fresh = await inventory(context,target,developerToken);
          if (C.hash(fresh) !== C.hash(expected(value))) fail('action_plan_conflict');
          context.assertActive(); valid(value);
        };
        const ops = C.phaseOperations(value.plan,context.payload.phase,value.phases[0].resources[0]);
        const send = async validateOnly => {
          const body = { operations:ops,validateOnly,
            ...(context.payload.phase !== 'campaign_goals' ? {responseContentType:'RESOURCE_NAME_ONLY'} : {}) };
          C.validateMutation(C.endpoint(target.customerId,context.payload.phase),context.payload.phase,body);
          return http({ hostname:'googleads.googleapis.com',path:C.endpoint(target.customerId,context.payload.phase),
            token:context.secret,developerToken,loginCustomerId:target.loginCustomerId,signal:context.signal,
            goalPolicyMutation:context.payload.phase,json:body });
        };
        await drift();
        if (family === 'validate') {
          if (phase.state === 'pending' && ops.length) { const raw = await send(true); context.assertActive(); C.result(raw,context.payload.phase,ops,target,true); await drift(); }
          return { ...summary(value),validated:true,internal:{finalReadBack:value.phases.every(p => p.state === 'ack')} };
        }
        reserveLocks(value,target);
        if (ops.length) { const raw = await send(true); context.assertActive(); C.result(raw,context.payload.phase,ops,target,true); await drift(); }
        store.transaction(() => {
          context.assertActive(); value = load(context,principal); valid(value); guardPhase(value,context.payload,target);
          if (value.phases[index].state !== 'pending') fail('outcome_unknown');
          value.phases[index] = { ...value.phases[index],state:'intent',requestId:context.requestId,attemptedMutationCount:ops.length };
          store.db.prepare("UPDATE google_goal_policy_plans SET phases_json=?,state='active' WHERE id=?").run(JSON.stringify(value.phases),value.row.id);
        });
        try {
          // INTENT is fsynced by SQLite FULL before the only real mutation call.
          // On a valid response, ACK is durably stored BEFORE post-await authority.
          const raw = ops.length ? await send(false) : {results:[]};
          let resources = C.result(raw,context.payload.phase,ops,target,false);
          if (context.payload.phase === 'goal' && !ops.length) resources = [target.account.owned_custom_goal_resource_name];
          const ack = { planId:value.row.id,phase:context.payload.phase,requestId:context.requestId,resources,
            knownMutationCount:ops.length,attemptedMutationCount:ops.length };
          value.phases[index] = { ...value.phases[index],state:'ack',resources,knownMutationCount:ops.length,receiptSha256:C.hash(ack) };
          store.transaction(() => store.db.prepare('UPDATE google_goal_policy_plans SET phases_json=? WHERE id=?')
            .run(JSON.stringify(value.phases),value.row.id));
          context.assertActive(); valid(value); await drift();
          return { ...summary(load(context,principal)),internal:{finalReadBack:value.phases.every(p => p.state === 'ack')} };
        } catch (error) {
          store.transaction(() => {
            const current = readRow(value.row.id), phases = JSON.parse(current.phases_json);
            if (phases[index].state === 'intent') { phases[index].state = 'unknown';
              store.db.prepare('UPDATE google_goal_policy_plans SET phases_json=? WHERE id=?').run(JSON.stringify(phases),value.row.id); }
          });
          throw error;
        }
      },{signal:context.signal});
    },
    project(raw) {
      if (!raw || Buffer.byteLength(JSON.stringify({ ...raw,internal:undefined })) > 32768) fail('provider_failed');
      const {internal,...value} = raw; if (internal) prepared.set(value,internal); return value;
    },
    commit({request,principal,result}) {
      if (family === 'prepare') {
        const value = prepared.get(result.data); if (!value) fail('provider_failed');
        store.db.prepare("INSERT INTO google_goal_policy_plans VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',?,?)")
          .run(request.requestId,principal.id,request.tenantRef,request.connectionRef,request.assetRef,value.scope,
            JSON.stringify(value.input),JSON.stringify(value.plan),JSON.stringify(value.snapshot),JSON.stringify(value.phases),value.at,result.data.expiresAt);
      } else if (family === 'apply' || family === 'validate') {
        const row = readRow(request.payload.planId), phases = JSON.parse(row.phases_json);
        // This is reached only after exact fresh readback and final generic
        // authority check; status alone can never release a lock or resolve UNKNOWN.
        if (request.payload.phase === 'campaign_goals' && phases.every(p => p.state === 'ack')
          && prepared.get(result.data)?.finalReadBack === true) {
          store.db.prepare("UPDATE google_goal_policy_plans SET state='complete' WHERE id=?").run(row.id);
          store.db.prepare('DELETE FROM google_goal_policy_locks WHERE plan_id=?').run(row.id);
          result.data.state = 'complete';
        }
      }
    },
    completionAudit() { return ['integration.completed','success',family === 'apply' ? 'goal_policy_phase_checked' : 'goal_policy_checked']; },
  }]));
  return { operations };
}
module.exports = { createGoogleGoalPolicyWrites };
