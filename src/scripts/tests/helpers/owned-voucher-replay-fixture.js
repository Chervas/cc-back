'use strict';

// Native domain services/models on the launcher's freshly owned MySQL socket.
// Session ACL and post-commit provider/document hooks are explicit spies, NOT
// an assertion of full application authentication or real WhatsApp delivery.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRequire } = require('node:module');
const { createOwnedBookingDurationFixture } = require('./owned-booking-duration-fixture');

async function createOwnedVoucherReplayFixture(input) {
  const { sql, models: db, registerOwnedLoopbackServer } = input;
  const base = await createOwnedBookingDurationFixture({ sql, models: db });
  const D = db.Sequelize.DataTypes;
  for (const file of ['patientvoucher', 'patientvouchermovement', 'patientoperationalevent']) {
    const model = require('../../../../models/' + file)(sql, D); db[model.name] = model;
  }
  // Equivalent names from the actual migration, kept below MySQL's64-char
  // identifier limit for sync on this private blank schema only.
  db.PatientOperationalEvent.options.indexes.forEach((row, i) => {
    row.name = ['idx_patient_operational_events_patient_type_at', 'idx_patient_operational_events_clinic_type_at',
      'idx_patient_operational_events_actor_at'][i];
  });
  db.PatientOperationalEvent.associate(db);
  await sql.sync();
  const state = { enabled: true, acl: [], automation: [], realtime: [], documents: [], serviceCalls: [], failDocuments: false };
  const actualProfile = require('../../../services/treatmentBookingProfile.service');
  const actualAvailability = require('../../../services/appointmentBookingAvailability.service');
  const actualCommand = require('../../../services/appointmentBookingCommand.service');
  const replay = require('../../../lib/voucher-booking-replay');
  function load(filename, overrides) {
    const actualRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
      console, Date, Map, Set, Promise, Object, Buffer,
      require: name => Object.hasOwn(overrides, name) ? overrides[name] : actualRequire(name),
    }, { filename });
    return module.exports;
  }
  const service = load(require.resolve('../../../services/patientVoucherAppointments.service'), {
    '../../models': db,
    './treatmentBookingProfile.service': { ...actualProfile, bookingCapabilities: () => base.capabilities,
      requireOperationalProfile: (treatment, options) => actualProfile.requireOperationalProfile(treatment, { ...options, capabilities: base.capabilities }) },
    './appointmentBookingAvailability.service': { ...actualAvailability,
      loadBookingContext: options => actualAvailability.loadBookingContext({ ...options, equipmentEnabled: true }) },
    './appointmentBookingCommand.service': { mutateAppointmentBooking: options => actualCommand.mutateAppointmentBooking({ ...options, capabilities: base.capabilities }) },
    './appointmentAutomationV2Runtime.service': {
      enqueueExecutionForCita: async appointment => state.automation.push(['enqueue', Number(appointment.id_cita)]),
      syncScheduledTriggersForCita: async appointment => state.automation.push(['sync', Number(appointment.id_cita)]),
    },
    '../lib/voucher-booking-replay': { ...replay, enabled: () => state.enabled },
  });
  const controller = load(require.resolve('../../../controllers/patientEconomics.controller'), {
    '../../models': db,
    '../services/patientEconomics.service': { domainError: service.domainError },
    '../services/economicDocumentPdf.service': {}, '../services/patientProgramBooking.service': {},
    '../services/patientVoucherAppointments.service': Object.fromEntries(Object.entries(service).map(([name, fn]) => [name,
      (...args) => { state.serviceCalls.push({ name, actor: args[0]?.actorId }); return fn(...args); }])),
    '../lib/access-policy': { getAccessibleClinicIdsForFeature: async context => {
      state.acl.push(context); return [1, 2].includes(context.actorId) ? context.clinicIds.filter(id => id === 100) : [];
    } },
    '../services/programBookingRealtime.service': { publishProgramBookings: async context => state.realtime.push(context) },
    '../services/consentimientos.service': { ensurePackageForAppointment: async id => {
      state.documents.push(id); if (state.failDocuments) throw Error('OWNED_DOCUMENT_HOOK_UNAVAILABLE');
    } },
  });
  const server = http.createServer(async (request, response) => {
    const match = /^\/vouchers\/([a-z0-9-]+)\/(appointment-plan|appointments)$/.exec(request.url);
    if (!match || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) {
      // Destroy only AFTER the actual controller receives the committed result.
      if (request.headers['x-owned-drop-after-commit'] === '1' && this.statusCode === 201) { response.destroy(); return this; }
      response.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); return this;
    } };
    try {
      const body = JSON.parse(raw || '{}');
      const req = { body, params: { voucherId: match[1] }, userData: { userId: Number(request.headers['x-owned-actor'] || 1) } };
      const handler = match[2] === 'appointment-plan' ? controller.previewVoucherAppointments : controller.createVoucherAppointments;
      await new Promise((resolve, reject) => {
        const result = handler(req, res, reject);
        Promise.resolve(result).then(resolve, reject);
      });
    } catch (error) { if (!response.destroyed) res.status(error.statusCode || 500).json({ code: error.code || null, message: error.message, details: error.details || null }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerOwnedLoopbackServer(server);
  const port = server.address().port;
  const request = (voucher, action, body, options = {}) => new Promise((resolve, reject) => {
    const bytes = JSON.stringify(body);
    const outgoing = http.request({ host: '127.0.0.1', port, path: `/vouchers/${voucher.public_id}/${action}`, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes),
        'x-owned-actor': String(options.actor ?? 1), ...(options.drop ? { 'x-owned-drop-after-commit': '1' } : {}) } }, response => {
      let bytes = ''; response.setEncoding('utf8'); response.on('data', chunk => { bytes += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(bytes) }); } catch (error) { reject(error); } });
    });
    outgoing.once('error', reject); outgoing.end(bytes);
  });
  const voucher = (patch = {}) => db.PatientVoucher.create({ public_id: crypto.randomUUID(), clinic_id: 100, patient_id: 1,
    treatment_id: 1, name: 'Bono de prueba aislada', total_units: 5, available_units: 5, sold_amount: 123,
    status: 'active', created_by: 1, budget_line_key: 'frozen-original-line', source_reference: 'owned-original-purchase', ...patch });
  const counts = async () => ({ ...await base.counts(), events: await db.PatientOperationalEvent.count(), movements: await db.PatientVoucherMovement.count() });
  const payload = (patch = {}) => ({ start_at: '2030-01-07T09:00:00.000Z', count: 1, interval_days: 7,
    duration_minutes: 45, doctor_id: 1, installation_id: 101, ...patch });
  const sealed = (body, proposal) => ({ ...body, booking_request_key: proposal.booking_request_key, booking_request_sha256: proposal.booking_request_sha256 });
  return { base, db, service, state, request, voucher, payload, sealed, counts,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
module.exports = { createOwnedVoucherReplayFixture };
