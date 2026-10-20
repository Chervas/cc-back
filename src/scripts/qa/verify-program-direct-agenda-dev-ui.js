#!/usr/bin/env node
'use strict';

// Real native Angular/HTTP/SQL QA of a retained synthetic DEV programme. No
// interception of responses, Angular debug API, direct writes or reset logic.
// The exported runner is also reusable for the separate fresh demo recording.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const puppeteer = require('puppeteer-core');
const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
const { MARKER, inspect } = require('./program-closure-dev-fixture');
const { createActions } = require('./program-direct-agenda-ui-actions');
const ORIGIN = 'http://localhost:4203', PATIENT = 33021, PUBLIC_PATIENT = 'pac_09202026000000000001';
const PROGRAM = '829f5017-b5fd-46fe-a21b-777e6eed67c2';
const PROGRAM_NAME = 'QA · Programa directo sin presupuesto · 20/10';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

function allowedMutation({ pathname, method, body, programId, voucherId }) {
  if (method !== 'POST' || !body || body.force || body.force_schedule || body.clinic_id != null && body.clinic_id !== 1) return false;
  if ([`/api/economics/patients/${PATIENT}/program-enrollments`, `/api/economics/patients/${PUBLIC_PATIENT}/program-enrollments`].includes(pathname)) {
    return body.program_id === programId && body.program_version === 1 && body.clinic_id === 1
      && Object.keys(body).every(key => ['clinic_id', 'program_id', 'program_version', 'request_key'].includes(key));
  }
  if (!voucherId) return false;
  const base = `/api/economics/vouchers/${voucherId}`;
  if (pathname === base + '/program-proposals') return true;
  return pathname === base + '/program-appointments' && Array.isArray(body.sessions) && body.sessions.length > 0 && body.sessions.length <= 3
    && body.sessions.every(row => ['qa_1', 'qa_2', 'qa_3'].includes(row.key));
}

async function readSqlState(connection, programId, voucherId) {
  const [vouchers] = await connection.query('SELECT id,public_id,clinic_id,patient_id,budget_id,status,total_units,available_units,sold_amount,program_snapshot FROM PatientVouchers WHERE clinic_id=1 AND patient_id=? AND JSON_UNQUOTE(JSON_EXTRACT(program_snapshot,\'$.program_id\'))=? ORDER BY id', [PATIENT, programId]);
  const voucher = voucherId ? vouchers.find(row => row.public_id === voucherId) : vouchers[0] || null;
  const [appointments] = voucher ? await connection.query('SELECT id_cita,clinica_id,paciente_id,voucher_id,inicio,fin,estado,source_system,import_metadata FROM CitasPacientes WHERE voucher_id=? ORDER BY id_cita', [voucher.id]) : [[]];
  const [occupancies] = voucher ? await connection.query('SELECT o.appointment_id,o.phase_key,o.resource_kind,o.resource_key,o.start_at,o.end_at FROM AppointmentBookingOccupancies o JOIN CitasPacientes a ON a.id_cita=o.appointment_id WHERE a.voucher_id=? ORDER BY o.appointment_id,o.phase_key,o.resource_key', [voucher.id]) : [[]];
  const [[receipts]] = voucher ? await connection.query('SELECT COUNT(*) AS count FROM PatientProgramBookingRequests WHERE voucher_id=?', [voucher.id]) : [[{ count: 0 }]];
  const forbidden = {};
  for (const table of ['EconomicBudgets', 'EconomicPayments', 'PatientFiscalDocuments']) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM ${table} WHERE clinic_id=1 AND patient_id=?`, [PATIENT]); forbidden[table] = row.count;
  }
  for (const table of ['JobRequests', 'FlowExecutionsV2', 'Messages']) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM ${table}`); forbidden[table] = row.count;
  }
  const [[movements]] = voucher ? await connection.query('SELECT COUNT(*) AS count FROM PatientVoucherMovements WHERE voucher_id=?', [voucher.id]) : [[{ count: 0 }]];
  return { vouchers, voucher, appointments, occupancies, receipts: receipts.count, unit_movements: movements.count, forbidden };
}

