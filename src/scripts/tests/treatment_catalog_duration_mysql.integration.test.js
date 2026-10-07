'use strict';

// Opt-in: freshly owned MySQL, Unix socket only. Actual catalogue router,
// controllers, model factory, resource validation and booking command; employee
// authentication and feature grants are explicitly synthetic at the boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');

test('operative duration-template authoring: real owned catalogue HTTP/model/SQL, scope gates and booking snapshot',
  { skip: process.env.TREATMENT_CATALOG_DURATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models, registerOwnedLoopbackServer, nativeCatalogModel: true });
      const environment = { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true',
        BOOKING_PHASE_OFFSETS_ENABLED: 'true', BOOKING_EQUIPMENT_ENABLED: 'true' };
      const acl = [];
      const access = require('../../lib/treatment-catalog-access').createTreatmentCatalogAccess({ db: models,
        isAdmin: () => false, canAccess: async input => { acl.push(input); return input.actorId === 1 && input.clinicId === 100; } });
      const controllerPath = require.resolve('../../controllers/tratamientos.controller');
      const actualRequire = createRequire(controllerPath), exported = {};
      const resources = actualRequire('../lib/treatment-catalog-resources');
      vm.runInNewContext(fs.readFileSync(controllerPath, 'utf8'), { exports: exported, console,
        require: name => name === '../../models' ? models : name === '../lib/treatment-catalog-resources'
          ? { ...resources, validateCatalogResources: (value, db, options) => resources.validateCatalogResources(value, db, { ...options, environment }) }
          : actualRequire(name) }, { filename: controllerPath });
      const routePath = require.resolve('../../routes/tratamientos.routes'), routeRequire = createRequire(routePath);
      const routeModule = { exports: {} };
      vm.runInNewContext(fs.readFileSync(routePath, 'utf8'), { module: routeModule, console,
        require: name => name === '../controllers/tratamientos.controller' ? exported
          : name === './auth.middleware' ? (req, res, next) => {
            if (req.headers['x-owned-fixture-actor'] !== '1') return res.status(401).json({ code: 'fixture_auth_required' });
            req.userData = { userId: 1 }; next();
          } : name === '../lib/treatment-catalog-access' ? { createTreatmentCatalogAccess: () => access } : routeRequire(name),
      }, { filename: routePath });
      const express = routeRequire('express'), app = express();
      app.use(express.json()); app.use('/catalog', routeModule.exports);
      const server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      registerOwnedLoopbackServer(server);
      const request = (method, path, body, actor = true) => new Promise((resolve, reject) => {
        const bytes = body === undefined ? '' : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes), ...(actor ? { 'x-owned-fixture-actor': '1' } : {}) } }, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
          res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
        });
        req.once('error', reject); req.end(bytes);
      });
      const author = (booking_profile = f.profile(), patch = {}) => ({ nombre: 'Plantilla individual ficticia', disciplina: 'estetica',
        origen: 'clinica', clinica_id: 100, activo: true, precio_base: 100, duracion_min: null,
        clinical_config: { catalog_status: 'active', booking_profile }, ...patch });
      const digest = async id => JSON.stringify((await models.Tratamiento.findByPk(id)).toJSON());
      const count = () => models.Tratamiento.count();
      try {
        const baseline = await count();
        assert.equal((await request('POST', '/catalog', author(), false)).status, 401);
        assert.equal((await request('POST', '/catalog', author(f.profile(), { clinica_id: 200 }))).status, 403);
        assert.equal(await count(), baseline);
        report.checks.push('Actual catalogue router rejects absent synthetic actor and disallowed clinic before INSERT; native keys are clinic100, room101, doctor1, equipment401');

        const created = await request('POST', '/catalog', author());
        assert.equal(created.status, 201); const id = created.body.id_tratamiento;
        assert(Number.isInteger(id)); assert.equal(created.body.activo, true);
        assert.equal(created.body.duracion_min, null);
        assert.deepEqual(created.body.duration_requirements, { required: true, input: 'duration_minutes', phases: [{ key: 'care', label: 'Paso sintético' }] });
        assert.equal((await models.Tratamiento.findByPk(id)).clinical_config.booking_profile.phases[0].duration_minutes, null);
        assert.deepEqual(await f.counts(), { CitaPaciente: 0, AppointmentBookingOccupancy: 0, AppointmentBookingResource: 0 });
        assert.equal((await request('GET', `/catalog/${id}`)).body.duration_requirements.required, true);
        const saved = await request('PATCH', `/catalog/${id}`, { nombre: 'Plantilla renombrada ficticia', clinical_config: { catalog_status: 'active' } });
        assert.equal(saved.status, 200); assert.equal(saved.body.duration_requirements.required, true);
        assert.equal(saved.body.clinical_config.booking_profile.phases[0].duration_minutes, null);
        report.checks.push('Real create/PATCH/GET controller + native Tratamiento factory store active physical template with durationNULL and DTO requirements; no booking, occupancy or anchor is created while authoring');

        const before = await digest(id), beforeNegatives = await count();
        for (const [profile, code] of [
          [f.profile(1, [f.phase('bad_room', { installation_ids: [] })]), 'booking_profile_invalid'],
          [f.profile(1, [f.phase('foreign_room', { installation_ids: [201] })]), 'treatment_installation_scope'],
          [f.profile(1, [f.phase('foreign_doctor', { professionals: { mode: 'any', ids: [999], preferred_id: 999 } })]), 'treatment_professional_scope'],
        ]) {
          const rejected = await request('PATCH', `/catalog/${id}`, { clinical_config: { booking_profile: profile } });
          assert.equal(rejected.body.code, code); assert.equal(await digest(id), before);
        }
        await models.Instalacion.update({ activo: false }, { where: { id: 101 } });
        assert.equal((await request('POST', '/catalog', author())).body.code, 'treatment_installation_scope');
        await models.Instalacion.update({ activo: true }, { where: { id: 101 } });
        await models.DoctorClinica.update({ recibe_citas: false }, { where: { doctor_id: 1, clinica_id: 100 } });
        assert.equal((await request('POST', '/catalog', author())).body.code, 'treatment_professional_scope');
        await models.DoctorClinica.update({ recibe_citas: true }, { where: { doctor_id: 1, clinica_id: 100 } });
        assert.equal(await count(), beforeNegatives);
        report.checks.push('Real SQL scopes reject empty/foreign rooms, foreign clinician, inactive room and nonreceiving clinician; failed PATCH preserves complete native row including timestamp and NULL template');

        const machineProfile = f.profile(2, [f.phase('machine', { equipment_requirements: [{ equipment_ids: [401] }] })]);
        delete environment.BOOKING_EQUIPMENT_ENABLED;
        assert.equal((await request('POST', '/catalog', author(machineProfile))).body.code, 'booking_equipment_preparation_only');
        environment.BOOKING_EQUIPMENT_ENABLED = 'true';
        assert.equal((await request('POST', '/catalog', author(f.profile(2, [f.phase('missing_unit', { equipment_requirements: [{ equipment_ids: [999] }] })])))).body.code, 'booking_equipment_scope');
        await models.BookingEquipmentRoomPolicy.update({ mode: 'none', equipment_ids: [] }, { where: { installation_id: 101 } });
        assert.equal((await request('POST', '/catalog', author(machineProfile))).body.code, 'booking_equipment_room_incompatible');
        await models.BookingEquipmentRoomPolicy.update({ mode: 'selected', equipment_ids: [401] }, { where: { installation_id: 101 } });
        const machine = await request('POST', '/catalog', author(machineProfile));
        assert.equal(machine.status, 201); assert.equal(machine.body.duration_requirements.required, true);
        report.checks.push('Native machine membership/aliases/room-policy validation remains enforced: closed synthetic capability, missing unit and incompatible room reject; compatible physical unit401 saves with NULL minutes');

        const relativeProfile = f.profile(4, [f.phase('one'), f.phase('two', { start_offset_minutes: 15,
          installation_ids: [102], professionals: { mode: 'any', ids: [2], preferred_id: 2 } })]);
        delete environment.BOOKING_PHASE_OFFSETS_ENABLED;
        assert.equal((await request('POST', '/catalog', author(relativeProfile))).body.code, 'booking_profile_preparation_only');
        environment.BOOKING_PHASE_OFFSETS_ENABLED = 'true';
        const pendingProfile = f.profile(4, [f.phase('pending', { attention_requirements_pending: [{ key: 'check', label: 'Minutos sin confirmar' }] })]);
        assert.equal((await request('POST', '/catalog', author(pendingProfile))).body.code, 'pending_attention_requirements');
        const relative = await request('POST', '/catalog', author(relativeProfile));
        assert.equal(relative.status, 201); assert.equal(relative.body.duration_requirements.input, 'phase_durations');
        assert.deepEqual(relative.body.clinical_config.booking_profile.phases.map(row => row.duration_minutes), [null, null]);
        assert.deepEqual(relative.body.clinical_config.booking_profile.phases.map(row => row.start_offset_minutes), [0, 15]);
        report.checks.push('V4 synthetic publication capability and unquantified attention still reject; fully specified keys/offsets0/15 save as template without inventing either phase end');

        const beforeBooking = await f.counts();
        await assert.rejects(f.reserve({ appointmentValues: f.values({ tratamiento_id: id }), force: true }), { code: 'booking_duration_required', statusCode: 422 });
        assert.deepEqual(await f.counts(), beforeBooking);
        const appointment = await f.reserve({ appointmentValues: f.values({ tratamiento_id: id, fin: null }), durationSelection: { duration_minutes: 45 } });
        const stored = await f.read(appointment.id_cita);
        assert.equal(new Date(stored.fin).toISOString(), '2030-01-07T09:45:00.000Z');
        assert.equal(stored.import_metadata.booking.capacity_fully_verified, undefined, 'legacy v1 snapshot shape is preserved');
        assert.equal(stored.import_metadata.booking.profile.phases[0].duration_minutes, 45);
        assert.equal((await models.Tratamiento.findByPk(id)).clinical_config.booking_profile.phases[0].duration_minutes, null);
        assert((await f.occupancy(appointment.id_cita)).every(row => new Date(row.end_at).toISOString() === '2030-01-07T09:45:00.000Z'));
        report.checks.push('Authored native template reaches actual locked booking command: absent minutes/force yields422 without writes; explicit45 freezes end, legacy snapshot shape, profile and occupancy, catalogue staysNULL');

        const relativeBooked = await f.reserve({ appointmentValues: f.values({ tratamiento_id: relative.body.id_tratamiento,
          inicio: '2030-01-09T09:00:00Z', fin: null }), durationSelection: { phase_durations: { one: 40, two: 20 } } });
        const relativeStored = await f.read(relativeBooked.id_cita);
        assert.equal(relativeStored.import_metadata.booking.capacity_fully_verified, true);
        assert.equal(new Date(relativeStored.fin).toISOString(), '2030-01-09T09:40:00.000Z');
        assert.deepEqual(relativeStored.import_metadata.booking.profile.phases.map(row => row.start_offset_minutes), [0, 15]);
        assert.deepEqual((await models.Tratamiento.findByPk(relative.body.id_tratamiento)).clinical_config.booking_profile.phases.map(row => row.duration_minutes), [null, null]);
        report.checks.push('Authored native v4 template reaches actual solver/locks: phase choices40/20 produce span40 and capacity_fully_verified:true; offsets0/15 frozen and both catalogue minutes remainNULL');

        const machineBooked = await f.reserve({ appointmentValues: f.values({ tratamiento_id: machine.body.id_tratamiento,
          inicio: '2030-01-08T09:00:00Z', fin: null }), durationSelection: { duration_minutes: 40 } });
        assert((await f.occupancy(machineBooked.id_cita)).some(row => row.resource_key === 'equipment:401'
          && new Date(row.end_at).toISOString() === '2030-01-08T09:50:00.000Z'));
        await assert.rejects(f.reserve({ appointmentValues: f.values({ tratamiento_id: 12, doctor_id: 2, instalacion_id: 102,
          paciente_id: 2, inicio: '2030-01-08T09:00:00Z', fin: null }), durationSelection: { duration_minutes: 30 }, force: true }), { code: 'booking_unavailable' });
        report.checks.push('Authored native machine template reserves unit401 including turnaround10; another room/doctor/force cannot bypass physical capacity');
        assert(acl.some(input => input.featureKey === 'clinic.settings.edit' && input.clinicId === 100));
        assert(acl.some(input => input.clinicId === 200));
        report.boundary = 'Actual catalogue router/controllers/contract/native treatment and booking factories/SQL/solver; synthetic employee authentication and feature authorization oracle, no production roles or patient documents';
      } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await f.close();
      }
    });
  });
