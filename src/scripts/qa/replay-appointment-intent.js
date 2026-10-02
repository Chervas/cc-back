'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const argument = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const backend = argument('--backend', path.resolve(__dirname, '../../..'));
const sourceRoot = '/home/ubuntu/wt/back-staging';
const runtime = require(sourceRoot + '/src/scripts/security-email-login-metadata').observedEnvironment('staging');
Object.assign(process.env, runtime.env, { JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway' });
const parse = (value, fallback = {}) => typeof value === 'string' ? JSON.parse(value) : value || fallback;
const file = argument('--cases', '/home/ubuntu/secure-imports/automation-intent-replay-20261002.cases.json');

async function prepare() {
  const connection = await require(sourceRoot + '/node_modules/mysql2/promise').createConnection(
    require(sourceRoot + '/src/scripts/security-database-metadata').configuration(runtime.env));
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const cutoff = new Date();
    const logs = await query(`SELECT l.id,l.flow_execution_id,l.node_id,l.started_at,l.audit_snapshot,
      e.context,e.clinic_id,e.trigger_entity_id,t.id template_id,t.name,t.template_key,t.nodes,
      cl.nombre_clinica clinic_name FROM FlowExecutionLogsV2 l
      JOIN FlowExecutionsV2 e ON e.id=l.flow_execution_id
      JOIN AutomationFlowTemplatesV2 t ON t.id=e.template_version_id
      JOIN Clinicas cl ON cl.id_clinica=e.clinic_id
      WHERE l.node_type='condition/ai_analysis' AND l.status='success' AND l.started_at<?
      AND (l.started_at>='2026-09-25' OR e.trigger_entity_id IN (75251,75189,75036,74925))
      ORDER BY l.started_at,l.id`, [cutoff]);
    const pilot = (await query('SELECT * FROM AutomationFlowTemplatesV2 WHERE id=1472'))[0];
    const master = (await query('SELECT * FROM AutomationFlowTemplatesV2 WHERE id=1409'))[0];
    pilot.nodes = parse(pilot.nodes, []); master.nodes = parse(master.nodes, []);
    pilot.trigger_config = parse(pilot.trigger_config); master.trigger_config = parse(master.trigger_config);
    const canonical = require('../../lib/same-day-canonical-flow').buildCanonicalSameDayFlow(master, pilot);
    const cases = [], skipped = [], cache = new Map();
    for (const log of logs) {
      const nodes = parse(log.nodes, []);
      const node = nodes.find((candidate) => candidate.id === log.node_id);
      if (!node) { skipped.push({ log: log.id, reason: 'node_missing' }); continue; }
      const context = parse(log.context);
      let conversationId = Number(context.conversation?.id || context.conversation_id || context.trigger?.data?.conversation_id);
      if (!conversationId) { skipped.push({ log: log.id, reason: 'conversation_missing' }); continue; }
      if (!cache.has(conversationId)) {
        const conversation = (await query('SELECT * FROM Conversations WHERE id=? AND clinic_id=?', [conversationId, log.clinic_id]))[0];
        if (!conversation) { skipped.push({ log: log.id, reason: 'conversation_scope_mismatch' }); continue; }
        const messages = await query(`SELECT id,conversation_id,direction,content,message_type,metadata,sent_at,createdAt
          FROM Messages WHERE conversation_id=? AND COALESCE(sent_at,createdAt)<=?
          ORDER BY COALESCE(sent_at,createdAt),id`, [conversationId, cutoff]);
        cache.set(conversationId, { conversation, messages: messages.map((message) => ({ ...message, metadata: parse(message.metadata) })) });
      }
      const stored = cache.get(conversationId);
      const moment = new Date(log.started_at).getTime();
      const eligible = stored.messages.filter((message) => message.direction === 'inbound'
        && message.message_type !== 'event' && new Date(message.sent_at || message.createdAt).getTime() <= moment
        && !message.metadata.revoked_at);
      const last = eligible.at(-1);
      if (!last || moment - new Date(last.sent_at || last.createdAt).getTime() > 24 * 3600000) {
        skipped.push({ log: log.id, reason: 'response_unverifiable' }); continue;
      }
      const batch = [last];
      for (let index = eligible.length - 2; index >= 0; index--) {
        const previous = eligible[index];
        const gap = new Date(batch[0].sent_at || batch[0].createdAt) - new Date(previous.sent_at || previous.createdAt);
        if (gap > 90000) break;
        batch.unshift(previous);
      }
      const oldResponse = context.last_response_context || {};
      const priorOutbound = stored.messages.filter((message) => message.direction === 'outbound'
        && message.message_type !== 'event' && new Date(message.sent_at || message.createdAt) <= new Date(batch[0].sent_at || batch[0].createdAt));
      const exactReference = Number(oldResponse.response_message_id) === Number(last.id)
        && priorOutbound.some((message) => message.content === oldResponse.listened_message_preview)
        ? oldResponse.listened_message_preview : null;
      const outbound = priorOutbound.at(-1);
      const reference = exactReference || outbound?.content;
      if (!reference) { skipped.push({ log: log.id, reason: 'reference_unverifiable' }); continue; }
      const format = require('../../lib/automation-conversation-context');
      const response = { ...oldResponse, responded_at: last.sent_at || last.createdAt,
        response_message_id: last.id, response_message_type: last.message_type,
        response_text: batch.map(format.formatInboundResponseText).filter(Boolean).join('\n'),
        response_items: batch.map(format.formatInboundAnalysisItem).filter(Boolean),
        response_lines: batch.map(format.formatInboundResponseText).filter(Boolean),
        listened_message_preview: reference, reaction_emoji: last.metadata.reaction?.emoji || null,
        reaction_target_message_preview: last.metadata.reaction?.target_message_preview || null };
      const sameDay = /^recordatorio_mismo_d_a_sabes_llegar(?:__clinic_\d+)?$/.test(log.template_key);
      const replayNodes = sameDay ? canonical.nodes : nodes;
      const replayNode = replayNodes.find((candidate) => candidate.id === log.node_id);
      const label = stored.conversation.patient_id
        ? (await query('SELECT nombre,apellidos FROM Pacientes WHERE id_paciente=?', [stored.conversation.patient_id]))[0] : null;
      cases.push({ id: log.id, execution_id: log.flow_execution_id, at: log.started_at, clinic_id: log.clinic_id,
        clinic: log.clinic_name, patient: label ? [label.nombre,label.apellidos].filter(Boolean).join(' ') : null,
        automation: log.name, preset: replayNode.config.preset_key, original_preset: node.config.preset_key,
        original_output: parse(log.audit_snapshot).node_output_after,
        canonicalSameDay: sameDay, node: replayNode, nodes: replayNodes,
        context: { ...context, last_response_context: response, last_prompt: reference, last_response: response.response_text,
          conversation: stored.conversation, outputs: {} },
        messages: stored.messages.filter((message) => new Date(message.sent_at || message.createdAt).getTime() <= moment),
      });
    }
    const report = { cutoff, since: '2026-09-25', clinicalWrites: false, sends: false, sourceLogs: logs.length, skipped, cases };
    fs.writeFileSync(file, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ prepared: cases.length, logs: logs.length, skipped, cutoff, file,
      presets: cases.reduce((counts, item) => { counts[item.preset] = (counts[item.preset] || 0) + 1; return counts; }, {}) }));
  } finally { await connection.rollback(); await connection.end(); }
}