async function runAgendaScenario({ page, connection, programId = PROGRAM, programName = PROGRAM_NAME, out, report,
  firstDay = '2026-10-27', onStep = async () => {}, includeReschedule = true, resumeAssignedVoucherId = null }) {
  const a = createActions(page), posts = [], responses = [], failures = [];
  report.posts = posts;
  let voucherId = resumeAssignedVoucherId;
  const state = () => readSqlState(connection, programId, voucherId);
  const shot = async name => { if (out) { const filename = path.join(out, name + '.png'); await page.screenshot({ path: filename }); return filename; } };
  const step = async (title, name) => { report.checks.push(title); await onStep(title, { name, page }); if (name) await shot(name); };
  const endpoint = suffix => `/api/economics/vouchers/${voucherId}/${suffix}`;
  const call = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('accessToken') },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { url, method, body });
  const responseFor = suffix => page.waitForResponse(response => new URL(response.url()).pathname === endpoint(suffix), { timeout: 60000 });
  const complete = async pending => {
    await page.waitForFunction(() => !!document.querySelector('app-program-booking-dialog') && !document.querySelector('app-program-booking-dialog mat-progress-bar'), { timeout: 60000 });
    const plan = await call(endpoint('program-plan')); assert.equal(plan.status, 200, JSON.stringify(plan.data));
    if (pending != null) assert.equal(plan.data.pending_count, pending); return plan.data;
  };
  const closeDrawer = async () => {
    await delay(500);
    if (await a.visible('[data-qa="agenda-new-drawer-close"]')) await a.click('[data-qa="agenda-new-drawer-close"]');
    await page.waitForFunction(() => !document.querySelector('[data-qa="agenda-new-drawer"]'), { timeout: 15000 });
  };
  const reopen = async () => { await closeDrawer(); await a.openPatientDrawer('Paciente ficticio Prueba BS Medical'); await a.openExistingProgram(programName); return complete(); };
  const assertHolds = value => {
    for (const appointment of value.appointments) {
      assert.equal(appointment.clinica_id, 1); assert.equal(appointment.paciente_id, PATIENT); assert.equal(appointment.source_system, 'treatment_program');
      const m = json(appointment.import_metadata); assert.equal(m.automation_policy, 'hold');
      for (const key of ['appointment_details', 'day_before', 'same_day']) assert.equal(m.notification_suppression[key], true);
      assert.equal(m.booking.phases.length, 2); assert(value.occupancies.filter(row => row.appointment_id === appointment.id_cita).length >= 4);
    }
    assert.equal(value.unit_movements, 0);
    assert.equal(Number(value.voucher.available_units), 3); assert.equal(value.voucher.budget_id, null);
  };
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return request.continue();
    if (url.origin !== ORIGIN) return request.abort();
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      let body; try { body = JSON.parse(request.postData() || '{}'); } catch {}
      if (!allowedMutation({ pathname: url.pathname, method: request.method(), body, programId, voucherId })) {
        report.blocked_writes.push({ path: url.pathname, method: request.method() }); return request.abort();
      }
      posts.push({ path: url.pathname, body });
    }
    return request.continue();
  });
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/economics/')) return;
    responses.push({ path: url.pathname, status: response.status() });
  });
  page.on('pageerror', error => failures.push(error.message));
  const initial = await state();
  report.initial_forbidden_counts = initial.forbidden;
  if (resumeAssignedVoucherId) {
    assert.equal(initial.vouchers.length, 1); assert.equal(initial.voucher.public_id, resumeAssignedVoucherId);
    assert([0, 2, 3].includes(initial.appointments.length), 'ONLY_MARKER_OWNED_RETAINED_ASSIGNMENT_CAN_RESUME_THIS_RUN');
    if (initial.appointments.length === 3) assert([2, 3, 4].includes(initial.receipts));
    else assert.equal(initial.receipts, initial.appointments.length === 2 ? 1 : 0);
    assert.equal(initial.voucher.budget_id, null);
    report.voucher_id = voucherId; report.resumed_retained_assignment = true;
  } else assert.equal(initial.vouchers.length, 0, 'NEW_SYNTHETIC_PROGRAM_MUST_NOT_BE_ASSIGNED_YET');
  await page.setViewport({ width: 1440, height: 1000 }); await page.setCacheEnabled(false);
  await page.goto(ORIGIN + '/agenda-de-citas?clinica_id=1&fecha=2026-10-27&vista=day', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-qa="agenda-create-fab"]', { timeout: 60000 });
  assert.equal((await call('/api/auth/me')).status, 200, 'NORMAL_DEV_AUTH_REQUIRED');
  let plan;
  if (!resumeAssignedVoucherId) {
  await a.openPatientDrawer('Paciente ficticio Prueba BS Medical'); await a.chooseProgram(programName);
  await step('Agenda permite asignar el programa clínico sin entrar en presupuestos.', '01-asignar-desde-agenda');
  await a.cancelEnrollment(); assert.equal((await state()).vouchers.length, 0); assert.equal(posts.length, 0);
  await step('Cancelar la asignación no crea programa del paciente, presupuesto ni citas.');
  await a.click(a.selectors.assign); await page.waitForSelector(a.selectors.confirmEnrollment, { visible: true });
  const assigned = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/program-enrollments'), { timeout: 60000 });
  await a.click(a.selectors.confirmEnrollment); const assignedResponse = await assigned;
  assert.equal(assignedResponse.status(), 201); const enrollment = await assignedResponse.json();
  voucherId = enrollment.voucher_id; assert(voucherId); assert.equal(enrollment.commercial_status, 'not_contracted');
  assert.equal(enrollment.sold_amount, null); assert.equal(enrollment.catalog_reference_amount, 150);
  report.voucher_id = voucherId; await a.waitPlanner(); plan = await complete(3);
  assert.equal(plan.origin, 'program_enrollment'); assert.equal((await state()).appointments.length, 0);
  await step('La asignación queda guardada sin presupuesto ni cobro; las tres citas siguen pendientes.', '02-plan-sin-citas');
  await a.closePlanner();
  }
  let pendingResponse;
  if (initial.appointments.length < 3) {
  plan = await reopen(); assert.equal(plan.pending_count, initial.appointments.length === 2 ? 1 : 3);
  assert.equal((await state()).vouchers.length, 1);
  await step('Continuación → Programas recupera la asignación ya existente, sin duplicarla.', '03-recuperar-programa');
  if (initial.appointments.length === 0) {
  pendingResponse = responseFor('program-proposals'); await a.proposeDates(firstDay);
  assert.equal((await pendingResponse).status(), 200); await a.idle();
  assert.equal(await page.$$eval('[data-session-key]', rows => rows.length), 3);
  assert.equal((await state()).appointments.length, 0);
  await step('Se proponen tres fechas reales con disponibilidad de sala y profesional, sin reservar todavía.', '04-tres-propuestas');
  await a.click('[data-session-key="qa_1"] [data-qa="program-choose-date"]');
  await page.waitForSelector('[data-session-key="qa_1"] [data-qa="program-explicit-resources"]');
  assert.equal(await page.$$eval('[data-session-key="qa_1"] [data-qa="program-explicit-resources"]', nodes => nodes.length), 2);
  await a.input('[data-session-key="qa_1"] input[type="datetime-local"]', firstDay + 'T11:00');
  pendingResponse = responseFor('program-proposals'); await a.click('[data-session-key="qa_1"] button', 'Comprobar este hueco');
  assert.equal((await pendingResponse).status(), 200); await a.idle();
  await a.selectSession('qa_3', false);
  await step('Se puede revisar una fecha y sus recursos y reservar sólo las dos sesiones seleccionadas.', '05-seleccionar-solo-dos');
  pendingResponse = responseFor('program-appointments'); await a.confirmDates(); assert.equal((await pendingResponse).status(), 201);
  plan = await complete(1); const partial = await state(); assert.equal(partial.appointments.length, 2); assertHolds(partial);
  assert.equal(posts.filter(row => row.path.endsWith('/program-appointments')).at(-1).body.sessions.length, 2);
  await step('Dos citas reservadas; queda una pendiente y no se consume ninguna sesión.', '06-dos-reservadas');
  await a.closePlanner(); plan = await reopen(); assert.equal(plan.pending_count, 1);
  }
  pendingResponse = responseFor('program-proposals'); await a.proposeDates(firstDay);
  assert.equal((await pendingResponse).status(), 200); await a.idle();
  assert.deepEqual(await page.$$eval('[data-session-key]', rows => rows.map(row => row.getAttribute('data-session-key'))), ['qa_3']);
  pendingResponse = responseFor('program-appointments'); await a.confirmDates(); assert.equal((await pendingResponse).status(), 201);
  plan = await complete(0); const full = await state(); assert.equal(full.appointments.length, 3); assertHolds(full);
  const exact = posts.filter(row => row.path.endsWith('/program-appointments')).at(-1).body;
  const replay = await call(endpoint('program-appointments'), 'POST', exact); assert.equal(replay.status, 201); assert.equal(replay.data.replayed, true);
  assert.equal((await state()).appointments.length, 3);
  await step('Al retomar sólo se propone la cita restante. Termina con tres citas y cero pendientes, sin duplicados al reintentar.', '07-todas-planificadas');
  } else {
    // Resume the retained result after a driver interruption. Never delete or
    // reset its history merely to obtain another clean demonstration.
    await page.goto(ORIGIN + '/pacientes/detalle/33021/presupuestos?clinica_id=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav[aria-label="Áreas económicas"]', { timeout: 45000 });
    await a.click('nav[aria-label="Áreas económicas"] button', 'Bonos');
    await page.waitForFunction(name => [...document.querySelectorAll('article')].some(row => row.textContent.includes(name)), { timeout: 30000 }, programName);
    assert(await page.evaluate(name => {
      const card = [...document.querySelectorAll('article')].find(row => row.textContent.includes(name));
      const button = [...(card?.querySelectorAll('button') || [])].find(button => button.textContent.includes('Planificar citas'));
      if (!button || button.disabled) return false; button.click(); return true;
    }, programName));
    await a.waitPlanner(); plan = await complete(0);
  }
  for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await delay(120);
    const dimensions = await page.$eval('app-program-booking-dialog', el => {
      const body = el.querySelector('.program-body'), footer = el.querySelector('footer');
      return { body: body.scrollWidth - body.clientWidth, footer: footer.scrollWidth - footer.clientWidth,
        bottom: footer.getBoundingClientRect().bottom, viewport: innerHeight };
    });
    assert(dimensions.body <= 2 && dimensions.footer <= 2 && dimensions.bottom <= dimensions.viewport + 2, JSON.stringify(dimensions));
    await shot('08-plan-final-' + width);
  }
  await page.setViewport({ width: 1440, height: 1000 });
  const links = await page.$$eval('[data-qa="program-view-appointment"]', rows => rows.map(row => row.href)); assert.equal(links.length, 3);
  await a.click('[data-qa="program-view-appointment"]');
  await page.waitForFunction(() => location.pathname === '/agenda-de-citas', { timeout: 30000 });
  await page.waitForSelector('[data-qa="agenda-day-scroll"], [data-qa="agenda-primary-header"]', { timeout: 60000 }); await delay(1200);
  await step('Ver en agenda abre la cita canónica del programa en la clínica correcta.', '09-citas-en-agenda');
  if (includeReschedule) {
    async function move({ index, scope, nextTime }) {
      const previous = await state(), original = [...previous.appointments].sort((x, y) => new Date(x.inicio) - new Date(y.inicio));
      const target = original[index];
      const url = new URL(links[index]); assert.equal(url.origin, ORIGIN); assert.equal(url.searchParams.get('clinica_id'), '1');
      assert.equal(url.searchParams.get('cita_id'), String(target.id_cita));
      // This is the same canonical Agenda deep link used by appointment menus.
      // It performs its normal authorized appointment read before opening the
      // edit drawer; no component instance or API response is substituted.
      url.searchParams.set('action', 'edit'); await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-qa="agenda-new-drawer"] input[name="citaHoraInicio"]', { visible: true });
      await a.input('input[name="citaHoraInicio"]', nextTime);
      await a.click('[data-qa="agenda-new-drawer-footer"] button', 'Guardar');
      await page.waitForSelector('app-program-move-scope-dialog h2', { visible: true, timeout: 30000 });
      assert.equal((await state()).receipts, previous.receipts);
      await step(scope === 'single' ? 'Mover permite elegir sólo esta cita.' : 'Mover también permite desplazar esta cita y las siguientes.', '10-mover-' + scope);
      const proposal = responseFor('program-proposals'); await a.click(`[data-qa="program-move-${scope}"]`);
      assert.equal((await proposal).status(), 200); await a.waitPlanner();
      const count = await page.$$eval('[data-session-key]', nodes => nodes.length); assert.equal(count, scope === 'single' ? 1 : 3 - index);
      if (scope === 'following') await a.click('[data-qa="program-resume-ack"]');
      await step('Se revisan las nuevas fechas antes de confirmar; no se mueve ninguna cita por adelantado.', '11-revisar-' + scope);
      const moved = responseFor('program-appointments'); await a.confirmDates(); assert.equal((await moved).status(), 201);
      const after = await state(); assert.equal(after.appointments.length, 3); assertHolds(after);
      const sent = posts.filter(row => row.path.endsWith('/program-appointments')).at(-1).body;
      assert.equal(sent.mode, 'reschedule'); assert.equal(sent.reschedule_scope, scope); assert.equal(sent.sessions.length, count);
      const included = new Set(sent.sessions.map(row => row.key));
      for (const old of previous.appointments) {
        const current = after.appointments.find(row => row.id_cita === old.id_cita); assert(current);
        const key = json(old.import_metadata).program_session.key;
        if (!included.has(key)) assert.equal(new Date(current.inicio).getTime(), new Date(old.inicio).getTime());
      }
      assert.equal(after.receipts, previous.receipts + 1);
      await step('El cambio confirmado conserva los mismos identificadores y los recursos; las demás citas no se alteran.', '12-guardado-' + scope);
      await a.closePlanner(); await delay(700);
      return after;
    }
    const localTime = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
    const retained = [...initial.appointments].sort((x, y) => new Date(x.inicio) - new Date(y.inicio));
    if (retained[0] && localTime(retained[0].inicio) === '12:00') report.retained_single_already_verified = true;
    else await move({ index: 0, scope: 'single', nextTime: '12:00' });
    if (retained[1] && localTime(retained[1].inicio) === '10:00') report.retained_following_already_verified = true;
    else await move({ index: 1, scope: 'following', nextTime: '10:00' });
  }
  const final = await state(); assert.equal(final.vouchers.length, 1); assertHolds(final); assert.deepEqual(final.forbidden, initial.forbidden);
  assert.deepEqual(report.blocked_writes, []); assert.deepEqual(failures, []);
  report.responses = responses; report.appointment_ids = final.appointments.map(row => row.id_cita);
  report.final_pending_count = (await call(endpoint('program-plan'))).data.pending_count;
  report.financial_outbound_count_changes = Object.fromEntries(Object.keys(final.forbidden).map(key => [key, final.forbidden[key] - initial.forbidden[key]]));
  report.booking_receipts = final.receipts; report.page_errors = failures; report.posts = posts;
  return { voucherId, final, plan, links };
}

