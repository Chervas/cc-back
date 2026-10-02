'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// These are pre-labelled QA inputs, never a production intent classifier.
const SCENARIOS = [
  { key: 'booking_disputed', text: 'Nunca reserve una cita con vosotros. Comprobad de donde ha salido.',
    states: [], review: true },
  { key: 'conditional_confirmation', text: 'Si consigo salir antes del trabajo podre ir, pero no os lo puedo confirmar todavia.',
    states: [], review: true },
  { key: 'confirmation_and_name_correction', text: 'Confirmo que asistire a mi cita. Pero mi nombre esta mal, corregidlo por favor.',
    states: ['info_confirmada', 'recordatorio_confirmado'], review: true, decisionOrReview: true },
  { key: 'reschedule_not_cancel', text: 'Necesito cambiar la cita al jueves por la tarde porque a la hora actual no puedo ir. No la canceleis.',
    states: ['cambio_solicitado'], review: true, decisionOrReview: true },
  { key: 'directions_not_attendance', text: 'Conozco el camino y no necesito indicaciones.',
    states: [], review: false },
  { key: 'clear_attendance', text: 'Confirmo que asistire a la cita a la hora acordada.',
    states: ['info_confirmada', 'recordatorio_confirmado'], review: false, decisionOrReview: true },
  { key: 'reaction_without_text', text: '', reaction: '\u{1f44d}', states: [], review: false,
    acknowledgement: true },
  { key: 'thanks_with_pending_request', text: 'Gracias. Avisadme si queda un hueco por la tarde, por favor.',
    states: [], review: true },
];

function nativeReference(nodes, analysisId) {
  const precedingSend = (start) => {
    const pending = [start], seen = new Set();
    while (pending.length) {
      const id = pending.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const current = nodes.find((n) => n.id === id);
      if (current?.type === 'action/send_whatsapp') return current;
      for (const node of nodes) if (Object.values(node.outputs || {}).includes(id)) pending.push(node.id);
    }
    return null;
  };
  const pending = [analysisId], seen = new Set();
  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const node of nodes) {
      if (!Object.values(node.outputs || {}).includes(id)) continue;
      if (node.type === 'delay/wait_response') {
        return { wait: node, send: precedingSend(node.config?.listens_to_node_id) };
      }
      if (node.type.startsWith('condition/')) pending.push(node.id);
    }
  }
  return {};
}

function referenceText(send, templates, catalogs) {
  if (!send) return { text: 'Hola, dinos en que podemos ayudarte.', source: 'synthetic_unclaimed_inbound' };
  const cfg = send.config || {};
  if (cfg.message_mode === 'manual') return {
    text: cfg.manual_message_text || cfg.message_text,
    source: 'current_manual_node',
  };
  const template = templates.get(Number(cfg.template_id));
  const body = (parse(template?.components) || []).find((item) => String(item.type).toUpperCase() === 'BODY')?.text;
  const catalog = catalogs.get(Number(cfg.catalog_template_id || template?.catalog_template_id));
  return { text: body || catalog?.body_text,
    source: body ? 'current_bound_template_body' : 'current_bound_catalog_body' };
}

function configurationSignature(row, node, reference) {
  const graph = row.nodes.filter((n) => !n.type.startsWith('trigger/')
    && !['action/send_whatsapp', 'action/send_email'].includes(n.type))
    .map((n) => ({ id: n.id, type: n.type, config: n.config, outputs: n.outputs }));
  return hash({ node: { id: node.id, config: node.config, outputs: node.outputs },
    graph, reference: reference.text });
}

function contextualConfirmationStates(row, node) {
  if (node.config.preset_key === 'confirm_appointment') {
    const booking = new Set(['Envío de datos de la cita tras agendar', 'Envío de datos de la cita tras reprogramar']);
    // The canonical booking graph asks for attendance on its today/tomorrow branches.
    if (booking.has(row.name) && node.id === 'N14') return [];
    return booking.has(row.name) && ['N18', 'N24', 'N28'].includes(node.id)
      ? ['recordatorio_confirmado'] : ['info_confirmada'];
  }
  const attendance = new Set(['Recordatorio y confirmacion', 'Recordatorio y confirmación día de antes',
    'Recordatorio y confirmación día de antes (sin direccion)', 'Cancelar cita sin confirmar la noche anterior']);
  const data = new Set(['Enviar datos de cita tras agendarla', 'Confirmar cambio solicitado por el paciente']);
  return attendance.has(row.name) ? ['recordatorio_confirmado'] : data.has(row.name) ? ['info_confirmada'] : [];
}

