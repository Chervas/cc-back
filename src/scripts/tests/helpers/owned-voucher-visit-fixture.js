'use strict';

// Composes existing native SQL/flow/job/fake-broker fixture, not an app bootstrap.
// Only session ACL and ancillary documentation/realtime boundaries are spies.
const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { createOwnedVisitMutationFixture } = require('./owned-visit-mutation-fixture');
function load(filename, overrides) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise, Object, Buffer,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename }); return module.exports;
}
async function createOwnedVoucherVisitFixture(context) {
  const f = await createOwnedVisitMutationFixture(context), { db, sql } = f;
  try {
    for (const file of ['patientvoucher', 'patientvouchermovement']) {
      const model = require('../../../../models/' + file)(sql, db.Sequelize.DataTypes); db[model.name] = model; await model.sync();
    }
    const single = f.physical.profile(4, [f.physical.phase('care', { start_offset_minutes: 0, duration_minutes: null })]);
    await db.Tratamiento.update({ clinical_config: { catalog_status: 'active', booking_profile: single },
      appointment_automation_template_key: 'owned_visit_details' }, { where: { id_tratamiento: 1 } });
    const profileService = require('../../../services/treatmentBookingProfile.service');
    const availability = require('../../../services/appointmentBookingAvailability.service');
    const command = require('../../../services/appointmentBookingCommand.service');
    const replay = require('../../../lib/voucher-booking-replay');
    const state = { replayEnabled: true, crashBeforeEnqueue: false, hooks: [], serviceCalls: [], acl: [] };
    const service = load(require.resolve('../../../services/patientVoucherAppointments.service'), {
      '../../models': db,
      './treatmentBookingProfile.service': { ...profileService, bookingCapabilities: () => f.physical.capabilities,
        requireOperationalProfile: (treatment, options) => profileService.requireOperationalProfile(treatment, { ...options, capabilities: f.physical.capabilities }) },
      './appointmentBookingAvailability.service': { ...availability,
        loadBookingContext: input => availability.loadBookingContext({ ...input, equipmentEnabled: true }) },
      './appointmentBookingCommand.service': { mutateAppointmentBooking: input => command.mutateAppointmentBooking({ ...input, capabilities: f.physical.capabilities }) },
      './appointmentAutomationV2Runtime.service': { ...f.runtime, enqueueExecutionForCita: (...args) => {
        state.hooks.push('enqueue'); if (state.crashBeforeEnqueue) throw Error('OWNED_CRASH_AFTER_COMMIT_BEFORE_ENQUEUE');
        return f.runtime.enqueueExecutionForCita(...args);
      }, syncScheduledTriggersForCita: (...args) => { state.hooks.push('schedule'); return f.runtime.syncScheduledTriggersForCita(...args); } },
      '../lib/voucher-booking-replay': { ...replay, enabled: () => state.replayEnabled },
    });
    const controller = load(require.resolve('../../../controllers/patientEconomics.controller'), {
      '../../models': db, '../services/patientEconomics.service': { domainError: service.domainError },
      '../services/economicDocumentPdf.service': {}, '../services/patientProgramBooking.service': {},
      '../services/patientVoucherAppointments.service': Object.fromEntries(Object.entries(service).map(([name, fn]) => [name,
        (...args) => { state.serviceCalls.push(name); return fn(...args); }])),
      '../lib/access-policy': { getAccessibleClinicIdsForFeature: async input => {
        state.acl.push(input); return [1, 2].includes(input.actorId) ? input.clinicIds.filter(id => id === 100) : [];
      } },
      '../services/programBookingRealtime.service': { publishProgramBookings: async () => state.hooks.push('realtime') },
      '../services/consentimientos.service': { ensurePackageForAppointment: async () => state.hooks.push('documentation') },
    });
    const server = http.createServer(async (request, response) => {
      const match = /^\/vouchers\/([a-f0-9-]+)\/(appointment-plan|appointments)$/.exec(request.url);
      if (!match || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      let raw = ''; for await (const part of request) raw += part;
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) {
        if (request.headers['x-owned-drop'] === '1' && this.statusCode === 201) { response.destroy(); return this; }
        response.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); return this;
      } };
      try { await new Promise((resolve, reject) => {
        Promise.resolve(controller[match[2] === 'appointment-plan' ? 'previewVoucherAppointments' : 'createVoucherAppointments']({
          params: { voucherId: match[1] }, body: JSON.parse(raw || '{}'), userData: { userId: Number(request.headers['x-owned-actor'] || 1) } }, res, reject)).then(resolve, reject);
      }); }
      catch (error) { if (!response.destroyed && !response.headersSent) res.status(error.statusCode || 500).json({ code: error.code, message: error.message }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.registerOwnedLoopbackServer(server);
    const request = (voucher, action, body, options = {}) => new Promise((resolve, reject) => {
      const bytes = JSON.stringify(body), outgoing = http.request({ host: '127.0.0.1', port: server.address().port,
        path: `/vouchers/${voucher.public_id}/${action}`, method: 'POST', agent: false, headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes), 'X-Owned-Actor': String(options.actor || 1),
          ...(options.drop ? { 'X-Owned-Drop': '1' } : {}) } }, response => {
        let bytes = ''; response.setEncoding('utf8'); response.on('data', part => { bytes += part; });
        response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(bytes) }); } catch (error) { reject(error); } });
      }); outgoing.once('error', reject); outgoing.end(bytes);
    });
    const voucher = patch => db.PatientVoucher.create({ public_id: randomUUID(), clinic_id: 100, patient_id: 1, treatment_id: 1,
      name: 'Bono sintético', total_units: 5, available_units: 5, sold_amount: 123, status: 'active', created_by: 1,
      budget_line_key: 'frozen-line', source_reference: 'original-reference', ...patch });
    const payload = patch => ({ start_at: '2030-01-07T09:00:00Z', count: 1, interval_days: 7, duration_minutes: 45,
      doctor_id: 1, installation_id: 101, ...patch });
    const seal = (body, proposal) => ({ ...body, booking_request_key: proposal.booking_request_key, booking_request_sha256: proposal.booking_request_sha256 });
    const counts = async () => Object.fromEntries(await Promise.all(['CitaPaciente', 'AppointmentBookingOccupancy', 'AppointmentBookingResource',
      'AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitBirthRequest', 'AppointmentVisitCommunication', 'PatientOperationalEvent',
      'PatientVoucherMovement', 'FlowExecutionV2', 'Message', 'AppointmentVisitDispatch', 'JobRequest'].map(async name => [name, await db[name].count()])));
    return { ...f, get managed() { return require('../../../services/appointmentVisitManaged.service').current(); }, service, state,
      request, voucher, payload, seal, counts, close: async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await f.close(); } };
  } catch (error) { await f.close(); throw error; }
}
module.exports = { createOwnedVoucherVisitFixture };
