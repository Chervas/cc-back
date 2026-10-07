'use strict';

// Native SQL + owned loopback HTTP. Never starts the application, enrolls a
// runtime, contacts a provider or uses a real patient. The reused handler ACL
// boundary is synthetic: this is not a session/employee-permission benchmark.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 BOOKING_AVAILABILITY_PERFORMANCE_MYSQL_TEST=1 node --test THIS_FILE
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
const { loadBookingContext, solutionsForCalendar } = require('../../services/appointmentBookingAvailability.service');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { bookingPlanHash } = require('../../lib/booking-plan-receipt');
const { resolveLocalInstant } = require('../../lib/voucher-schedule-calendar');
const sourceHashes = Object.fromEntries(['../../lib/booking-profile-solver', '../../lib/booking-attention',
  '../../services/appointmentBookingAvailability.service', '../../controllers/disponibilidad.controller',
  './helpers/owned-booking-duration-fixture', './booking_availability_native_performance_mysql.integration.test']
  .map(name => [name, createHash('sha256').update(readFileSync(require.resolve(name))).digest('hex')]));
const DATE = '2030-01-07', NOW = new Date('2029-01-01T00:00:00Z');
const rooms = Array.from({ length: 12 }, (_, index) => 101 + index);
const doctors = Array.from({ length: 8 }, (_, index) => 1 + index);
const units = [401, 402, 403, 404];
const round = value => Math.round(value * 100) / 100;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const iso = value => new Date(value).toISOString();
const plus = (value, minutes) => new Date(Date.parse(value) + minutes * 60000).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const projection = slot => ({ start_at: slot.start_at, end_at: slot.end_at,
  booking_plan_sha256: slot.booking_plan_sha256, phases: slot.phases.map(phase => ({ key: phase.key,
    doctor_ids: phase.doctor_ids, installation_id: phase.installation_id,
    equipment: phase.equipment?.map(unit => ({ id: unit.id, turnaround_minutes: unit.turnaround_minutes })),
    staff_intervals: phase.staff_intervals })) });

