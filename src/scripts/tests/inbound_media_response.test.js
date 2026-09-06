'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
const root = process.env.CC_QA_RESUME_ROOT || path.resolve(__dirname, '../../..');
const db = require(root + '/models');
const resume = require(root + '/src/services/automationsV2Resume.service');
const jobs = require(root + '/src/services/jobRequests.service');
const states = require(root + '/src/services/conversationAutomationState.service');

async function testAdmission() {
  const originals = [];
  const patch = (target, key, value) => {
    const original = target[key];
    originals.push(() => { target[key] = original; });
    target[key] = value;
  };
  const savedAllowlist = process.env.AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES;
  let rows = [];
  let execution;
  const queued = [];
  const jobUpdates = [];
  patch(db.Message, 'findByPk', async id => rows.find(row => row.id === id));
  patch(db.FlowExecutionV2, 'findAll', async () => [execution]);
  patch(db.FlowExecutionV2, 'findByPk', async () => execution);
  patch(db.sequelize, 'query', async () => []);
  patch(db.sequelize, 'transaction', async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  patch(jobs, 'enqueueUniqueJobRequest', async options => {
    queued.push(options); return { job: { id: 999, ...options }, created: true };
  });
  patch(db.JobRequest, 'update', async (values, options) => {
    jobUpdates.push({ values, options });
    return [1];
  });
  patch(states, 'setState', async options => options);
  patch(states, 'emitState', () => {});
  const reset = (namespace = 'dev', buffer = true) => {
    queued.length = 0;
    execution = { id: 900000001, status: 'waiting', clinic_id: 900001, current_node_id: 'N5',
      context: { conversation: { id: 900002 } }, waiting_meta: { runtime_namespace: namespace },
      templateVersion: { nodes: [{ id: 'N5', type: 'delay/wait_response',
        config: { response_buffer_enabled: buffer, response_buffer_delay_seconds: 90 }, outputs: { on_response: 'N3' } }] },
      async update(patch) { Object.assign(this, patch); return this; } };
  };
  const send = (id, text = '') => resume.enqueueInboundResponseResume({
    clinicId: 900001, conversationId: 900002, messageText: text, inboundMessageId: id,
  });
  try {
    for (const kind of ['video', 'image', 'audio', 'document', 'gif', 'sticker']) {
      rows = [{ id: 71, content: '', metadata: { media: { kind, id: 'fixture', mime_type: 'application/octet-stream' } } }];
      process.env.AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES = 'dev';
      reset();
      const before = Date.now();
      assert.equal((await send(71)).matched, 1, `${kind} must wake the response wait`);
      assert.equal(queued.at(-1).payload.resume_mode, 'response');
      assert.deepEqual(execution.waiting_meta.pending_response_message_ids, [71]);
      assert(execution.wait_until.getTime() >= before + 89000 && execution.wait_until.getTime() <= Date.now() + 90000);
      await send(71);
      assert.deepEqual(execution.waiting_meta.pending_response_message_ids, [71], 'duplicates do not add batch entries');
      reset('dev', false);
      assert.equal((await send(71)).matched, 1, `${kind} works without buffering too`);
      if (kind !== 'sticker') {
        reset('staging');
        assert.equal((await send(71)).matched, 0, 'unupgraded runtime remains untouched');
        assert.equal(queued.length, 0);
        reset('dev');
        delete process.env.AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES;
        assert.equal((await send(71)).matched, 0, 'gateway rollout is explicitly opt-in');
      }
    }
    process.env.AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES = 'dev';
    reset();
    rows = [{ id: 71, content: '', metadata: { media: { kind: 'video', id: 'fixture' } } },
      { id: 72, content: 'Reaccion de WhatsApp', metadata: { reaction: { emoji: 'thumbs_up' } } }];
    await send(71);
    await send(72, rows[1].content);
    assert.deepEqual(execution.waiting_meta.pending_response_message_ids, [71, 72]);
    assert.equal(execution.waiting_meta.last_inbound_message_id, 72);
    reset();
    rows = [{ id: 73, content: '', metadata: {} }];
    assert.equal((await send(73)).matched, 0, 'a truly empty event must not resume a flow');

    reset();
    rows = [{ id: 74, content: 'Sí', metadata: {} }];
    db.sequelize.query = async sql => (
      String(sql).includes("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resume_mode'))")
        ? []
        : [{ id: 800, status: 'waiting', payload: { execution_id: execution.id, __runtime_namespace: 'dev' } }]
    );
    await send(74, rows[0].content);
    const cancelledTimeout = jobUpdates.find((entry) => (
      entry.values.status === 'cancelled' && entry.options.where.id === 800
    ));
    assert(cancelledTimeout, 'the original timeout job is cancelled when a buffered response takes ownership');
    assert.equal(cancelledTimeout.values.result_summary.replacement_job_id, 999);
    console.log('Inbound media admission: media types, buffering, duplicate, mixed batch and runtime isolation passed');
  } finally {
    originals.reverse().forEach(restore => restore());
    if (savedAllowlist === undefined) delete process.env.AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES;
    else process.env.AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES = savedAllowlist;
  }
}

async function testAnalysisInput() {
  const {
    formatInboundAnalysisItem,
    formatInboundResponseText,
  } = require('../../lib/automation-conversation-context');
  const executor = require('../../services/jobExecutor.service');
  const flow = require('../../services/flowEngineV2.service');
  const originalFindAll = db.Message.findAll;
  const rows = [{ id: 71, content: '', message_type: 'text', metadata: { media: { kind: 'video', id: 'fixture' } } },
    { id: 72, content: 'Confirmo', message_type: 'text', metadata: {} },
    { id: 73, content: 'Reaccion de WhatsApp', message_type: 'reaction', metadata: { reaction: { emoji: 'thumbs_up' } } },
    { id: 74, content: 'No', message_type: 'text', metadata: { revoked_at: '2026-09-05T09:01:00.000Z', revoke: { original_message_id: 'wamid.74' } } }];
  db.Message.findAll = async () => rows;
  try {
    const loaded = await executor._loadInboundResponseFromMessageIds({ inbound_message_ids: [71, 72, 73, 74] }, {}, 900002);
    assert.equal(loaded.responseText, 'Confirmo');
    assert.deepEqual(loaded.responseItems, [
      { message_id: 71, content_type: 'attachment', attachment_type: 'video', content_available: false, caption: null },
      { message_id: 72, content_type: 'text', text: 'Confirmo' },
      { message_id: 73, content_type: 'reaction', emoji: 'thumbs_up', target_message_id: null, target_message_preview: null },
    ]);
    assert.deepEqual(loaded.loadedMessageIds, [71, 72, 73, 74]);
    assert.deepEqual(loaded.analyzedMessageIds, [71, 72, 73]);
    assert.deepEqual(loaded.revokedMessageIds, [74]);
    assert.equal(loaded.inboundMessageId, 73);
    assert.equal(formatInboundResponseText(rows[2]), null, 'reaction metadata is not presented as patient text');
    assert.equal(formatInboundAnalysisItem({ message_type: 'reaction', metadata: { reaction: { emoji: '' } } }), null);
    assert.equal(formatInboundResponseText(rows[3]), null, 'revoked text is excluded from patient_message_batch');
    assert.equal(formatInboundAnalysisItem(rows[3]), null, 'revoked items are excluded from patient_message_batch');
    db.Message.findAll = async () => [rows[3]];
    const revokedOnly = await executor._loadInboundResponseFromMessageIds({ inbound_message_ids: [74] }, {}, 900002);
    assert.equal(revokedOnly.responseText, '');
    assert.deepEqual(revokedOnly.responseItems, []);
    assert.equal(revokedOnly.inboundMessageId, null, 'a revoked message cannot remain as the active response reference');
    assert.deepEqual(revokedOnly.analyzedMessageIds, []);
    assert.deepEqual(revokedOnly.revokedMessageIds, [74]);
    assert.equal(revokedOnly.responseMediaKind, null);
    assert.deepEqual(formatInboundAnalysisItem({ ...rows[2], metadata: { reaction: {
      emoji: 'thumbs_up', target_message_id: 'template_1', target_message_preview: 'Me confirmas?',
    } } }), {
      message_id: 73,
      content_type: 'reaction',
      emoji: 'thumbs_up',
      target_message_id: 'template_1',
      target_message_preview: 'Me confirmas?',
    });
    assert.deepEqual(formatInboundAnalysisItem({ ...rows[0], content: 'Mira esto' }), {
      message_id: 71,
      content_type: 'attachment',
      attachment_type: 'video',
      content_available: false,
      caption: 'Mira esto',
    });
    assert.deepEqual(flow.buildScopedClassifyIntentConversation({
      last_response_context: { response_message_id: 73, response_text: null },
      conversation_today: '[05/09/2026, 09:00] Paciente: Confirmo una cita anterior',
    }).patient_message_batch, { text: null, items: [] }, 'an empty current response must not borrow historical confirmations');
    assert.match(flow.buildAiSystemPrompt({ motivo: 'string' }), /no inventes su contenido/);
    assert.match(flow.buildAiSystemPrompt({ motivo: 'string' }), /reaction_emoji=null/);
    assert.match(flow.buildAiSystemPrompt({ motivo: 'string' }), /Los ejemplos de las instrucciones nunca forman parte/);
    console.log('Inbound media analysis input: structured attachments, captions, trailing reaction and batch isolation passed');
  } finally { db.Message.findAll = originalFindAll; }
}

testAdmission().then(async () => {
  if (!process.env.CC_QA_RESUME_ROOT) await testAnalysisInput();
}).then(async () => { await db.sequelize.close(); process.exit(0); })
  .catch(async error => { console.error(error); await db.sequelize.close(); process.exit(1); });
