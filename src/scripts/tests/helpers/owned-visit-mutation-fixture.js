'use strict';

// Extends the OWNED native command/flow/broker fixture with reviewed synthetic
// movement/cancellation graphs. No production graph/registry/flag is changed.
const http = require('node:http');
const S = require('sequelize');
const { createOwnedVisitConsumerFixture } = require('./owned-visit-consumer-fixture');
const contract = require('../../../lib/appointment-visit-runtime-contract');

async function createOwnedVisitMutationFixture(context) {
  const f = await createOwnedVisitConsumerFixture(context), { db, sql } = f;
  try {
  if (!db.PatientOperationalEvent) {
    db.PatientOperationalEvent = require('../../../../models/patientoperationalevent')(sql, S.DataTypes);
    // Native model index fields are retained; Sequelize's implicit name would
    // exceed MySQL's 64-byte identifier limit on this isolated sync fixture.
    db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = 'owned_visit_mutation_poe_' + i; });
    await db.PatientOperationalEvent.sync();
  }
  const base = await db.AutomationFlowTemplateV2.findByPk(42);
  const mutations = [];
  for (const [id, event] of [[43, 'appointment_rescheduled'], [44, 'appointment_cancelled']]) {
    const nodes = structuredClone(base.nodes); nodes[0].type = 'trigger/' + event;
    const whatsappId = id === 43 ? 502 : 503, name = 'owned_visit_' + event;
    const catalog = await db.WhatsappTemplateCatalog.create({ name, family_key: name, locale: 'es', category: 'UTILITY',
      body_text: 'Evento ficticio: ' + event, variables: [], components: [] });
    await db.WhatsappTemplate.create({ id: whatsappId, clinic_id: 100, waba_id: '90002', name, language: 'es_ES', category: 'UTILITY',
      status: 'APPROVED', catalog_template_id: catalog.id, components: [{ type: 'BODY', text: 'Evento ficticio: ' + event }] });
    nodes.find(node => node.id === 'S').config.template_id = whatsappId;
    const template = await db.AutomationFlowTemplateV2.create({ ...base.toJSON(), id, public_id: 'owned_visit_' + event,
      template_key: 'owned_visit_' + event, trigger_type: event, nodes });
    mutations.push({ clinic_id: 100, template_version_id: id, graph_sha256: contract.graphHash(template),
      stages: [{ key: event === 'appointment_rescheduled' ? 'details' : 'cancellation', node_ids: ['S'],
        ...(event === 'appointment_cancelled' ? { event_grace_ms: 3600000 } : {}) }], mutations: [] });
  }
  const birth = { clinic_id: 100, template_version_id: base.id, graph_sha256: contract.graphHash(base),
    stages: [{ key: 'details', node_ids: ['S'] }], mutations: [] };
  const managedModule = require('../../../services/appointmentVisitManaged.service');
  let enabled = true, clock = null, registered = [birth, ...mutations], managed;
  const now = () => clock ? new Date(clock) : new Date();
  const build = () => managedModule.createAppointmentVisitManagedService({ db, now, enabled: () => enabled,
    manifests: () => registered, namespace: () => 'visit_fixture', foundation: f.foundation,
    notifyJob: async id => f.publication.push(id), resolveBirthTemplate: row => f.runtime.resolveTemplateForCitaEvent(row, 'appointment_created') });
  managed = build();
  require.cache[require.resolve('../../../services/appointmentVisitManaged.service')].exports = { ...managedModule, current: () => managed };
  // Endpoint middleware is intentionally synthetic; handlers/command/resource
  // occupancy/transaction/automation pipeline are production implementations.
  if (!f.controller) throw Error('OWNED_MUTATION_CONTROLLER_EXPORT_REQUIRED');
  const server = http.createServer(async (request, response) => {
    const match = /^\/citas\/(\d+)(?:\/(move|state))?$/.exec(request.url);
    if (!match || !(request.method === 'PATCH' && match[2] || request.method === 'DELETE' && !match[2])) { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const result = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) {
      response.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); return this;
    } };
    try {
      await f.controller[request.method === 'DELETE' ? 'deleteCita' : match[2] === 'move' ? 'reagendarCita' : 'updateCitaEstado']({ params: { id: match[1] },
        userData: { userId: Number(request.headers['x-owned-actor-id']) || 1, name: 'Actor ficticio', role: 'admin' }, body: raw ? JSON.parse(raw) : {} }, result);
    } catch (error) { if (!response.headersSent) result.status(error.statusCode || error.status || 500).json({ code: error.code, message: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.registerOwnedLoopbackServer(server);
  const requestTo = (id, action, body, method, actorId = 1) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: `/citas/${id}${action ? '/' + action : ''}`, method, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Owned-Actor-Id': String(actorId) } }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', part => raw += part);
      response.on('end', () => { try { resolve({ statusCode: response.statusCode, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    request.once('error', reject); request.end(payload);
  });
  return { ...f, get managed() { return managed; }, patch: (id, action, body, actorId) => requestTo(id, action, body, 'PATCH', actorId),
    delete: id => requestTo(id, null, {}, 'DELETE'),
    configureAutomaticCancellation: async () => {
      const nodes = structuredClone(base.nodes);
      nodes.find(node => node.id === 'S').outputs.on_success = 'C';
      nodes.push({ id: 'C', type: 'action/change_status', config: { target_entity: 'appointment', new_status: 'cancelada' }, outputs: { on_success: 'E' } });
      await base.update({ nodes });
      registered = [{ ...birth, graph_sha256: contract.graphHash(base), mutations: [{ node_id: 'C', new_status: 'cancelada' }] }, ...mutations];
    },
    enable: value => { enabled = value; f.enable(value); }, clock: value => { clock = value; f.clock(value); },
    registry: value => { registered = value; }, manifests: () => registered, restartManaged: () => { managed = build(); },
    close: async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.close(); } };
  } catch (error) { await f.close(); throw error; }
}
module.exports = { createOwnedVisitMutationFixture };
