#!/usr/bin/env node
'use strict';

// Historical texts stay in private files. Only the approved AI broker can be
// reached; application models, deliveries and clinical actions are never loaded.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { loadSource } = require('../tests/fixtures/business_profile_flow_runtime.fixture');
const { hash } = require('../../lib/appointment-single-notice-publication');
const notice = require('../../lib/appointment-single-notice-flow');
const args = process.argv.slice(2);
const arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const fresh = args.includes('--fresh-ai');
const messageCopy = args.includes('--message-copy');
const copyPublication = require('../../lib/appointment-copy-publication');
const fail = code => { throw Object.assign(Error(code), { code }); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
function privateFile(file, output = false) {
  if (!path.isAbsolute(file || '') || !file.startsWith('/home/ubuntu/secure-imports/')) fail('private_path_required');
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent || fs.statSync(parent).mode & 0o077) fail('private_directory_required');
  if (output ? fs.existsSync(file) : !fs.statSync(file).isFile()) fail('new_output_or_existing_input_required');
  return file;
}

async function main() {
  const casesFile = arg('--cases'), planFile = privateFile(arg('--plan'));
  const output = privateFile(arg('--report'), true), expectationsFile = arg('--expectations');
  if (![casesFile, expectationsFile].every(file => path.isAbsolute(file || '')
    && file.startsWith('/home/ubuntu/secure-imports/'))) fail('private_corpus_required');
  const casesBytes = fs.readFileSync(casesFile), corpus = JSON.parse(casesBytes);
  const expectations = read(expectationsFile), plan = read(planFile);
  const storedResults = !fresh && arg('--inference-report') ? read(arg('--inference-report')).results : null;
  if (storedResults?.some(item => !item.expectedSafetyHold && (!item.inference || item.inference.raw == null))) {
    fail('historical_raw_inference_missing');
  }
  const storedInferences = storedResults ? new Map(storedResults.map(item => [item.id, item.inference?.raw])) : null;
  if (!fresh && !storedInferences) fail('offline_drill_requires_stored_raw_inference_report');
  assert.equal(plan.read_only, true);
  assert.equal(expectations.reviewedBeforeInference, true);
  assert.equal(expectations.casesSha256, digest(casesBytes));
  const labels = new Map(expectations.expectations.map(item => [item.id, item]));
  const selected = [], excluded = [];
  for (const item of corpus.cases) {
    if (arg('--case-id') && String(item.id) !== arg('--case-id')) continue;
    let matches = plan.entries.filter(entry => entry.source.public_id === item.currentPathEvidence?.publicId
      && Number(entry.source.clinic_id || 0) === Number(item.clinic_id || 0));
    // A public reference can be shared by a central and scoped family. Prefer
    // the evidenced source ID; never silently select another clinic/group.
    if (matches.length > 1) matches = matches.filter(entry => Number(entry.source.id) === Number(item.currentPathEvidence.templateId));
    if (!matches.length) { excluded.push({ id: item.id, reason: 'family_outside_current_change' }); continue; }
    assert.equal(matches.length, 1, 'historical_scope_ambiguous');
    const entry = matches[0], node = entry.source.nodes.find(candidate => candidate.id === item.node.id);
    assert(node?.type === 'condition/ai_analysis', 'historical_ai_node_missing');
    assert.equal(node.config.preset_key, item.preset, 'historical_ai_preset_changed');
    assert(labels.has(item.id), 'historical_expectation_missing');
    if (!fresh && args.includes('--stored-cases-only') && !storedInferences.has(item.id)) {
      excluded.push({ id: item.id, reason: 'raw_inference_not_recorded' }); continue;
    }
    selected.push({ item, entry, node, expected: labels.get(item.id) });
  }
  const limit = arg('--limit') ? Number(arg('--limit')) : selected.length;
  assert(Number.isSafeInteger(limit) && limit > 0 && limit <= selected.length);
  const repeat = arg('--repeat') ? Number(arg('--repeat')) : 1;
  assert(Number.isSafeInteger(repeat) && repeat > 0 && repeat <= 40);
  const sample = Array.from({ length: repeat }, () => selected.slice(0, limit)).flat();
  let connection, provider, orchestrator, current, cached, inferenceRequest, phase;
  let deliveries = 0, clinicalWrites = 0, forbiddenNetwork = 0, guardReads = 0;
  const telemetry = [], providerTrace = [], failures = [], results = [];
  const forbidden = () => { clinicalWrites++; fail('historical_application_write_forbidden'); };
  const forbiddenDelivery = () => { deliveries++; fail('historical_delivery_forbidden'); };
  const db = {
    Conversation: { findByPk: async () => current.item.context.conversation,
      findOne: async () => current.item.context.conversation },
    CitaPaciente: { findByPk: async () => current.item.context.appointment || null },
    Message: { findAll: async ({ where = {}, limit: maximum } = {}) => {
      const { Op } = require('sequelize');
      let messages = current.item.messages.filter(message =>
        Number(message.conversation_id) === Number(current.item.context.conversation.id)
        && (!where.conversation_id || Number(message.conversation_id) === Number(where.conversation_id))
        && (!where.direction || message.direction === where.direction)
        && new Date(message.sent_at || message.createdAt).getTime() <= new Date(current.item.at).getTime());
      if (typeof where.message_type === 'string') messages = messages.filter(message => message.message_type === where.message_type);
      else if (where.message_type?.[Op.notIn]) messages = messages.filter(message => !where.message_type[Op.notIn].includes(message.message_type));
      if (where.id) {
        const ids = typeof where.id === 'object' ? where.id[Op.in] : [where.id];
        assert(Array.isArray(ids), 'historical_message_id_query_unsupported');
        messages = messages.filter(message => ids.map(Number).includes(Number(message.id)));
      }
      return maximum ? messages.slice(0, maximum) : messages;
    } },
    Sequelize: require('sequelize'), sequelize: { query: forbidden, transaction: forbidden },
  };
  for (const model of Object.values(db)) if (model && typeof model === 'object') {
    for (const method of ['create', 'update', 'destroy', 'bulkCreate', 'findOrCreate', 'upsert']) model[method] = forbidden;
  }
  const modelsPath = require.resolve('../../../models');
  assert(!require.cache[modelsPath], 'real_models_already_loaded');
  require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: db };
  const dotenv = require.resolve('dotenv');
  // The operator reads an explicit runtime configuration below; application
  // imports cannot load a .env or bootstrap DEV with CRM credentials.
  const actualDotenv = require('dotenv');
  require.cache[dotenv] = { id: dotenv, filename: dotenv, loaded: true,
    exports: { ...actualDotenv, config: () => ({ parsed: {} }) } };
  const env = { JOB_RUNTIME_NAMESPACE: 'historical-qa', JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway' };
  let brokerUrl;
  if (fresh) {
    const observed = require('../security-email-login-metadata').observedEnvironment('staging');
    const allowed = Object.fromEntries(Object.entries(observed.env).filter(([key]) => /^BEDROCK_(?:ENABLED|REGION|TIMEOUT_MS|MODEL_|BROKER_)/.test(key)));
    assert.equal(allowed.BEDROCK_BROKER_ENABLED, 'true', 'authorized_broker_required');
    assert.equal(allowed.BEDROCK_ENABLED, 'true', 'authorized_provider_required');
    Object.assign(process.env, allowed);
    brokerUrl = new URL(allowed.BEDROCK_BROKER_ORIGIN);
    const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
    connection = await connectOperatorDatabase('crm');
    const monitoring = { assertAiAllowed: async useCase => {
      // Each check is a fresh read-only transaction, so a manual pause during
      // this sequential drill is not hidden by an old consistent snapshot.
      await connection.query('START TRANSACTION READ ONLY');
      try {
        const [rows] = await connection.query("SELECT id FROM SecurityMonitoringMeasures WHERE entity_type='ai_use_case' AND entity_id=? AND paused=1 LIMIT 1", [useCase]);
        guardReads++;
        if (rows.length) fail('ai_function_manually_paused');
      } finally { await connection.rollback(); }
    } };
    provider = require('../../services/bedrockAiProvider.service');
    const analyze = provider.analyzeStructured;
    provider.analyzeStructured = async request => {
      const trace = { model: request.model, maxTokens: Math.max(32, Math.min(4096, Number(request.maxTokens) || 700)) };
      providerTrace.push(trace);
      try {
        const result = await analyze(request);
        Object.assign(trace, { usage: result.usage, stopReason: result.stop_reason });
        return result;
      } catch (error) { trace.error = provider.providerErrorCode(error); throw error; }
    };
    orchestrator = loadSource('aiOrchestrator.service', {
      './bedrockAiProvider.service': provider, './securityMonitoring.service': monitoring,
      './aiUsageTelemetry.service': { recordAiUsage: async value => telemetry.push(value) },
    }, allowed);
  }
  const net = require('node:net'), connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...input) {
    let options = input[0];
    if (Array.isArray(options)) options = options[0];
    if (typeof options === 'number') options = { port: options, host: typeof input[1] === 'string' ? input[1] : 'localhost' };
    if (!fresh || !options || options.path || options.host !== brokerUrl.hostname
      || Number(options.port) !== Number(brokerUrl.port || 443)) {
      forbiddenNetwork++; fail('historical_unapproved_network_forbidden');
    }
    return connect.apply(this, input);
  };
  global.fetch = () => { forbiddenNetwork++; fail('historical_fetch_forbidden'); };
  const queuePath = require.resolve('../../services/queue.service');
  require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true,
    exports: { queues: new Proxy({}, { get: () => ({ add: forbiddenDelivery }) }) } };
  const aiAdapter = { analyzeStructured: async request => {
    if (phase === 'modified') {
      assert.equal(inferenceRequest, undefined, 'more_than_one_analysis_request');
      inferenceRequest = structuredClone(request);
      if (fresh) cached = await orchestrator.analyzeStructured(request);
      else {
        assert(storedInferences.has(current.item.id), 'historical_raw_inference_missing');
        cached = structuredClone(storedInferences.get(current.item.id));
      }
      return structuredClone(cached);
    }
    assert.equal(hash(request), hash(inferenceRequest), 'analysis_request_changed_by_flow_reduction');
    return structuredClone(cached);
  } };
  const engine = loadSource('flowEngineV2.service', {
    '../../models': db, './socket.service': { getIO: () => null }, './queue.service': { queues: {} },
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'historical-qa' },
    './aiOrchestrator.service': aiAdapter,
    './whatsapp.service': { sendMessage: forbiddenDelivery, sendTemplate: forbiddenDelivery },
    './appointmentActivity.service': { recordAppointmentStatusChange: forbidden },
  }, env);
  const restoreClock = require('./historical-replay-context').installHistoricalConversationClock(
    require('../../lib/automation-conversation-context'), () => current?.item);
  const report = {
    complete: false, freshInference: fresh, modifiedProduction: false, sends: 0, clinicalWrites: 0,
    casesSha256: digest(casesBytes), planSha256: digest(fs.readFileSync(planFile)),
    generatedAt: new Date().toISOString(), planGeneratedAt: plan.generated_at,
    eligibleCases: selected.length, sampledCases: sample.length, excludedCases: excluded.length,
    candidate: Object.fromEntries(['src/services/flowEngineV2.service.js', 'src/lib/automation-intent-contract.js',
      'src/lib/automation-conversation-context.js', 'src/lib/appointment-single-notice-flow.js'].map(file =>
      [file, digest(fs.readFileSync(path.resolve(__dirname, '../../..', file)))])),
    graphChecks: { graphs: 0, retiredSends: 0, unchangedAiNodes: 0, unchangedComparators: 0, silenceBranches: 0 },
    limitation: 'Historical reconstructed inputs, not exact original inference snapshots. Actions are planned, never executed. Existing second-message replies retain their actual reference; no historic event is replayed into a runtime.',
    results, failures,
  };
  async function route(nodes, node, context, output) {
    context.outputs[node.id] = output.output;
    let next = output.next_node_id, steps = 0;
    const visits = [], actions = [];
    while (next && steps++ < 120) {
      const currentNode = nodes.find(candidate => candidate.id === next);
      assert(currentNode, 'historical_route_node_missing');
      visits.push(currentNode.id);
      if (currentNode.type.startsWith('action/')) {
        actions.push({ id: currentNode.id, type: currentNode.type, config: currentNode.config });
        next = currentNode.outputs?.on_success;
      } else if (['condition/field_check', 'control/end'].includes(currentNode.type)) {
        const result = await engine._processNode(currentNode, context, { simulation: true });
        context.outputs[currentNode.id] = result.output;
        next = result.next_node_id;
      } else break;
    }
    assert(steps < 120, 'historical_route_cycle');
    return { visits, actions };
  }
  try {
    // Check every current scoped graph, not just families with a historic sample.
    for (const entry of plan.entries) {
      if (messageCopy) {
        const nodes = copyPublication.preservedNodes(entry.source, entry.body);
        assert.equal(hash(nodes.map(n => [n.id,n.type,n.outputs])), hash(entry.source.nodes.map(n => [n.id,n.type,n.outputs])));
        for (const node of entry.source.nodes.filter(n => ['condition/ai_analysis','condition/field_check'].includes(n.type))) {
          assert.equal(hash(nodes.find(n => n.id === node.id)),hash(node));
          report.graphChecks[node.type === 'condition/ai_analysis' ? 'unchangedAiNodes' : 'unchangedComparators']++;
        }
        report.graphChecks.graphs++;
        continue;
      }
      const transformed = notice.buildSingleNoticeFlow(entry.source);
      assert.equal(hash(transformed.nodes), hash(entry.body.nodes), 'candidate_graph_changed');
      assert.equal(hash({ entry_node_id: entry.source.entry_node_id, trigger_type: entry.source.trigger_type,
        nodes: entry.source.nodes }), entry.source_hash, 'source_graph_changed');
      const legs = notice.policyFor(transformed).retired_nodes;
      const changedWaits = new Set();
      for (const leg of Object.values(legs)) {
        const early = entry.source.nodes.find(node => node.outputs?.on_timeout
          && legs[node.outputs.on_timeout] === leg);
        if (early) changedWaits.add(early.id);
        changedWaits.add(leg.wait_node_id);
      }
      for (const node of entry.source.nodes) {
        const after = transformed.nodes.find(candidate => candidate.id === node.id);
        if (legs[node.id]) { assert.equal(after, undefined); continue; }
        assert(after, 'non_followup_node_removed');
        if (node.type === 'condition/ai_analysis') report.graphChecks.unchangedAiNodes++;
        if (node.type === 'condition/field_check') report.graphChecks.unchangedComparators++;
        if (!changedWaits.has(node.id)) assert.equal(hash(after), hash(node), 'unrelated_node_modified');
      }
      assert.equal(transformed.nodes.length, entry.source.nodes.length - Object.keys(legs).length);
      for (const [retiredId, leg] of Object.entries(legs)) {
        const early = transformed.nodes.find(node => node.outputs?.on_timeout === leg.wait_node_id && node.id !== leg.wait_node_id);
        const late = transformed.nodes.find(node => node.id === leg.wait_node_id);
        assert(early?.type === 'delay/wait_response', 'silence_does_not_reach_late_wait');
        assert.equal(early.config.listens_to_node_id, leg.first_send_node_id);
        assert.equal(late.config.listens_to_node_id, leg.first_send_node_id);
        assert.equal(late.config.timeout_duration, leg.total_wait_minutes);
        assert(!late.outputs.on_timeout, 'silence_must_not_apply_actions');
        assert(!transformed.nodes.some(node => Object.values(node.outputs || {}).includes(retiredId)));
        const oldLate = entry.source.nodes.find(node => node.id === late.id);
        assert.equal(late.outputs.on_response, oldLate.outputs.on_response, 'late_response_branch_changed');
        const anchor = '2030-01-01T08:00:00.000Z';
        const waitResult = await engine._processNode(late, { outputs: { [leg.first_send_node_id]: { at: anchor, effective_send_at: anchor } } }, { simulation: true });
        assert.equal(waitResult.wait_until.getTime(), Date.parse(anchor) + leg.total_wait_minutes * 60000);
        assert.equal(waitResult.waiting_meta.listens_to_node_id, leg.first_send_node_id);
        report.graphChecks.silenceBranches++;
      }
      report.graphChecks.retiredSends += Object.keys(legs).length;
      report.graphChecks.graphs++;
    }
    for (const [index, entry] of sample.entries()) {
      current = entry; cached = undefined; inferenceRequest = undefined;
      const rewritten = messageCopy && !args.includes('--original-copy')
        ? require('./historical-appointment-copy-context').rewrite(entry.item, plan) : { item: entry.item, changed: 0 };
      current = { ...entry, item: rewritten.item };
      const { item, expected } = current, before = hash(item.context);
      const modified = messageCopy ? entry.entry.body : notice.buildSingleNoticeFlow(entry.entry.source);
      const traceStart = providerTrace.length;
      const result = { ordinal: index + 1, id: item.id, clinicId: item.clinic_id,
        sourceTemplateId: entry.entry.source.id, preset: item.preset, kind: expected.kind,
        updatedOutgoingMessages: rewritten.changed,
        responseAnchor: messageCopy ? 'current_copy_with_historical_response' : notice.policyFor(modified).retired_nodes[item.context.last_response_context?.listens_to_node_id]
          ? 'historical_followup_already_sent' : 'historical_original_message',
        graphHash: hash(modified.nodes) };
      try {
        if (item.currentPathError) fail(item.currentPathError);
        const contexts = [structuredClone(item.context), structuredClone(item.context)];
        contexts.forEach(context => { context.outputs ||= {}; });
        phase = 'modified';
        const after = await engine._processNode(entry.node, contexts[0], { simulation: false });
        phase = 'original';
        const original = await engine._processNode(entry.node, contexts[1], { simulation: false });
        assert.equal(hash(after), hash(original), 'analysis_result_changed_by_flow_reduction');
        const afterRoute = await route(modified.nodes, entry.node, contexts[0], after);
        const beforeRoute = await route(entry.entry.source.nodes, entry.node, contexts[1], original);
        if (messageCopy) {
          const topology = route => ({ visits: route.visits, actions: route.actions.map(action => ({ id: action.id, type: action.type,
            ...(action.type === 'action/change_status' ? { config: action.config } : {}) })) });
          assert.equal(hash(topology(afterRoute)),hash(topology(beforeRoute)),'copy_update_changed_decisions');
        } else assert.equal(hash(afterRoute), hash(beforeRoute), 'response_actions_changed_by_flow_reduction');
        assert.equal(hash(contexts[0].appointment), hash(item.context.appointment), 'appointment_mutated_in_simulation');
        const states = afterRoute.actions.filter(action => action.type === 'action/change_status')
          .map(action => action.config?.new_status).filter(Boolean);
        const review = (after.output.necesita_respuesta ?? after.output.requiere_respuesta) === true
          || afterRoute.actions.some(action => action.type === 'action/send_system_notification');
        Object.assign(result, { inputHash: hash(inferenceRequest), states, review, route: afterRoute.visits,
          providerCalls: providerTrace.length - traceStart, providerTrace: providerTrace.slice(traceStart),
          output: after.output, inference:{raw:structuredClone(cached)},sameAnalysisRequest: true, sameResponseActions: true });
        assert(states.every(state => expected.allowedStates.includes(state)), 'human_expected_state_violated');
        assert(!expected.requiredStates?.some(state => !states.includes(state)), 'human_required_confirmation_missing');
        assert(!expected.requiresDecisionOrReview || states.length || review, 'decision_lost_without_review');
        assert(!expected.needsResponse || review, 'patient_question_lost');
        const trace = providerTrace.slice(traceStart);
        if (fresh) {
          assert.equal(after.output._ai_provider, 'bedrock', 'real_provider_not_verified');
          assert(!after.output._ai_simulated && !after.output._ai_fallback_used, 'simulated_or_fallback_output');
          assert.equal(trace.length, 1, 'one_provider_call_required');
          assert.equal(trace[0].stopReason, 'tool_use', 'provider_output_incomplete');
          assert(trace[0].usage?.input_tokens > 0 && trace[0].usage.output_tokens > 0);
          assert(trace[0].usage.output_tokens < trace[0].maxTokens, 'provider_output_truncated');
        }
        Object.assign(result, { passed: true, inputHash: hash(inferenceRequest), states, review,
          route: afterRoute.visits, providerCalls: trace.length, providerTrace: trace,
          output: after.output, sameAnalysisRequest: true, sameResponseActions: true });
      } catch (error) {
        const code = error.name === 'AssertionError' ? String(error.message).split('\n')[0] : error.code || error.message;
        const expectedHold = expected.expectedError === code && providerTrace.length === traceStart;
        Object.assign(result, { passed: expectedHold, expectedSafetyHold: expectedHold, error: code,
          providerCalls: providerTrace.length - traceStart });
        if (!expectedHold) failures.push({ ordinal: index + 1, id: item.id, code });
      }
      assert.equal(hash(item.context), before, 'historical_source_context_mutated');
      results.push(result);
      if ((index + 1) % 10 === 0 || index + 1 === sample.length) {
        console.log(JSON.stringify({ progress: index + 1, total: sample.length, failures: failures.length, providerCalls: providerTrace.length }));
      }
      if (failures.some(failure => /broker_|provider_disabled|scope_denied|ai_function_manually_paused|unapproved_network/.test(failure.code))) break;
    }
    Object.assign(report, { complete: results.length === sample.length, providerCalls: providerTrace.length,
      telemetryEventsInMemory: telemetry.length, securityGuardReadOnlyChecks: guardReads,
      sends: deliveries, clinicalWrites, forbiddenNetwork,
      distinctConversations: new Set(sample.map(entry => entry.item.context.conversation.id)).size,
      clinics: new Set(sample.map(entry => entry.item.clinic_id)).size,
      historicalFollowupReplies: results.filter(result => result.responseAnchor === 'historical_followup_already_sent').length });
    assert.equal(deliveries, 0); assert.equal(clinicalWrites, 0); assert.equal(forbiddenNetwork, 0);
    fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ report: output, complete: report.complete, cases: results.length,
      passed: results.filter(result => result.passed).length, failures: failures.length,
      graphs: report.graphChecks.graphs, retiredSends: report.graphChecks.retiredSends,
      providerCalls: report.providerCalls, sends: deliveries, clinicalWrites, forbiddenNetwork }));
    if (!report.complete || failures.length) process.exitCode = 1;
  } finally {
    restoreClock();
    net.Socket.prototype.connect = connect;
    if (connection) { await connection.rollback(); await connection.end(); }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.code || error.message?.split('\n')[0] || 'historical_drill_failed' }));
  process.exitCode = 1;
});
