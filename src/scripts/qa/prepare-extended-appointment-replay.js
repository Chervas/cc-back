'use strict';

const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const argument = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const sourceRoot = argument('--source-backend', '/home/ubuntu/wt/back-staging');
const parse = (value, fallback = {}) => typeof value === 'string' ? JSON.parse(value) : value || fallback;
const moment = (message) => new Date(message.sent_at || message.createdAt).getTime();
const allFamilies = args.includes('--all-families');

async function prepare() {
  const file = argument('--report');
  const excludeFile = argument('--exclude-cases');
  if (!file || !excludeFile) throw Error('private_report_and_previous_cases_required');
  const previous = JSON.parse(fs.readFileSync(excludeFile));
  const excludedIds = new Set(previous.cases.map((item) => Number(item.id)));
  const excludedConversations = new Set(previous.cases.map((item) => Number(item.context.conversation.id)));
  const since = argument('--since', '2026-09-01');
  const until = argument('--until', '2026-09-25');
  const limit = Number(argument('--limit', '220'));
  if (!Number.isInteger(limit) || limit < 1) throw Error('invalid_sample_limit');
  const runtime = require(sourceRoot + '/src/scripts/security-email-login-metadata').observedEnvironment('staging');
  const c = await require(sourceRoot + '/node_modules/mysql2/promise').createConnection(
    require(sourceRoot + '/src/scripts/security-database-metadata').configuration(runtime.env));
  const query = async (sql, values = []) => (await c.query(sql, values))[0];
  const format = require('../../lib/automation-conversation-context');
  const { buildCanonicalSameDayFlow } = require('../../lib/same-day-canonical-flow');
  try {
    await c.query('START TRANSACTION READ ONLY');
    const cutoff = new Date();
    const logs = await query(`SELECT l.id,l.flow_execution_id,l.node_id,l.started_at,l.audit_snapshot,
      e.context,e.clinic_id,e.trigger_entity_id,t.name,t.public_id,t.template_key,t.nodes,
      cl.nombre_clinica clinic_name FROM FlowExecutionLogsV2 l
      JOIN FlowExecutionsV2 e ON e.id=l.flow_execution_id
      JOIN AutomationFlowTemplatesV2 t ON t.id=e.template_version_id
      JOIN Clinicas cl ON cl.id_clinica=e.clinic_id
      WHERE l.node_type='condition/ai_analysis' AND l.status='success'
      AND l.started_at>=? AND l.started_at<? ORDER BY l.started_at DESC,l.id DESC`, [since,until]);
    const pilot = (await query('SELECT * FROM AutomationFlowTemplatesV2 WHERE id=1472'))[0];
    const master = (await query(`SELECT t.* FROM AutomationFlowCatalog c
      JOIN AutomationFlowTemplatesV2 t ON t.public_id=c.template_key WHERE c.id=11
      AND t.is_active=1 AND t.published_at IS NOT NULL ORDER BY t.version DESC LIMIT 1`))[0];
    if (!master || !pilot) throw Error('canonical_source_missing');
    for (const template of [master,pilot]) {
      template.nodes = parse(template.nodes, []);
      template.trigger_config = parse(template.trigger_config);
    }
    const canonical = buildCanonicalSameDayFlow(master,pilot);
    const cache = new Map(), timelines = new Map(), candidates = [], rejected = [];
    for (const log of logs) {
      if (excludedIds.has(Number(log.id))) continue;
      const reject = (reason) => rejected.push({ id:log.id,reason });
      const nodes = parse(log.nodes, []), context = parse(log.context);
      const originalNode = nodes.find((node) => node.id === log.node_id);
      if (!(allFamilies ? ['classify_intent','confirm_appointment'] : ['classify_intent','confirm_appointment','custom'])
        .includes(originalNode?.config?.preset_key)) {
        reject('unsupported_preset'); continue;
      }
      const conversationId = Number(context.conversation?.id || context.conversation_id || context.trigger?.data?.conversation_id);
      if (!conversationId || excludedConversations.has(conversationId)) { reject('previous_or_missing_conversation'); continue; }
      if (!cache.has(conversationId)) {
        const conversation = (await query('SELECT * FROM Conversations WHERE id=? AND clinic_id=?', [conversationId,log.clinic_id]))[0];
        if (!conversation) { reject('scope_mismatch'); continue; }
        const messages = await query(`SELECT id,conversation_id,direction,content,message_type,metadata,sent_at,createdAt
          FROM Messages WHERE conversation_id=? AND COALESCE(sent_at,createdAt)<=?
          ORDER BY COALESCE(sent_at,createdAt),id`, [conversationId,cutoff]);
        cache.set(conversationId,{conversation,messages:messages.map((m) => ({...m,metadata:parse(m.metadata)}))});
      }
      const stored = cache.get(conversationId), at = new Date(log.started_at).getTime();
      const snapshot = context.conversation;
      const historicalConversation = snapshot && Number(snapshot.id)===conversationId
        && Number(snapshot.clinic_id)===Number(log.clinic_id) ? snapshot : stored.conversation;
      const oldResponse = context.last_response_context || {};
      const triggerIds = allFamilies && originalNode.id === nodes.find((n) => n.type === 'trigger/message_received')?.outputs?.on_success
        ? (context.trigger?.data?.inbound_message_ids || []).map(Number) : [];
      const response = stored.messages.find((m) => Number(m.id) === Number(
        oldResponse.response_message_id || triggerIds.at(-1)));
      if (!response || response.direction !== 'inbound' || response.message_type === 'event'
        || format.isRevokedMessage(response) || moment(response)>at || at-moment(response)>86400000) {
        reject('historical_response_not_anchored'); continue;
      }
      if (!timelines.has(log.flow_execution_id)) {
        timelines.set(log.flow_execution_id,await query(`SELECT id,node_id,node_type,started_at,audit_snapshot
          FROM FlowExecutionLogsV2 WHERE flow_execution_id=? AND status='success' ORDER BY id`, [log.flow_execution_id]));
      }
      const timeline = timelines.get(log.flow_execution_id);
      const wait = timeline.filter((l) => l.id<log.id && l.node_type==='delay/wait_response').at(-1);
      const waitAudit = wait && parse(wait.audit_snapshot);
      let listenedNode = waitAudit?.waiting_meta?.listens_to_node_id || waitAudit?.node_output_after?.listens_to_node_id;
      if (allFamilies && listenedNode && nodes.find((n) => n.id === listenedNode)?.type !== 'action/send_whatsapp') {
        listenedNode = require('./prepare-all-appointment-recipes').nativeReference(nodes,log.node_id).send?.id;
      }
      const send = timeline.filter((l) => l.id<(wait?.id || log.id) && l.node_type==='action/send_whatsapp'
        && l.node_id===listenedNode).at(-1);
      const sendOutput = send && parse(send.audit_snapshot).node_output_after;
      const referenceMessage = stored.messages.find((m) => Number(m.id)===Number(sendOutput?.message_id)
        && m.direction==='outbound' && moment(m)<=moment(response) && !format.isRevokedMessage(m));
      if (!referenceMessage?.content && !triggerIds.length) { reject('listened_message_not_anchored'); continue; }
      const previousAnalysis = timeline.filter((l) => l.id<log.id && l.node_type==='condition/ai_analysis').at(-1);
      if (previousAnalysis && moment(response)<=new Date(previousAnalysis.started_at).getTime()) {
        reject('response_not_new_for_analysis'); continue;
      }
      const batchIds = new Set(triggerIds.length ? triggerIds : (oldResponse.response_items || []).map((item) => Number(item.message_id)));
      batchIds.add(Number(response.id));
      const batch = stored.messages.filter((m) => batchIds.has(Number(m.id)) && m.direction==='inbound'
        && m.message_type!=='event' && !format.isRevokedMessage(m) && moment(m)<=moment(response)
        && moment(m)>=new Date(wait?.started_at || referenceMessage?.sent_at || referenceMessage?.createdAt
          || stored.messages.find((m) => Number(m.id) === triggerIds[0])?.sent_at || response.createdAt).getTime());
      if (!batch.some((m) => m.id===response.id)) { reject('response_before_wait'); continue; }
      if (batch.length!==batchIds.size) { reject('buffer_not_historically_verifiable'); continue; }
      const normalizedBatch = batch.map((m) => {
        if (m.message_type!=='reaction') return m;
        const reaction = m.metadata.reaction || {};
        const targetId = reaction.target_message_id || reaction.message_id;
        const target = stored.messages.find((target) => moment(target)<=moment(m)
          && [target.id,target.metadata?.whatsapp_message_id,target.metadata?.wamid,target.metadata?.message_id,
            target.metadata?.provider_message_id,target.metadata?.coexistence?.message_id].filter(Boolean)
            .some((id) => String(id)===String(targetId)));
        return {...m,metadata:{...m.metadata,reaction:{...reaction,target_message_preview:target?.content || reaction.target_message_preview}}};
      });
      const last = normalizedBatch.at(-1);
      const reference = referenceMessage?.content || null;
      const responseContext = {...oldResponse,responded_at:response.sent_at || response.createdAt,
        response_message_id:response.id,response_message_type:response.message_type,
        response_text:normalizedBatch.map(format.formatInboundResponseText).filter(Boolean).join('\n'),
        response_items:normalizedBatch.map(format.formatInboundAnalysisItem).filter(Boolean),
        response_lines:normalizedBatch.map(format.formatInboundResponseText).filter(Boolean),
        listened_message_preview:reference,reaction_emoji:last.metadata.reaction?.emoji || null,
        reaction_target_message_preview:last.metadata.reaction?.target_message_preview || null};
      const sameDay = /^recordatorio_mismo_d_a_sabes_llegar(?:__clinic_\d+)?$/.test(log.template_key);
      const replayNodes = sameDay && !allFamilies ? canonical.nodes : nodes;
      const node = replayNodes.find((n) => n.id===log.node_id);
      if (!node || node.config?.preset_key!==originalNode.config?.preset_key) { reject('canonical_node_not_equivalent'); continue; }
      const label = stored.conversation.patient_id ? (await query('SELECT nombre,apellidos FROM Pacientes WHERE id_paciente=?', [stored.conversation.patient_id]))[0] : null;
      candidates.push({id:log.id,execution_id:log.flow_execution_id,at:log.started_at,clinic_id:log.clinic_id,
        clinic:log.clinic_name,patient:label ? [label.nombre,label.apellidos].filter(Boolean).join(' ') : null,
        automation:log.name,preset:node.config.preset_key,original_preset:originalNode.config.preset_key,
        original_output:parse(log.audit_snapshot).node_output_after,canonicalSameDay:sameDay,node,nodes:replayNodes,
        responseEvidence:{source:triggerIds.length ? 'native_message_trigger_batch_ids' : 'persisted_response_id_and_native_wait_send_log',responseId:response.id,
          waitLogId:wait?.id,sendLogId:send?.id,referenceMessageId:referenceMessage?.id,originalAiInputSnapshotAvailable:false},
        originalPublicId:log.public_id,
        context:{...context,last_response_context:responseContext,last_prompt:reference,last_response:responseContext.response_text,
          conversation:historicalConversation,outputs:{}},
        messages:stored.messages.filter((m) => moment(m)<=at).map((m) => normalizedBatch.find((b) => b.id===m.id) || m)});
    }
    // One previously untested conversation per case; round-robin clinics avoids
    // letting the largest clinic consume the entire sample.
    const buckets = new Map(), used = new Set(), cases = [];
    for (const item of candidates) {
      const key = allFamilies ? item.originalPublicId + ':' + item.node.id : item.clinic_id;
      if (!buckets.has(key)) buckets.set(key,[]);
      buckets.get(key).push(item);
    }
    while (cases.length<limit) {
      let added = false;
      for (const bucket of buckets.values()) {
        let item;
        while (bucket.length && !item) {
          const next = bucket.shift();
          if (!used.has(next.context.conversation.id)) item=next;
        }
        if (!item) continue;
        used.add(item.context.conversation.id); cases.push(item); added=true;
        if (cases.length===limit) break;
      }
      if (!added) break;
    }
    const report = {cutoff,since,until,clinicalWrites:false,sends:false,sourceLogs:cases.length,skipped:[],
      selection:{availableLogs:logs.length,eligibleAnalyses:candidates.length,rejected,
        excludedPreviousIds:excludedIds.size,excludedPreviousConversations:excludedConversations.size,
        distinctConversations:used.size,requested:limit,canonicalSourceId:master.id},cases};
    fs.writeFileSync(path.resolve(file),JSON.stringify(report),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({prepared:cases.length,distinctConversations:used.size,availableLogs:logs.length,
      eligibleAnalyses:candidates.length,rejections:rejected.reduce((a,r)=>(a[r.reason]=(a[r.reason]||0)+1,a),{}),
      presets:cases.reduce((a,r)=>(a[r.preset]=(a[r.preset]||0)+1,a),{}),
      clinics:cases.reduce((a,r)=>(a[r.clinic]=(a[r.clinic]||0)+1,a),{}),file}));
  } finally {await c.rollback();await c.end();}
}
prepare().catch((error) => {console.error(JSON.stringify({error:error.message}));process.exitCode=1;});