test('native availability: measured dense SQL/HTTP, exact full-day solver parity, fresh resource invalidation and same-start preparation',
  { skip: process.env.BOOKING_AVAILABILITY_PERFORMANCE_MYSQL_TEST !== '1', timeout: 240000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const f = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
      const previousLogging = sql.options.logging, previousBenchmark = sql.options.benchmark;
      let measurement = null;
      sql.options.benchmark = true;
      sql.options.logging = (statement, elapsed) => {
        if (measurement) measurement.queries.push({ kind: /^Executed \([^)]*\):\s*([A-Z]+)/.exec(statement)?.[1] || 'SQL', elapsed_ms: Number(elapsed) || 0 });
      };
      const measured = async (label, work, repeats = 3) => {
        const samples = [];
        let value;
        for (let repeat = 0; repeat < repeats; repeat++) {
          measurement = { queries: [] };
          const cpu = process.cpuUsage(), started = performance.now();
          try { value = await work(); }
          finally {
            const spent = process.cpuUsage(cpu);
            samples.push({ wall_ms: round(performance.now() - started), cpu_ms: round((spent.user + spent.system) / 1000),
              sql_count: measurement.queries.length, sql_sum_ms: round(measurement.queries.reduce((sum, query) => sum + query.elapsed_ms, 0)),
              sql_max_ms: Math.max(0, ...measurement.queries.map(query => query.elapsed_ms)) });
            measurement = null;
          }
        }
        const entry = { label, samples, median_wall_ms: median(samples.map(sample => sample.wall_ms)),
          median_cpu_ms: median(samples.map(sample => sample.cpu_ms)), query_counts: [...new Set(samples.map(sample => sample.sql_count))] };
        report.performance.measurements.push(entry);
        console.log('OWNED_AVAILABILITY_MEASUREMENT ' + JSON.stringify(entry));
        return value;
      };
      const phase = (key, patch = {}) => f.phase(key, { duration_minutes: 30, installation_ids: rooms,
        professionals: { mode: 'any', ids: doctors, preferred_id: 1, fallback_when: 'unavailable' },
        equipment_requirements: [{ equipment_ids: units }], ...patch });
      const base = f.profile(4, [phase('single')]);
      const combined = f.profile(4, [phase('first'), phase('second', { start_offset_minutes: 15 }),
        phase('third', { start_offset_minutes: 45, duration_minutes: 15 })]);
      const createTreatment = (id, profile) => db.Tratamiento.create({ id_tratamiento: id, clinica_id: 100,
        grupo_clinica_id: 50, nombre: `Tratamiento ficticio de rendimiento ${id}`, origen: 'clinica', activo: true,
        clinical_config: { catalog_status: 'active', booking_profile: profile } });
      const query = id => ({ tratamiento_id: String(id), duration_minutes: undefined, granularity_min: '5', limit: '500' });
      const http = async (handler, input) => {
        const response = await f.transport(handler, input);
        assert.equal(response.statusCode, 200, JSON.stringify(response.body));
        return response.body;
      };
      const context = profile => loadBookingContext({ db, clinic, profile: normalizeBookingProfile(profile),
        start: resolveLocalInstant(DATE, '00:00:00', 'Europe/Madrid'),
        end: resolveLocalInstant('2030-01-08', '00:00:00', 'Europe/Madrid'), occupancyEnabled: true, equipmentEnabled: true });
      let clinic;
      report.performance = { scope: 'Native services, native booking/schedule/equipment models, temporary skip-networking MySQL, actual owned HTTP; synthetic clinic/patient/treatment fixtures and handler ACL, no browser/auth/provider',
        node: process.version, measured_at: new Date().toISOString(), source_sha256: sourceHashes,
        measurements: [], fixture: { doctors: 8, rooms: 12, physical_equipment: 4, dense_legacy_appointments: 180, days: 1, step_minutes: 5, examined_wall_clock_candidates: 288 },
        correctness: [], known_gaps: [] };
      try {
        await db.Usuario.bulkCreate(doctors.filter(id => id > 2).map(id_usuario => ({ id_usuario,
          nombre: `Profesional de carga ficticio ${id_usuario}`, apellidos: 'Sólo QA' })));
        for (const doctor_id of doctors.filter(id => id > 2)) {
          const membership = await db.DoctorClinica.create({ clinica_id: 100, doctor_id, activo: true, recibe_citas: true });
          for (let day = 1; day <= 5; day++) await db.DoctorHorario.create({ doctor_clinica_id: membership.id,
            dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
        }
        await db.Instalacion.update({ profesionales_permitidos: doctors }, { where: { clinica_id: 100 } });
        for (const id of rooms.filter(id => id > 102)) {
          await db.Instalacion.create({ id, clinica_id: 100, nombre: `Sala de carga ficticia ${id}`, profesionales_permitidos: doctors, activo: true });
          for (let day = 1; day <= 5; day++) await db.InstalacionHorario.create({ instalacion_id: id,
            dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
        }
        await db.BookingEquipment.update({ turnaround_minutes: 0 }, { where: { id: 401 } });
        await db.BookingEquipment.bulkCreate(units.filter(id => id !== 401).map(id => ({ id, owner_clinic_id: 100, group_id: 50,
          name: `Unidad física de carga ficticia ${id}`, family_key: 'owned_fixture_unit', mobility: 'mobile', status: 'available', turnaround_minutes: 0 })));
        await db.BookingEquipmentClinic.bulkCreate(units.filter(id => id !== 401).map(equipment_id => ({ equipment_id, clinic_id: 100 })));
        await db.BookingEquipmentRoomPolicy.update({ equipment_ids: units }, { where: { installation_id: [101, 102] } });
        await db.BookingEquipmentRoomPolicy.bulkCreate(rooms.filter(id => id > 102).map(installation_id => ({ installation_id, mode: 'selected', equipment_ids: units })));
        await createTreatment(501, base); await createTreatment(502, combined);
        clinic = await db.Clinica.findByPk(100);

        await http('treatmentSlots', query(501)); // Warm actual handler, SQL and timezone formatter.
        const empty = await measured('empty single phase: native HTTP full day', () => http('treatmentSlots', query(501)));
        assert(empty.slots.length > 0);
        const seed = [];
        for (const [roomIndex, instalacion_id] of rooms.slice(0, 10).entries()) for (let index = 0; index < 18; index++) {
          const start = new Date(Date.parse('2030-01-07T08:00:00Z') + (index * 30 + (roomIndex % 3) * 5) * 60000).toISOString();
          seed.push(f.values({ paciente_id: 101 + seed.length, tratamiento_id: null, doctor_id: 1 + (roomIndex + index) % 6,
            instalacion_id, inicio: start, fin: plus(start, 15), source_system: 'owned_performance_fixture',
            import_metadata: { owned_qa: true } }));
        }
        await db.Paciente.bulkCreate(seed.map(row => ({ id_paciente: row.paciente_id })));
        await db.CitaPaciente.bulkCreate(seed);
        assert.equal(await db.CitaPaciente.count(), 180);
        const countsBeforeRead = await f.counts();
        const denseContext = await measured('dense native bulk context only', () => context(base));
        assert(denseContext.doctors.get(1).busy.length > 0); assert.equal(denseContext.doctors.get(7).busy.length, 0);
        const pure = await measured('dense solver/calendar only, context already loaded (supplementary)', async () => solutionsForCalendar({
          profile: normalizeBookingProfile(base), context: denseContext, date: DATE, stepMinutes: 5, limit: 500, now: NOW, allowConfirmedOverlap: true }));
        const dense = await measured('dense single phase: native HTTP full day', () => http('treatmentSlots', query(501)));
        assert.deepEqual(dense.slots.map(projection), pure.map(projection));
        // Independent enumeration uses the canonical solver directly, not the
        // calendar search. It includes every five-minute instant, evening too.
        const canonical = [];
        for (let minute = 0; minute < 1440; minute += 5) {
          const start = resolveLocalInstant(DATE, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, denseContext.timeZone);
          const result = solveBookingProfile({ profile: base, start, ...denseContext });
          if (result) canonical.push(projection({ ...result, booking_plan_sha256: bookingPlanHash(base, result) }));
        }
        assert.deepEqual(dense.slots.map(projection), canonical);
        assert.deepEqual(await f.counts(), countsBeforeRead);
        report.checks.push('Native HTTP full-day dense proposals exactly equal direct canonical solver at all288 five-minute candidates, including evening; repeated GETs create no appointments, occupancy or resource rows');

        const singleColumn = await measured('dense one room: native HTTP slots with diagnostics', () => http('slots', {
          ...query(501), doctor_id: '1', instalacion_id: '111', include_unavailable: 'true' }));
        const batch = await measured('dense12 rooms: native HTTP slots with diagnostics, one shared SQL context', () => http('slots', {
          ...query(501), doctor_id: '1', 'instalacion_ids[]': rooms.map(String), include_unavailable: 'true' }));
        assert.deepEqual(batch.slots_by_instalacion['111'], singleColumn.slots);
        const singleSql = report.performance.measurements.at(-2).query_counts, batchSql = report.performance.measurements.at(-1).query_counts;
        assert.deepEqual(batchSql, singleSql, 'Batch columns must not multiply SQL reads');
        report.checks.push('Actual slots HTTP12-room batch has the same bounded SQL query count as one room and identical room111 proposals/receipts; diagnostics measured, not assumed free');
        const actualGrid = await measured('dense12 rooms: native HTTP agenda grid with diagnostics', () => http('grid', {
          ...query(501), context_doctor_id: '1', mode: 'installation', column_ids: rooms.map(String), dates: [DATE] }));
        assert.equal(actualGrid.rows.length, rooms.length);
        for (const row of actualGrid.rows) {
          assert.equal(row.ok, true); assert.deepEqual(row.slots, batch.slots_by_instalacion[String(row.column_id)]);
        }
        report.checks.push('The actual agenda grid HTTP endpoint preserves all12 bulk-slot column proposals and native diagnostic envelopes; SQL/time measured separately from the slots endpoint');

        const combinedContext = await measured('dense3 steps: native SQL context only', () => context(combined));
        const multi = await measured('dense3 steps: native HTTP full day', () => http('treatmentSlots', query(502)));
        assert.equal(multi.duration_minutes, 60);
        const canonicalCombined = [];
        for (let minute = 0; minute < 1440; minute += 5) {
          const start = resolveLocalInstant(DATE, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, combinedContext.timeZone);
          const result = solveBookingProfile({ profile: combined, start, ...combinedContext });
          if (result) canonicalCombined.push(projection({ ...result, booking_plan_sha256: bookingPlanHash(combined, result) }));
        }
        assert.deepEqual(multi.slots.map(projection), canonicalCombined);
        report.checks.push('Native three-step HTTP proposals and complete receipts equal direct canonical solver at all288 five-minute starts, with60-minute envelope rather than75-minute sum');
        const knownFeasibleStart = '2030-01-07T09:00:00.000Z';
        const witness = solveBookingProfile({ profile: combined, start: knownFeasibleStart, ...combinedContext,
          selections: { first: { doctor_id: 7, installation_id: 111 }, second: { doctor_id: 8, installation_id: 112 }, third: { doctor_id: 7, installation_id: 111 } } });
        assert(witness, 'A concrete eligible assignment is required before alleging a combinatorial miss');
        const missedFeasibleStart = !multi.slots.some(slot => slot.start_at === knownFeasibleStart);
        report.performance.correctness.push({ kind: 'explicit canonical feasible witness vs automatic alternatives', missed_feasible_start: missedFeasibleStart,
          start_at: knownFeasibleStart, witness: projection({ ...witness, booking_plan_sha256: bookingPlanHash(combined, witness) }) });
        if (missedFeasibleStart) report.performance.known_gaps.push('Automatic3-step alternatives miss a native-context feasible explicit assignment under the solver4096 exploration bound; no product optimization applied by benchmark');

        // Fresh native reads after authoritative writes: no stale preview cache
        // can keep the old slot, silently move a machine or stretch old bookings.
        const chosen = dense.slots.find(slot => slot.start_at === '2030-01-07T18:00:00.000Z');
        assert(chosen);
        const reserveInput = (slot, treatmentId = 501) => ({ appointmentValues: f.values({ paciente_id: 1, tratamiento_id: treatmentId,
          doctor_id: slot.phases[0].doctor_ids[0], instalacion_id: slot.phases[0].installation_id, inicio: slot.start_at, fin: slot.end_at }),
          expectedPlanSha256: slot.booking_plan_sha256,
          selections: Object.fromEntries(slot.phases.map(phase => [phase.key, { doctor_id: phase.doctor_ids[0], installation_id: phase.installation_id }])),
          priorityAcknowledged: true });
        const made = await f.reserve(reserveInput(chosen)), frozen = clone(await f.read(made.id_cita));
        const selectedQuery = { ...query(501), doctor_id: String(chosen.phases[0].doctor_ids[0]), instalacion_id: String(chosen.phases[0].installation_id) };
        assert(!(await http('treatmentSlots', selectedQuery)).slots.some(slot => slot.start_at === chosen.start_at));
        const moveSlot = (await http('treatmentSlots', selectedQuery)).slots.find(slot => slot.start_at === '2030-01-07T17:00:00.000Z');
        assert(moveSlot);
        await f.reserve({ ...reserveInput(moveSlot), existingAppointmentId: made.id_cita });
        const moved = await http('treatmentSlots', selectedQuery);
        assert(moved.slots.some(slot => slot.start_at === chosen.start_at)); assert(!moved.slots.some(slot => slot.start_at === moveSlot.start_at));
        const canceledProvenance = clone(await f.occupancy(made.id_cita));
        await f.reserve({ existingAppointmentId: made.id_cita, appointmentValues: { estado: 'cancelada' } });
        assert((await http('treatmentSlots', selectedQuery)).slots.some(slot => slot.start_at === moveSlot.start_at));
        assert.equal(await db.CitaPaciente.count(), 181);
        assert.deepEqual(clone(await f.occupancy(made.id_cita)), canceledProvenance);
        report.checks.push('Real create/move/cancel command changes native HTTP availability immediately; old slot frees after move, new slot frees after cancellation, canonical ID and canceled occupancy provenance retained without consuming capacity');

        const originalHash = chosen.booking_plan_sha256;
        const longer = clone(base); longer.phases[0].duration_minutes = 45;
        await db.Tratamiento.update({ clinical_config: { catalog_status: 'active', booking_profile: longer } }, { where: { id_tratamiento: 501 } });
        const longerSlot = (await http('treatmentSlots', selectedQuery)).slots.find(slot => slot.start_at === chosen.start_at);
        assert(longerSlot); assert.equal(longerSlot.end_at, plus(chosen.start_at, 45)); assert.notEqual(longerSlot.booking_plan_sha256, originalHash);
        assert.equal(iso((await f.read(made.id_cita)).fin), plus(moveSlot.start_at, 30), 'Catalog edit cannot resize the old canceled appointment');
        await db.Tratamiento.update({ clinical_config: { catalog_status: 'active', booking_profile: base } }, { where: { id_tratamiento: 501 } });
        await db.BookingEquipment.update({ status: 'unavailable' }, { where: { id: chosen.phases[0].equipment[0].id } });
        const differentMachine = (await http('treatmentSlots', selectedQuery)).slots.find(slot => slot.start_at === chosen.start_at);
        assert(differentMachine); assert.notEqual(differentMachine.phases[0].equipment[0].id, chosen.phases[0].equipment[0].id);
        assert.notEqual(differentMachine.booking_plan_sha256, originalHash);
        await db.BookingEquipment.update({ status: 'available' }, { where: { id: chosen.phases[0].equipment[0].id } });
        const restored = (await http('treatmentSlots', selectedQuery)).slots.find(slot => slot.start_at === chosen.start_at);
        assert.equal(restored.booking_plan_sha256, originalHash);
        assert.deepEqual(frozen.import_metadata.booking.profile, (await f.read(made.id_cita)).import_metadata.booking.profile);
        report.checks.push('SQL profile duration and machine availability changes invalidate fresh native HTTP receipts; restoring configuration restores exact receipt while an existing appointment frozen profile/time remain unchanged');

        // Same physical room owned by another group clinic is not extra room
        // capacity. This is a real canonical write, not a fabricated busy map.
        const peer = await f.reserve({ appointmentValues: f.values({ clinica_id: 200, paciente_id: 2, tratamiento_id: 11,
          doctor_id: 2, instalacion_id: 201, inicio: chosen.start_at, fin: plus(chosen.start_at, 30) }), durationSelection: { duration_minutes: 30 } });
        const aliased = await http('treatmentSlots', { ...query(501), doctor_id: '1', instalacion_id: '101' });
        assert(!aliased.slots.some(slot => slot.start_at === chosen.start_at));
        await f.reserve({ existingAppointmentId: peer.id_cita, appointmentValues: { estado: 'cancelada' } });
        assert((await http('treatmentSlots', { ...query(501), doctor_id: '1', instalacion_id: '101' })).slots.some(slot => slot.start_at === chosen.start_at));
        report.checks.push('Native peer-clinic canonical booking occupies physical alias101/201; fresh HTTP blocks it and frees it after cancellation without inventing separate group-clinic capacity');

        const setup = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
        const attended = { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 };
        const shared = (key, room, unit, policy) => f.profile(4, [phase(key, { installation_ids: [room],
          professionals: { mode: 'any', ids: [1], preferred_id: 1 }, equipment_requirements: [{ equipment_ids: [unit] }],
          staff_attention: [policy], preparation_sharing: { mode: 'same_start' } })]);
        const recipes = [shared('autonomous_a', 103, 401, setup), shared('autonomous_b', 104, 402, setup), shared('continuous', 105, 403, attended)];
        for (const [index, profile] of recipes.entries()) await createTreatment(511 + index, profile);
        await createTreatment(514, shared('fourth', 106, 404, setup));
        const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        for (const [orderIndex, order] of orders.entries()) {
          const start = new Date(Date.parse('2030-01-08T08:30:00Z') + orderIndex * 90 * 60000).toISOString();
          const visits = [];
          for (const index of order) {
            const profile = normalizeBookingProfile(recipes[index]);
            const loaded = await loadBookingContext({ db, clinic, profile, start: new Date(start), end: new Date(plus(start, 30)), occupancyEnabled: true, equipmentEnabled: true });
            const solution = solveBookingProfile({ profile, start, ...loaded }); assert(solution, `Native sharing order${order}: phase${index}`);
            const slot = { ...solution, booking_plan_sha256: bookingPlanHash(profile, solution) };
            const appointmentValues = reserveInput(slot, 511 + index).appointmentValues;
            appointmentValues.paciente_id = index + 1;
            visits.push(await f.reserve({ ...reserveInput(slot, 511 + index), appointmentValues }));
          }
          const persisted = (await Promise.all(visits.map(visit => f.occupancy(visit.id_cita)))).flat();
          const staff = persisted.filter(row => row.resource_kind === 'doctor');
          assert.equal(staff.reduce((sum, row) => sum + (new Date(row.end_at) - new Date(row.start_at)) / 60000, 0), 30);
          const snapshots = await Promise.all(visits.map(visit => f.read(visit.id_cita)));
          const intervals = snapshots.flatMap(row => row.import_metadata.booking.phases.flatMap(phase => phase.staff_intervals));
          assert.equal(intervals.filter(row => row.kind === 'start').reduce((sum, row) => sum + (Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000, 0), 15);
          const ongoing = intervals.find(row => row.kind === 'continuous'); assert(ongoing);
          assert.equal(ongoing.start_at, plus(start, 15)); assert.equal(ongoing.end_at, plus(start, 30));
          assert(persisted.filter(row => ['installation', 'equipment'].includes(row.resource_kind)).every(row => iso(row.start_at) === start && iso(row.end_at) === plus(start, 30)));
          const fourthProfile = normalizeBookingProfile(shared('fourth', 106, 404, setup));
          const fourthContext = await loadBookingContext({ db, clinic, profile: fourthProfile,
            start: new Date(start), end: new Date(plus(start, 30)), occupancyEnabled: true, equipmentEnabled: true });
          assert.equal(solveBookingProfile({ profile: fourthProfile, start, ...fourthContext }), null);
        }
        report.checks.push('Native writer+SQL reread validates all6 booking orders: three real same-start appointments retain5+5+5 preparation inside15minutes, subsequent continuous attention15–30, full physical holds, and reject fourth setup; fictitious quantified recipe does NOT resolve real EMS unquantified intermediate checks');
        report.performance.known_gaps.push('No live MySQL dataset/latency, full HTTP auth/router, real browser/tablet/provider, or clinical approval. Dense timings are measured on this temporary local MySQL and host, not a production SLA. Fictitious same-start fixture deliberately does not invent the real EMS intermediate/final intervention.');
        assert.equal(missedFeasibleStart, false, 'Automatic alternatives must advertise the proven feasible3-step assignment; inspect report.performance.correctness');
        report.checks.push('Automatic dense3-step HTTP search retains the explicit canonical feasible witness instead of exhausting alternatives prematurely');
      } finally {
        measurement = null; sql.options.logging = previousLogging; sql.options.benchmark = previousBenchmark;
        await f.close();
      }
    });
  });