async function prepare({ output, expectations, inventory, historicalFixtures }) {
  for (const file of [output, expectations, inventory]) {
    if (!file || !path.resolve(file).startsWith('/home/ubuntu/secure-imports/') || fs.existsSync(file)) {
      throw Error('new_private_reports_required');
    }
  }
  let scenarios = SCENARIOS;
  if (historicalFixtures) {
    const fixtures = JSON.parse(fs.readFileSync(historicalFixtures));
    if (fixtures.reviewedBeforeInference !== true || fixtures.cases.length !== SCENARIOS.length) {
      throw Error('reviewed_historical_fixtures_required');
    }
    scenarios = SCENARIOS.map((base) => {
      const fixture = fixtures.cases.find((item) => item.key === base.key);
      if (!fixture?.sourceAnalysisId || typeof fixture.text !== 'string') throw Error('historical_fixture_missing');
      return { ...base, ...fixture };
    });
  }
  const root = '/home/ubuntu/wt/back-staging';
  const { env } = require(root + '/src/scripts/security-email-login-metadata').observedEnvironment('staging');
  const c = await require(root + '/node_modules/mysql2/promise').createConnection(
    require(root + '/src/scripts/security-database-metadata').configuration(env));
  try {
    await c.query('START TRANSACTION READ ONLY');
    const [raw] = await c.query('SELECT id,public_id,template_key,name,version,clinic_id,group_id,is_active,is_system,trigger_type,trigger_config,entry_node_id,nodes,published_at FROM AutomationFlowTemplatesV2');
    const [templateRows] = await c.query('SELECT id,catalog_template_id,components FROM WhatsappTemplates');
    const [catalogRows] = await c.query('SELECT id,body_text FROM WhatsappTemplateCatalog');
    const [clinicRows] = await c.query('SELECT id_clinica,nombre_clinica,grupoClinicaId FROM Clinicas');
    const templates = new Map(templateRows.map((row) => [row.id, row]));
    const catalogs = new Map(catalogRows.map((row) => [row.id, row]));
    const clinics = new Map(clinicRows.map((row) => [row.id_clinica, row]));
    const latest = new Map();
    for (const row of raw.filter((r) => r.published_at)) {
      const previous = latest.get(row.public_id);
      if (!previous || row.version > previous.version || row.version === previous.version && row.id > previous.id) {
        latest.set(row.public_id, { ...row, nodes: parse(row.nodes), trigger_config: parse(row.trigger_config) });
      }
    }
    const affected = [...latest.values()].filter((row) => row.nodes.some((node) =>
      node.type === 'condition/ai_analysis' && ['classify_intent', 'confirm_appointment'].includes(node.config?.preset_key)));
    const cases = [], labels = [], groups = new Map(), excluded = [];
    const at = new Date();
    let id = 1800000000;
    const append = (row, node, reference, native, scenario) => {
      const clinicId = row.clinic_id || 66;
      const clinic = clinics.get(clinicId);
      const conversationId = ++id, responseId = ++id, promptId = ++id;
      const context = { clinic_id: clinicId, clinic: { id_clinica: clinicId, nombre: clinic.nombre_clinica },
        clinica: { id_clinica: clinicId, nombre: clinic.nombre_clinica },
        appointment: { id_cita: ++id, clinica_id: clinicId, estado: 'sin_confirmar',
          fecha: '2026-10-05', hora: '12:30:00', fecha_hora: '2026-10-05T10:30:00Z' },
        conversation: { id: conversationId, clinic_id: clinicId, patient_id: null },
        trigger: { type: row.trigger_type, data: { clinic_id: clinicId, conversation_id: conversationId } },
        last_prompt: reference.text, last_response: scenario.text, outputs: {},
        last_response_context: { response_text: scenario.text, response_message_id: responseId,
          response_message_type: scenario.reaction ? 'reaction' : 'text',
          responded_at: at.toISOString(), listened_message_preview: reference.text,
          reaction_emoji: scenario.reaction || null,
          reaction_target_message_preview: scenario.reaction ? reference.text : null,
          response_items: scenario.reaction
            ? [{ message_id: responseId, content_type: 'reaction', emoji: scenario.reaction, target_message_preview: reference.text }]
            : [{ message_id: responseId, content_type: 'text', text: scenario.text }],
          response_lines: scenario.text ? [scenario.text] : [],
        },
      };
      const message = (messageId, direction, content, messageType, sentAt) => ({ id: messageId,
        conversation_id: conversationId, direction, content, message_type: messageType,
        metadata: {}, sent_at: sentAt, createdAt: sentAt });
      const messages = [message(promptId, 'outbound', reference.text, 'text', new Date(at.getTime() - 120000).toISOString()),
        message(responseId, 'inbound', scenario.text, scenario.reaction ? 'reaction' : 'text', at.toISOString())];
      if (scenario.reaction) messages[1].metadata.reaction = { emoji: scenario.reaction,
        target_message_id: promptId, target_message_preview: reference.text };
      cases.push({ id: ++id, execution_id: null, at: at.toISOString(), clinic_id: clinicId,
        clinic: clinic.nombre_clinica, patient: 'QA synthetic', automation: row.name,
        preset: node.config.preset_key, node, nodes: row.nodes, context, messages,
        original_output: null, canonicalSameDay: false,
        synthetic: { scenario: scenario.key, referenceSource: reference.source,
          waitNodeId: native.wait?.id, sendNodeId: native.send?.id, originalScope: row.clinic_id,
          globalSourceEvaluatedInAuthorizedQaClinic: row.clinic_id == null },
        historicalFixture: scenario.sourceAnalysisId ? { sourceAnalysisId: scenario.sourceAnalysisId,
          sourceMessageIds: scenario.sourceMessageIds, referenceChangedForCurrentNode: true,
          originalConversationReplayed: false } : null,
        currentPathEvidence: { source: 'latest_published_synthetic_case', publicId: row.public_id,
          templateId: row.id, version: row.version, isActive: !!row.is_active, graphHash: hash(row.nodes), nodeId: node.id },
      });
      const states = scenario.acknowledgement ? contextualConfirmationStates(row, node) : scenario.states;
      labels.push({ id, kind: scenario.key, allowedStates: states,
        needsResponse: scenario.review, requiresDecisionOrReview: scenario.acknowledgement
          ? states.length > 0 : !!scenario.decisionOrReview });
    };
    for (const row of affected) {
      if (row.clinic_id == null && /_+clinic_\d+$/.test(row.template_key)) {
        excluded.push({ templateId: row.id, publicId: row.public_id, reason: 'detached_former_clinic_scope' });
        continue;
      }
      if (row.clinic_id && !clinics.has(row.clinic_id)) throw Error('current_clinic_missing');
      for (const node of row.nodes.filter((n) => n.type === 'condition/ai_analysis'
        && ['classify_intent', 'confirm_appointment'].includes(n.config?.preset_key))) {
        const native = nativeReference(row.nodes, node.id);
        const reference = referenceText(native.send, templates, catalogs);
        if (!reference.text) throw Error('current_template_reference_missing:' + row.id + ':' + node.id);
        const signature = configurationSignature(row, node, reference);
        if (!groups.has(signature)) groups.set(signature, { row, node, native, reference, scenarios: new Set() });
        const group = groups.get(signature);
        const scenario = scenarios[cases.length % scenarios.length];
        append(row, node, reference, native, scenario);
        group.scenarios.add(scenario.key);
      }
    }
    for (const group of groups.values()) for (const scenario of scenarios) {
      if (!group.scenarios.has(scenario.key)) append(group.row, group.node, group.reference, group.native, scenario);
    }
    const data = { cutoff: at.toISOString(), clinicalWrites: false, sends: false, sourceLogs: cases.length,
      skipped: [], coverage: { distinctConfigurations: groups.size, excluded,
        historicalFixtures: !!historicalFixtures,
        limitation: historicalFixtures
          ? 'Historical reply fixtures transplanted to current node references in virtual conversations; not original clinic conversations or provider delivery tests.'
          : 'Synthetic replies against current published nodes; not historical patient conversations or provider delivery tests.' }, cases };
    const bytes = JSON.stringify(data);
    fs.writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(expectations, JSON.stringify({ reviewedBeforeInference: true,
      casesSha256: crypto.createHash('sha256').update(bytes).digest('hex'), expectations: labels }),
    { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(inventory, JSON.stringify({ at, rows: raw.map((row) => ({ id: row.id,
      publicId: row.public_id, key: row.template_key, clinicId: row.clinic_id, version: row.version,
      active: !!row.is_active, nodesHash: hash(parse(row.nodes)), triggerHash: hash(parse(row.trigger_config)) })),
      affected: affected.map((row) => ({ id: row.id, publicId: row.public_id, name: row.name,
        clinicId: row.clinic_id, active: !!row.is_active, graphHash: hash(row.nodes),
        analyses: row.nodes.filter((n) => ['classify_intent', 'confirm_appointment'].includes(n.config?.preset_key))
          .map((n) => ({ id: n.id, recipe: n.config.preset_key })) })), excluded }), { mode: 0o600, flag: 'wx' });
    return { cases: cases.length, affectedFlows: affected.length, configurations: groups.size,
      nativeNodes: new Set(cases.map((item) => item.currentPathEvidence.templateId + ':' + item.node.id)).size,
      clinics: new Set(cases.map((item) => item.clinic_id)).size, excluded: excluded.length };
  } finally { await c.rollback(); await c.end(); }
}

module.exports = { SCENARIOS, nativeReference, prepare, configurationSignature, contextualConfirmationStates };
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (key) => args[args.indexOf(key) + 1];
  prepare({ output: arg('--cases'), expectations: arg('--expectations'), inventory: arg('--inventory'),
    historicalFixtures: args.includes('--historical-fixtures') ? arg('--historical-fixtures') : null })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
}