async function main() {
  assert.equal(process.env.QA_PROGRAM_CLOSURE_DEV_WRITES, MARKER, 'EXPLICIT_SYNTHETIC_DEV_WRITE_AUTHORIZATION_REQUIRED');
  await inspect(); process.umask(0o077);
  const out = fs.mkdtempSync('/home/ubuntu/qa-evidence/program-direct-real-dev-');
  const report = { success: false, target: 'dev_isolated', synthetic_only: true, program_id: PROGRAM, patient_id: PATIENT,
    evidence: out, checks: [], blocked_writes: [] };
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9227', defaultViewport: null });
  const source = (await browser.pages()).find(page => page.url().startsWith(ORIGIN + '/pacientes/detalle/33021'));
  assert(source, 'NORMAL_AUTHENTICATED_SYNTHETIC_DEV_TAB_REQUIRED');
  const auth = await source.evaluate(() => Object.fromEntries(['accessToken', 'currentUser', 'userInfo', 'currentRole']
    .map(key => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null)));
  assert(auth.accessToken, 'NORMAL_DEV_AUTH_REQUIRED');
  const context = await browser.createBrowserContext();
  const cookies = (await source.browserContext().cookies()).filter(cookie => cookie.domain === 'localhost' || cookie.domain === '.localhost');
  if (cookies.length) await context.setCookie(...cookies);
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: context.id, background: true });
  const page = await (await browser.waitForTarget(target => target._targetId === targetId)).page(); await cdp.detach();
  await page.evaluateOnNewDocument(({ origin, auth }) => {
    if (location.origin === origin) { for (const [key, value] of Object.entries(auth)) localStorage.setItem(key, value); localStorage.setItem('selectedClinicId', '1'); }
  }, { origin: ORIGIN, auth });
  const connection = await connectOperatorDatabase('dev');
  try {
    await runAgendaScenario({ page, connection, out, report,
      resumeAssignedVoucherId: process.env.QA_PROGRAM_CLOSURE_DEV_RESUME || null }); report.success = true; report.left_open = page.url();
  } catch (error) {
    report.error = error.message; await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await connection.end(); browser.disconnect(); console.log(JSON.stringify(report));
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { allowedMutation, readSqlState, runAgendaScenario };
