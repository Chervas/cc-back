#!/usr/bin/env node
'use strict';

// REAL Angular/HTTP/SQL QA, retained synthetic DEV only. No API write helper,
// intercepted response, Angular debug API, credential input, cleanup or reset.
// Run ONLY after root approves the published UI and --prepare-widget fixture.
// QA_PROGRAM_CLOSURE_DEV_WRITES=program-closure-20261020 node <this-file>
//   --program-id <fresh --prepare-widget UUID> [--source-target-id <DEV target>]
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { MARKER, inspect, catalogIdentity } = require('./program-closure-dev-fixture');
const { createActions } = require('./program-direct-agenda-ui-actions');
const { readSqlState } = require('./verify-program-direct-agenda-dev-ui');
const ORIGIN = 'http://localhost:4203', PATIENT = 33021, PUBLIC_PATIENT = 'pac_09202026000000000001';
const SOURCE_TARGET = '384A5D75FA234053738DFEF4B8497643';
const WIDGET = '[data-qa="program-agenda-planner"]';
const identity = catalogIdentity({ direct: true, widget: true });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const plain = value => typeof value === 'string' ? JSON.parse(value) : value;
const keysOnly = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const local = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:/.test(value) ? value.replace(' ', 'T') + 'Z' : value));
function allowedMutation({ pathname, method, body, programId, voucherId, canEnroll = false, canBook = false, firstDay = '2026-11-03' }) {
  if (method !== 'POST' || !body || body.force || body.force_schedule) return false;
  if ([`/api/economics/patients/${PATIENT}/program-enrollments`, `/api/economics/patients/${PUBLIC_PATIENT}/program-enrollments`].includes(pathname)) {
    return canEnroll && keysOnly(body, ['clinic_id', 'program_id', 'program_version', 'request_key', 'start_from_position'])
      && body.program_id === programId && body.program_version === 1 && body.clinic_id === 1 && body.start_from_position === 2 && uuid(body.request_key);
  }
  if (!uuid(voucherId)) return false;
  const base = `/api/economics/vouchers/${voucherId}`, validKeys = ['qa_2', 'qa_3', 'qa_4', 'qa_5'];
  if (pathname === base + '/program-proposals') {
    const strategy = body.draft_strategy;
    return keysOnly(body, ['from_date', 'days', 'draft_strategy']) && /^\d{4}-\d\d-\d\d$/.test(body.from_date)
      && body.from_date >= firstDay && Number.isInteger(body.days) && body.days >= 1 && body.days <= 90
      && keysOnly(strategy, ['action', 'pivot_key', 'start_local', 'sessions', 'preferences'])
      && ['initial', 'reset', 'cascade', 'previous_time', 'next_time', 'previous_day', 'next_day'].includes(strategy.action)
      && (strategy.pivot_key == null || validKeys.includes(strategy.pivot_key))
      && (!strategy.sessions || Array.isArray(strategy.sessions) && strategy.sessions.length <= 4 && strategy.sessions.every(row => validKeys.includes(row.key)));
  }
  if (pathname !== base + '/program-appointments' || !canBook
    || !keysOnly(body, ['request_key', 'snapshot_sha256', 'sessions', 'booking_preferences']) || !uuid(body.request_key)
    || !/^[a-f0-9]{64}$/.test(body.snapshot_sha256 || '') || !Array.isArray(body.sessions) || body.sessions.length !== 2
    || [...body.sessions.map(row => row.key)].sort().join(',') !== 'qa_2,qa_3') return false;
  return body.sessions.every(row => keysOnly(row, ['key', 'start_at', 'priority_acknowledged', 'selections'])
    && typeof row.priority_acknowledged === 'boolean' && Number.isFinite(Date.parse(row.start_at))
    && row.start_at.slice(0, 10) >= firstDay && !local(row.start_at).includes('Fri')
    && Object.values(row.selections || {}).length === 2 && Object.values(row.selections || {}).every(selection =>
      keysOnly(selection, ['installation_id', 'doctor_id']) && [73, 74].includes(selection.installation_id) && [220, 221].includes(selection.doctor_id)))
    && hash(body.booking_preferences) === hash({ exclude_weekdays: [5], prefer_after_minutes: 960 });
}
function assertNoticeGateClosed() {
  const pid = execFileSync('systemctl', ['show', 'clinicaclick-back-dev.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  assert(/^[1-9]\d*$/.test(pid), 'DEV_API_NOT_RUNNING');
  const code = `const f=require('node:fs');let value=null;for(const r of f.readFileSync('/proc/${pid}/environ','utf8').split('\\0')){const p=r.indexOf('=');if(r.slice(0,p)==='PATIENT_PROGRAM_BOOKING_NOTICE_ENABLED')value=r.slice(p+1)}process.stdout.write(JSON.stringify(value));`;
  const flag = JSON.parse(execFileSync('sudo', ['-n', process.execPath, '-e', code], { encoding: 'utf8' }));
  assert.notEqual(flag, 'true', 'PROGRAM_NOTICE_GATE_MUST_STAY_CLOSED');
}
async function runWidgetScenario({ page, connection, programId, programName = identity.name, firstDay = '2026-11-03', out, report }) {
  const a = createActions(page), posts = [], failures = []; let voucherId = null, canEnroll = false, canBook = false;
  report.posts = posts;
  const state = () => readSqlState(connection, programId, voucherId);
  const persist = (name, value) => fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  const shot = async name => { await page.screenshot({ path: path.join(out, name + '.png') }); report.screenshots.push(name + '.png'); };
  const idle = () => page.waitForFunction(selector => !!document.querySelector(selector) && !document.querySelector(selector + ' mat-progress-bar'), { timeout: 60000, polling: 100 }, WIDGET);
  const read = url => page.evaluate(async url => {
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + localStorage.getItem('accessToken') } });
    return { status: response.status, data: await response.json() };
  }, url);
  const response = suffix => page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/' + suffix), { timeout: 60000 });
  const snapshot = async label => { const value = await state(); persist(label, value); return value; };
  const close = async () => { await a.click(WIDGET + ' button[aria-label="Cerrar planificador del programa"]'); await page.waitForFunction(selector => !document.querySelector(selector), {}, WIDGET); };
  const preferences = async () => {
    await a.input(WIDGET + ' input[aria-label="Día inicial del programa"]', firstDay);
    await page.keyboard.press('Tab'); await a.input(WIDGET + ' input[aria-label="Hora preferida del programa"]', '');
    for (const selector of ['program-preference-friday', 'program-preference-afternoon']) {
      const input = WIDGET + ` [data-qa="${selector}"] input[type="checkbox"]`;
      if (!await page.$eval(input, node => node.checked)) await a.click(WIDGET + ` [data-qa="${selector}"]`);
    }
  };
  const verifyProposals = data => {
    assert.equal(data.clinic_id, 1); assert.equal(data.timezone, 'Europe/Madrid'); assert.equal(data.sessions.length, 5);
    assert.equal(data.sessions[0].scheduling_status, 'unrecorded');
    for (const row of data.proposals || []) if (row.solution) {
      const display = local(row.solution.start_at); assert(!display.includes('Fri'), 'EXCLUDED_FRIDAY_MUST_NOT_BE_PROPOSED');
      const time = display.match(/\d\d:\d\d/)[0];
      assert(time >= '16:00' || row.preference_warnings?.some(warning => warning.code === 'program_preference_time_fallback'), 'AFTERNOON_FALLBACK_MUST_BE_EXPLAINED');
    }
  };
  async function ownVoucher(candidate) {
    if (voucherId) return voucherId === candidate;
    if (!uuid(candidate)) return false;
    const values = await readSqlState(connection, programId, candidate), v = values.voucher;
    if (values.vouchers.length !== 1 || !v || v.clinic_id !== 1 || v.patient_id !== PATIENT || v.budget_id != null) return false;
    const sealed = plain(v.program_snapshot);
    if (sealed.program_id !== programId || sealed.enrollment?.start_from_position !== 2 || sealed.enrollment.prior_sessions !== 'unrecorded') return false;
    voucherId = candidate; return true;
  }
  await page.setRequestInterception(true);
  page.on('request', request => { void (async () => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return request.continue();
    if (url.origin !== ORIGIN) return request.abort();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return request.continue();
    if (url.pathname.startsWith('/socket.io/')) { report.blocked_socket_posts++; return request.abort(); }
    let body; try { body = JSON.parse(request.postData() || '{}'); } catch {}
    const candidate = /^\/api\/economics\/vouchers\/([a-f0-9-]{36})\//.exec(url.pathname)?.[1];
    if (candidate && !voucherId) await ownVoucher(candidate);
    if (!allowedMutation({ pathname: url.pathname, method: request.method(), body, programId, voucherId, canEnroll, canBook, firstDay })) {
      report.blocked_writes.push({ path: url.pathname, method: request.method() }); return request.abort();
    }
    posts.push({ path: url.pathname, body }); return request.continue();
  })().catch(error => { report.interceptor_errors.push(error.message); request.abort().catch(() => {}); }); });
  page.on('pageerror', error => failures.push(error.message));
  const initial = await snapshot('01-before'); assert.equal(initial.vouchers.length, 0, 'FRESH_WIDGET_FIXTURE_MUST_NOT_BE_ASSIGNED');
  await page.goto(ORIGIN + `/agenda-de-citas?clinica_id=1&fecha=${firstDay}&vista=day`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-qa="agenda-create-fab"]', { timeout: 60000 });
  const me = await read('/api/auth/me'); assert.equal(me.status, 200); assert.equal(me.data.user?.id_usuario ?? me.data.user?.id, 1);
  await a.openPatientDrawer('Paciente ficticio Prueba BS Medical'); await a.setType('Continuación');
  await a.click('[data-qa="appointment-treatment-tabs"] button', 'Programas');
  await a.click('input[placeholder="Buscar programa"]');
  await page.waitForSelector('[data-qa="appointment-create-started-program"]', { visible: true, timeout: 30000 });
  await shot('02-continuacion-programa-empezado'); await a.click('[data-qa="appointment-create-started-program"]');
  await a.input('input[placeholder="Buscar programa"]', programName);
  await page.waitForFunction(name => [...document.querySelectorAll('mat-option')].some(node => node.getClientRects().length && node.textContent.includes(name)), { timeout: 30000 }, programName);
  await a.click('mat-option', programName); await a.click('[data-qa="appointment-assign-clinical-program"]');
  await page.waitForSelector(WIDGET, { visible: true, timeout: 30000 }); await idle();
  await a.click(WIDGET + ' mat-select'); await a.click('mat-option', 'Sesión 2 de 5');
  await preferences(); await shot('03-preparar-sesion2-preferencias');
  canEnroll = true;
  const enrolledResponse = response('program-enrollments'), proposalsResponse = response('program-proposals');
  await a.click('[data-qa="program-agenda-continue"]');
  const enrollmentReply = await enrolledResponse; assert.equal(enrollmentReply.status(), 201);
  const enrollment = await enrollmentReply.json(); assert(await ownVoucher(enrollment.voucher_id)); canEnroll = false;
  const proposalReply = await proposalsResponse; assert.equal(proposalReply.status(), 200); const proposed = await proposalReply.json();
  await idle(); verifyProposals(proposed); assert.equal(proposed.pending_count, 4);
  assert.equal(await page.$$eval('[data-program-session-key]', rows => rows.length), 4);
  const assigned = await snapshot('04-assigned-zero-appointments'); assert.equal(assigned.appointments.length, 0);
  assert.equal(Number(assigned.voucher.available_units), 4); assert.equal(Number(assigned.voucher.total_units), 5);
  assert.equal(assigned.unit_movements, 0); assert.equal(assigned.receipts, 0);
  report.voucher_id = voucherId; report.checks.push('Continuación → Programas → programa empezado, N=2; anterior sin registro, 4 pendientes, sin citas ni consumo.');
  for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.waitForFunction(selector => !!document.querySelector(selector), { polling: 100 }, WIDGET);
    const dimensions = await page.$eval(WIDGET, panel => { const r = panel.getBoundingClientRect(), body = panel.querySelector('.program-agenda-body');
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: body.scrollWidth - body.clientWidth }; });
    assert(dimensions.left >= -2 && dimensions.right <= dimensions.width + 2 && dimensions.bottom <= dimensions.height + 2 && dimensions.overflow <= 2, JSON.stringify(dimensions));
    await shot('05-propuestas-' + width);
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await a.click('[data-qa-accept="qa_2"]');
  const acceptedStart = proposed.proposals.find(row => row.key === 'qa_2').solution.start_at;
  const preservesAccepted = data => {
    const row = data.proposals.find(item => item.key === 'qa_2'); assert.equal(row.placed, true);
    assert.equal(row.solution.start_at, acceptedStart, 'READJUSTING_REMAINING_MUST_NOT_MOVE_QA2');
  };
  await a.click('[data-qa-change="qa_3"]');
  const nextTimeResponse = response('program-proposals');
  await a.click('[data-program-session-key="qa_3"] button[aria-label="Siguiente hora disponible"]');
  const nextTimeReply = await nextTimeResponse; assert.equal(nextTimeReply.status(), 200); const nextTime = await nextTimeReply.json();
  await idle(); preservesAccepted(nextTime); verifyProposals(nextTime);
  assert.equal(nextTime.proposals.find(row => row.key === 'qa_3').solution.start_local.slice(0, 10),
    proposed.proposals.find(row => row.key === 'qa_3').solution.start_local.slice(0, 10));
  const nextDayResponse = response('program-proposals');
  await a.click('[data-program-session-key="qa_3"] button[aria-label="Siguiente día disponible"]');
  const nextDayReply = await nextDayResponse; assert.equal(nextDayReply.status(), 200); const nextDay = await nextDayReply.json();
  await idle(); preservesAccepted(nextDay); verifyProposals(nextDay); await shot('06-cambiar-hora-y-dia');
  const resetResponse = response('program-proposals'); await a.click(WIDGET + ' button[aria-label="Restablecer propuestas no aceptadas"]');
  const resetReply = await resetResponse; assert.equal(resetReply.status(), 200); const reset = await resetReply.json();
  await idle(); preservesAccepted(reset); verifyProposals(reset);
  assert.equal((await state()).appointments.length, 0, 'CHANGING_RESETTING_PROPOSALS_MUST_NOT_BOOK');
  report.checks.push('Cambiar qa_3 busca otra hora y otro día; restablecer sólo no aceptadas conserva qa_2 y sigue sin reservar.');
  await a.click(WIDGET + ' [data-qa="program-agenda-manual-mode"], ' + WIDGET + ' [data-qa="program-agenda-manual"]');
  await page.waitForSelector('[data-qa="program-agenda-snackbar"]', { visible: true, timeout: 30000 });
  await page.waitForSelector('[data-qa="program-agenda-provisional"][data-program-session="qa_3"][data-program-active="true"]', { visible: true, timeout: 30000 });
  await shot('07-colocar-en-agenda');
  const manualResponse = response('program-proposals');
  // Dispatch the actual DOM surface pointer pair, not a component/debug call
  // and not the ghost's click-to-accept handler. Coordinates retain its real
  // room/doctor subcolumn and move the first phase exactly 15 minutes later.
  report.manual_pointer = await page.evaluate(() => {
    const ghost = [...document.querySelectorAll('[data-qa="program-agenda-provisional"][data-program-session="qa_3"][data-program-active="true"]')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (!ghost) throw Error('ACTIVE_QA3_GHOST_REQUIRED');
    ghost.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const surface = ghost.closest('ol')?.querySelector('[data-qa="agenda-slot-surface"]');
    if (!surface) throw Error('SAME_RESOURCE_AGENDA_SURFACE_REQUIRED');
    const g = ghost.getBoundingClientRect(), r = surface.getBoundingClientRect();
    const count = Number(surface.getAttribute('data-slot-count')), rowHeight = r.height / count;
    if (!(count > 0 && rowHeight > 0)) throw Error('VALID_NATIVE_SLOT_GEOMETRY_REQUIRED');
    const startRow = Math.floor((g.top - r.top) / rowHeight), targetRow = startRow + 3;
    if (targetRow >= count) throw Error('FIFTEEN_MINUTE_SHIFT_EXCEEDS_VISIBLE_DAY');
    const x = g.left + g.width / 2, y = r.top + (targetRow + 0.5) * rowHeight;
    for (const type of ['mousedown', 'mouseup']) surface.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mousedown' ? 1 : 0, clientX: x, clientY: y,
    }));
    return { day: surface.getAttribute('data-agenda-day'), column: surface.getAttribute('data-agenda-column'),
      view: surface.getAttribute('data-agenda-view'), target_row: targetRow, shift_minutes: 15 };
  });
  const manualReply = await manualResponse; assert.equal(manualReply.status(), 200); const manuallyPlaced = await manualReply.json();
  await idle(); preservesAccepted(manuallyPlaced); verifyProposals(manuallyPlaced);
  const priorQa3 = reset.proposals.find(row => row.key === 'qa_3').solution;
  const placedQa3 = manuallyPlaced.proposals.find(row => row.key === 'qa_3').solution;
  assert.equal(Date.parse(placedQa3.start_at) - Date.parse(priorQa3.start_at), 900000);
  await page.waitForFunction(() => document.querySelector('[data-program-session-key="qa_2"]')?.getAttribute('data-accepted') === 'true'
    && document.querySelector('[data-program-session-key="qa_3"]')?.getAttribute('data-accepted') === 'true', { timeout: 15000 });
  await a.click(WIDGET + ' [data-qa="program-agenda-manual-mode"], ' + WIDGET + ' [data-qa="program-agenda-manual"]');
  await a.click(WIDGET + ' button', 'Revisar (2)'); await shot('08-revisar-solo-dos');
  assert.equal((await state()).appointments.length, 0, 'ACCEPTED_PROPOSALS_ARE_NOT_APPOINTMENTS');
  canBook = true; const bookingResponse = response('program-appointments');
  await a.click('[data-qa="program-agenda-confirm"]'); const booked = await bookingResponse; canBook = false;
  assert.equal(booked.status(), 201, 'STOP_WITHOUT_RETRY_IF_SAVE_UNCERTAIN'); await idle();
  const planReply = await read(`/api/economics/vouchers/${voucherId}/program-plan`); assert.equal(planReply.status, 200);
  assert.equal(planReply.data.pending_count, 2); assert.equal(planReply.data.sessions[0].scheduling_status, 'unrecorded');
  const saved = await snapshot('09-after-partial-booking'); assert.equal(saved.appointments.length, 2); assert.equal(saved.receipts, 1);
  assert.equal(saved.unit_movements, 0); assert.equal(Number(saved.voucher.available_units), 4); assert.equal(saved.voucher.budget_id, null);
  assert.deepEqual(saved.forbidden, initial.forbidden);
  for (const row of saved.appointments) {
    const metadata = plain(row.import_metadata); assert.equal(row.clinica_id, 1); assert.equal(row.paciente_id, PATIENT);
    assert.equal(row.source_system, 'treatment_program'); assert.equal(metadata.automation_policy, 'hold');
    for (const kind of ['appointment_details', 'day_before', 'same_day']) assert.equal(metadata.notification_suppression[kind], true);
    assert.equal(metadata.booking.phases.length, 2); assert(['qa_2', 'qa_3'].includes(metadata.program_session.key));
    const occupancy = saved.occupancies.filter(item => item.appointment_id === row.id_cita);
    assert(occupancy.length >= 4); assert(!local(row.inicio).includes('Fri'));
  }
  const [sessions] = await connection.query('SELECT session_key,position,appointment_id,consumption_movement_id FROM PatientProgramSessions WHERE voucher_id=? ORDER BY position', [saved.voucher.id]);
  assert.deepEqual(sessions.map(row => row.session_key), ['qa_2', 'qa_3']); assert(sessions.every(row => row.consumption_movement_id == null));
  report.checks.push('✓ acepta qa_2; surface down/up +15 min reubica y acepta qa_3. Se guardan sólo 2, quedan 2 y la sesión anterior sigue sin registro.');
  await shot('10-dos-reservadas'); await close();
  await page.waitForSelector('[data-qa="agenda-create-fab"]', { visible: true, timeout: 30000 });
  await a.openPatientDrawer('Paciente ficticio Prueba BS Medical'); await a.setType('Continuación');
  await a.click('[data-qa="appointment-treatment-tabs"] button', 'Programas');
  const pending = '[data-qa="appointment-pending-clinical-programs"] button';
  await page.waitForFunction(({ selector, name }) => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length && node.textContent.includes(name)), { timeout: 30000 }, { selector: pending, name: programName });
  await a.click(pending, programName); await idle();
  // Resume produces proposals only; the sole clinical save above stays unique.
  firstDay = '2026-12-03'; await preferences();
  const resumed = response('program-proposals'); await a.click('[data-qa="program-agenda-continue"]');
  const resumedReply = await resumed; assert.equal(resumedReply.status(), 200); const remaining = await resumedReply.json();
  await idle(); verifyProposals(remaining); assert.equal(remaining.pending_count, 2);
  assert.deepEqual(remaining.proposals.map(row => row.key), ['qa_4', 'qa_5']);
  const final = await snapshot('11-final-proposals-only'); assert.deepEqual(final.appointments, saved.appointments);
  assert.equal(final.receipts, 1); assert.equal(final.unit_movements, 0); assert.deepEqual(final.forbidden, initial.forbidden);
  assert.equal(posts.filter(row => row.path.endsWith('/program-enrollments')).length, 1);
  assert.equal(posts.filter(row => row.path.endsWith('/program-appointments')).length, 1);
  assert.deepEqual(report.blocked_writes, []); assert.deepEqual(report.interceptor_errors, []); assert.deepEqual(failures, []);
  report.checks.push('Retomar conserva sólo las dos pendientes; nuevas propuestas sin reservar citas adicionales.');
  report.appointment_ids = final.appointments.map(row => row.id_cita); report.final_pending_count = remaining.pending_count;
  report.page_errors = failures; await shot('12-pendientes-abiertas'); return final;
}
async function main(argv) {
  assert.equal(process.env.QA_PROGRAM_CLOSURE_DEV_WRITES, MARKER, 'EXPLICIT_SYNTHETIC_DEV_WRITE_AUTHORIZATION_REQUIRED');
  const args = {}; for (let i = 0; i < argv.length; i += 2) {
    assert(['--program-id', '--source-target-id', '--day'].includes(argv[i]) && argv[i + 1] && !args[argv[i]], 'INVALID_EXPLICIT_CLI_ARGUMENTS'); args[argv[i]] = argv[i + 1];
  }
  const programId = args['--program-id']; assert(uuid(programId), 'EXPLICIT_PREPARED_WIDGET_PROGRAM_UUID_REQUIRED');
  const firstDay = args['--day'] || '2026-11-03'; assert.equal(firstDay, '2026-11-03', 'ONLY_REVIEWED_WIDGET_DATE_ALLOWED');
  const scope = await inspect(); assertNoticeGateClosed(); process.umask(0o077);
  const connection = await connectOperatorDatabase('dev'); let browser;
  const out = fs.mkdtempSync('/home/ubuntu/qa-evidence/program-agenda-widget-dev-');
  const report = { success: false, synthetic_only: true, target: 'dev_isolated', patient_id: PATIENT, clinic_id: 1,
    program_id: programId, evidence: out, checks: [], screenshots: [], blocked_writes: [], interceptor_errors: [], blocked_socket_posts: 0 };
  try {
    const [[catalog]] = await connection.query('SELECT public_id,clinic_id,name,status,kind,version_number,notes,appointments FROM TreatmentPrograms WHERE public_id=?', [programId]);
    assert(catalog && catalog.clinic_id === 1 && catalog.name === identity.name && catalog.status === 'active'
      && catalog.kind === 'program' && catalog.version_number === 1 && catalog.notes?.includes(identity.marker)
      && plain(catalog.appointments).length === 5, 'EXACT_FRESH_WIDGET_FIXTURE_REQUIRED');
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9227', defaultViewport: null });
    const source = await browser.targets().find(target => target._targetId === (args['--source-target-id'] || SOURCE_TARGET))?.page();
    assert(source && new URL(source.url()).origin === ORIGIN, 'EXACT_AUTHENTICATED_DEV_SOURCE_TARGET_REQUIRED');
    const auth = await source.evaluate(() => Object.fromEntries(['accessToken', 'currentUser', 'userInfo', 'currentRole'].map(key => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null)));
    assert(auth.accessToken, 'NORMAL_DEV_SESSION_REQUIRED');
    const context = await browser.createBrowserContext();
    const cookies = (await source.browserContext().cookies()).filter(cookie => ['localhost', '.localhost'].includes(cookie.domain)); if (cookies.length) await context.setCookie(...cookies);
    const cdp = await browser.target().createCDPSession();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: context.id, background: true });
    const page = await (await browser.waitForTarget(target => target._targetId === targetId)).page(); await cdp.detach();
    report.browser_context_id = context.id; report.target_id = targetId;
    await page.evaluateOnNewDocument(({ origin, auth }) => { if (location.origin === origin) {
      for (const [key, value] of Object.entries(auth)) localStorage.setItem(key, value); localStorage.setItem('selectedClinicId', '1');
    } }, { origin: ORIGIN, auth });
    await page.setViewport({ width: 1440, height: 1000 });
    try { await runWidgetScenario({ page, connection, programId, firstDay, out, report }); report.success = true; report.left_open = page.url(); }
    catch (error) { report.error = error.message; await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); throw error; }
    finally {
      const after = await inspect(); assert.equal(hash(after.rooms), hash(scope.rooms)); assert.equal(hash(after.doctors), hash(scope.doctors));
      assert.equal(hash(after.existing_budgets), hash(scope.existing_budgets)); assertNoticeGateClosed();
    }
  } finally {
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await connection.end(); browser?.disconnect(); console.log(JSON.stringify({ success: report.success, evidence: out, target_id: report.target_id, error: report.error || null }));
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { allowedMutation, runWidgetScenario };