async function reconstructClinicalContext() {
  const data = JSON.parse(fs.readFileSync(file));
  const connection = await require(sourceRoot + '/node_modules/mysql2/promise').createConnection(
    require(sourceRoot + '/src/scripts/security-database-metadata').configuration(runtime.env));
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const executions = [...new Set(data.cases.map((item) => item.execution_id))];
    const [logs] = await connection.query(`SELECT id,flow_execution_id,node_type,started_at,audit_snapshot
      FROM FlowExecutionLogsV2 WHERE status='success'
      AND node_type IN ('condition/ai_analysis','action/change_status')
      AND flow_execution_id IN (${executions.map(() => '?').join(',')}) ORDER BY id`, executions);
    let reconstructed = 0, changed = 0;
    for (const item of data.cases) {
      const appointment = item.context.appointment;
      if (!appointment) continue;
      const appointmentId = Number(appointment.id_cita || appointment.id);
      const timeline = logs.filter((log) => Number(log.flow_execution_id) === item.execution_id);
      const nextAnalysis = timeline.find((log) => log.id > item.id && log.node_type === 'condition/ai_analysis');
      const nextTransition = timeline.find((log) => log.id > item.id && log.node_type === 'action/change_status'
        && (!nextAnalysis || log.id < nextAnalysis.id)
        && Number(parse(log.audit_snapshot).node_output_after?.target_id) === appointmentId);
      const output = nextTransition && parse(nextTransition.audit_snapshot).node_output_after;
      // A transition's previous_status is evidence before that side effect;
      // the execution's persisted final appointment is not an input snapshot.
      if (typeof output?.previous_status === 'string') {
        if (appointment.estado !== output.previous_status) changed++;
        appointment.estado = output.previous_status;
        if (Object.hasOwn(appointment, 'status')) appointment.status = output.previous_status;
        item.clinicalContextEvidence = {source:'following_transition_previous_status',
          transitionLogId:nextTransition.id, transitionAt:nextTransition.started_at,
          originalAiInputSnapshotAvailable:false};
        reconstructed++;
      } else {
        item.clinicalContextEvidence = {source:'persisted_context_not_historically_verified',
          originalAiInputSnapshotAvailable:false};
      }
    }
    data.clinicalContextReconstruction = {reconstructed,changed,
      limitation:'Only status before a following transition is evidenced; original complete AI inputs were not retained.'};
    fs.writeFileSync(argument('--report'), JSON.stringify(data), {mode:0o600,flag:'wx'});
    console.log(JSON.stringify({cases:data.cases.length,reconstructed,changed}));
  } finally {await connection.rollback();await connection.end();}
}

async function replay() {
  if (!args.includes('--real-ai')) throw new Error('replay_requires_explicit_real_ai_flag');
  const data = JSON.parse(fs.readFileSync(file));
  const output = argument('--report', file.replace('.cases.json', '.replay.json'));
  if (fs.existsSync(output)) throw Error('replay_report_already_exists');
  const candidate = Object.fromEntries([
    'src/services/flowEngineV2.service.js', 'src/lib/automation-intent-contract.js',
    'src/lib/automation-conversation-context.js', 'src/lib/same-day-canonical-flow.js',
  ].map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(backend, name))).digest('hex')]));
  const db = require(backend + '/models');
  for (const [name, model] of Object.entries(db)) {
    if (name === 'AiUsageDaily' || !model.rawAttributes) continue;
    for (const hook of ['beforeCreate','beforeUpdate','beforeDestroy','beforeBulkCreate','beforeBulkUpdate','beforeBulkDestroy']) {
      model.addHook(hook, () => { throw Error('REPLAY_CLINICAL_WRITE_FORBIDDEN'); });
    }
  }
  let activeCase;
  db.Conversation.findByPk = async () => activeCase.context.conversation;
  db.Conversation.findOne = async () => activeCase.context.conversation;
  db.Message.findAll = async ({ where = {} } = {}) => {
    if (where.id) return activeCase.messages.filter((message) => activeCase.context.last_response_context.response_items.some((item) => item.message_id === message.id));
    return activeCase.messages.filter((message) => !['event', 'reaction'].includes(message.message_type));
  };
  db.CitaPaciente.findByPk = async () => activeCase.context.appointment || null;
  const restoreClock = require('./historical-replay-context').installHistoricalConversationClock(
    require(backend + '/src/lib/automation-conversation-context'), () => activeCase);
  const engine = require(backend + '/src/services/flowEngineV2.service');
  const ai = require(backend + '/src/services/aiOrchestrator.service');
  const analyze = ai.analyzeStructured;
  let inference, inferenceCalls;
  ai.analyzeStructured = async (request) => {
    inferenceCalls++;
    const raw = await analyze(request);
    inference = { input: request.inputText, systemPrompt:request.systemPrompt, instruction:request.prompt, raw };
    return raw;
  };
  const queues = require(backend + '/src/services/queue.service').queues;
  for (const queue of Object.values(queues)) if (queue?.add) queue.add = async () => { throw Error('REPLAY_QUEUE_WRITE_FORBIDDEN'); };
  const results = [];
  try {
    for (const item of data.cases) {
      if (args.includes('--classify-only') && item.preset !== 'classify_intent') continue;
      if (args.includes('--ids') && !argument('--ids', '').split(',').map(Number).includes(item.id)) continue;
      activeCase = item;
      inference = null;
      inferenceCalls = 0;
      const startedAt = Date.now();
      const context = structuredClone(item.context);
      const before = JSON.stringify(context.appointment);
      let result;
      try {
        result = await engine._processNode(item.node, context, { simulation: false });
        context.outputs[item.node.id] = result.output;
        let next = result.next_node_id;
        const route = [], planned = [];
        for (let step = 0; next && step < 30; step++) {
          const node = item.nodes.find((candidate) => candidate.id === next);
          if (!node) throw Error('replay_route_node_missing');
          route.push(node.id);
          if (node.type.startsWith('action/')) {
            planned.push({ node: node.id, type: node.type, state: node.config?.new_status || null,
              message: node.config?.message_text || node.config?.manual_message_text || null });
            next = node.outputs?.on_success;
          } else if (node.type === 'condition/field_check') {
            const check = await engine._processNode(node, context, { simulation: true });
            context.outputs[node.id] = check.output;
            next = check.next_node_id;
          } else break;
        }
        if (JSON.stringify(context.appointment) !== before) throw Error('replay_appointment_mutated');
        results.push({ id: item.id, execution: item.execution_id, clinic: item.clinic, patient: item.patient,
          automation: item.automation, canonicalSameDay: item.canonicalSameDay, preset: item.preset,
          clinicalContextEvidence:item.clinicalContextEvidence || null,
          response: item.context.last_response_context.response_text, reference: item.context.last_prompt,
          previous: item.original_output, output: result.output, route, planned, inference,
          inferenceCalls, elapsedMs:Date.now()-startedAt,
          clinicalWrites: false, sends: false });
      } catch (error) {
        results.push({ id: item.id, preset: item.preset, error: error.message,
          inferenceCalls, elapsedMs:Date.now()-startedAt });
      }
      const last = results.at(-1);
      console.log(JSON.stringify({ id: last.id, preset: item.preset, intent: last.output?.intencion_principal,
        state: last.planned?.find((action) => action.state)?.state, error: last.error || null }));
      const checkpoint = argument('--checkpoint');
      if (checkpoint) {
        const temporary = checkpoint + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({complete:false,cutoff:data.cutoff,candidate,backend,results,
          clinicalWrites:false,sends:false}), {mode:0o600});
        fs.renameSync(temporary,checkpoint);
      }
    }
    const canonicalGraphHashes = [...new Set(data.cases.filter((item) => item.canonicalSameDay)
      .map((item) => crypto.createHash('sha256').update(JSON.stringify(item.nodes)).digest('hex')))];
    fs.writeFileSync(output, JSON.stringify({ complete:true, cutoff: data.cutoff, sourceLogs: data.sourceLogs, skipped: data.skipped, candidate,
      canonicalGraphHashes, backend, results, clinicalWrites: false, sends: false }), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ cases: results.length, errors: results.filter((result) => result.error).length, output }));
    if (results.some((result) => result.error)) process.exitCode = 1;
  } finally { restoreClock(); await db.sequelize.close(); }
}

(args.includes('--prepare') ? prepare() : args.includes('--reconstruct-clinical-context') ? reconstructClinicalContext() : replay()).catch((error) => {
  console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
}).finally(() => process.exit(process.exitCode || 0));
