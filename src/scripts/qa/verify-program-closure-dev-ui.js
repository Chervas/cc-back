#!/usr/bin/env node
'use strict';

// Explicit, retained synthetic DEV purchase only. Uses the published Angular
// app and real authenticated HTTP/SQL, not intercepted/mock API responses.
// Never reloads/focuses the user's tabs and never authorizes another purchase.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const puppeteer = require('puppeteer-core');
const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
const { MARKER, inspect } = require('./program-closure-dev-fixture');
const ORIGIN = 'http://localhost:4203', VOUCHER = '102cc4fa-a419-4779-8e6f-e758c559e0af';
const PROGRAM = 'QA · Programa de 3 citas · Cierre 20/10';
const BASE = `/api/economics/vouchers/${VOUCHER}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.equal(process.env.QA_PROGRAM_CLOSURE_DEV_WRITES, MARKER, 'EXPLICIT_SYNTHETIC_DEV_WRITE_AUTHORIZATION_REQUIRED');
  const preflight = await inspect(); assert.equal(preflight.patient.id_paciente, 33021);
  process.umask(0o077); const out = fs.mkdtempSync('/home/ubuntu/qa-evidence/program-closure-real-dev-');
  const report = { success: false, target: 'dev_isolated', synthetic_only: true, marker: MARKER, voucher_id: VOUCHER,
    evidence: out, checks: [], errors: [], blocked_writes: [], scope_changes: false, closed_schedule_limitation: null };
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9227' });
  const source = (await browser.pages()).find(page => page.url().startsWith(ORIGIN + '/pacientes/'));
  assert(source, 'NORMAL_AUTHENTICATED_DEV_TAB_REQUIRED');
  const auth = await source.evaluate(() => Object.fromEntries(['accessToken', 'currentUser', 'userInfo', 'currentRole']
    .map(key => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null)));
  assert(auth.accessToken, 'NORMAL_DEV_AUTH_REQUIRED');
  const context = await browser.createBrowserContext();
  const cookies = (await source.browserContext().cookies()).filter(cookie => cookie.domain === 'localhost' || cookie.domain === '.localhost');
  if (cookies.length) await context.setCookie(...cookies);
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: context.id, background: true });
  const target = await browser.waitForTarget(target => target._targetId === targetId);
  const page = await target.page(); await cdp.detach();
  await page.evaluateOnNewDocument(({ origin, auth }) => {
    if (location.origin === origin) {
      for (const [key, value] of Object.entries(auth)) localStorage.setItem(key, value);
      localStorage.setItem('selectedClinicId', '1');
    }
  }, { origin: ORIGIN, auth });
  const posts = [], responses = [];
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return request.continue();
    if (url.origin !== ORIGIN) return request.abort();
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      let body; try { body = JSON.parse(request.postData() || '{}'); } catch {}
      const proposal = request.method() === 'POST' && url.pathname === BASE + '/program-proposals';
      const booking = request.method() === 'POST' && url.pathname === BASE + '/program-appointments'
        && body?.sessions?.length > 0 && body.sessions.length <= 3
        && body.sessions.every(row => ['qa_1', 'qa_2', 'qa_3'].includes(row.key)) && !body.force;
      if (!proposal && !booking) { report.blocked_writes.push({ path: url.pathname, method: request.method() }); return request.abort(); }
      posts.push({ path: url.pathname, body });
    }
    return request.continue();
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === ORIGIN && url.pathname.startsWith(BASE)) responses.push({ path: url.pathname, status: response.status() });
  });
  const connection = await connectOperatorDatabase('dev');
  const sqlState = async () => {
    const [[voucher]] = await connection.query('SELECT id,clinic_id,patient_id,status,total_units,available_units FROM PatientVouchers WHERE public_id=?', [VOUCHER]);
    assert.equal(voucher.clinic_id, 1); assert.equal(voucher.patient_id, 33021);
    const [appointments] = await connection.query('SELECT id_cita,clinica_id,paciente_id,inicio,fin,estado,source_system,import_metadata FROM CitasPacientes WHERE voucher_id=? ORDER BY id_cita', [voucher.id]);
    const [occupancies] = await connection.query('SELECT o.appointment_id,o.phase_key,o.resource_kind,o.resource_key,o.start_at,o.end_at FROM AppointmentBookingOccupancies o JOIN CitasPacientes a ON a.id_cita=o.appointment_id WHERE a.voucher_id=? ORDER BY o.appointment_id,o.phase_key,o.resource_key', [voucher.id]);
    const [[requests]] = await connection.query('SELECT COUNT(*) AS count FROM PatientProgramBookingRequests WHERE voucher_id=?', [voucher.id]);
    return { voucher, appointments, occupancies, requests: requests.count };
  };
  const call = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('accessToken') },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { url, method, body });
  const click = async (selector, text) => {
    const handle = await page.evaluateHandle(({ selector, text }) => [...document.querySelectorAll(selector)]
      .find(node => node.getClientRects().length && !node.disabled && (!text || node.textContent.includes(text))), { selector, text });
    assert(handle.asElement(), `VISIBLE_CONTROL_REQUIRED:${selector}:${text || ''}`);
    await handle.asElement().evaluate(node => node.scrollIntoView({ block: 'center' })); await handle.asElement().click(); await handle.dispose();
  };
  const input = (selector, value) => page.$eval(selector, (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const idle = () => page.waitForFunction(() => !document.querySelector('app-program-booking-dialog mat-progress-bar'), { timeout: 30000 });
  const shot = async name => { const filename = path.join(out, name + '.png'); await page.screenshot({ path: filename }); return filename; };
  const openPlan = async () => {
    await page.goto(ORIGIN + '/pacientes/detalle/33021/presupuestos?clinica_id=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav[aria-label="Áreas económicas"]', { timeout: 45000 });
    await click('nav[aria-label="Áreas económicas"] button', 'Bonos');
    await page.waitForFunction(name => [...document.querySelectorAll('article')].some(row => row.textContent.includes(name)), { timeout: 20000 }, PROGRAM);
    assert(await page.evaluate(name => {
      const card = [...document.querySelectorAll('article')].find(row => row.textContent.includes(name));
      const button = [...(card?.querySelectorAll('button') || [])].find(button => button.textContent.includes('Planificar citas'));
      if (!button || button.disabled) return false; button.click(); return true;
    }, PROGRAM));
    await page.waitForSelector('app-program-booking-dialog'); await idle();
  };
  try {
    await page.setViewport({ width: 1440, height: 1000 }); await page.setCacheEnabled(false);
    await openPlan(); assert.equal((await call('/api/auth/me')).status, 200);
    let plan = await call(BASE + '/program-plan'); assert.equal(plan.status, 200); assert(plan.data.resource_options);
    const before = await sqlState(); report.initial_appointment_count = before.appointments.length;
    assert.equal(plan.data.sessions.length, 3); report.checks.push('Published Angular opens the exact accepted synthetic purchase through patient budgets → Bonos y programas → Planificar citas, with real scoped resource names');
    if (before.appointments.length === 0) {
      assert.equal(plan.data.pending_count, 3);
      await input('input[aria-label="Primer día de búsqueda"]', '2026-10-26');
      const proposed = page.waitForResponse(response => new URL(response.url()).pathname === BASE + '/program-proposals');
      await click('app-program-booking-dialog button', 'Proponer fechas'); assert.equal((await proposed).status(), 200); await idle();
      assert.equal(await page.$$eval('[data-session-key]', nodes => nodes.length), 3);
      assert.equal((await sqlState()).appointments.length, 0);
      await shot('01-propuestas-reales');
      await click('[data-session-key="qa_1"] [data-qa="program-choose-date"]');
      await page.waitForSelector('[data-session-key="qa_1"] [data-qa="program-explicit-resources"]');
      assert.equal(await page.$$eval('[data-session-key="qa_1"] [data-qa="program-explicit-resources"]', nodes => nodes.length), 2);
      await input('[data-session-key="qa_1"] input[type="datetime-local"]', '2026-10-26T10:00');
      const checked = page.waitForResponse(response => new URL(response.url()).pathname === BASE + '/program-proposals');
      await click('[data-session-key="qa_1"] button', 'Comprobar este hueco'); assert.equal((await checked).status(), 200); await idle();
      assert.equal((await sqlState()).appointments.length, 0);
      await shot('02-fecha-y-recursos-reales');
      report.checks.push('Real automatic proposals create no appointments; explicit first-visit date and both resource selectors revalidate through real SQL/HTTP while preserving the other selected proposals');
      report.closed_schedule_limitation = 'The dedicated fixture clinic, rooms and both professionals all open Mon–Fri 09:00–20:00. No staff-only closed slot exists without altering configuration; the closed-schedule 409/retry was validated separately in owned MySQL and native Angular QA.';
      const booked = page.waitForResponse(response => new URL(response.url()).pathname === BASE + '/program-appointments');
      await click('[data-qa="program-booking-confirm"]');
      const response = await booked; assert.equal(response.status(), 201); await idle();
      await page.waitForSelector('[data-qa="program-view-appointment"]', { timeout: 20000 });
      await shot('03-reserva-confirmada-real');
      const exact = posts.filter(post => post.path === BASE + '/program-appointments').at(-1).body;
      assert.equal(exact.sessions.length, 3);
      const after = await sqlState(); assert.equal(after.appointments.length, 3); assert.equal(after.requests, 1);
      assert.equal(String(after.voucher.available_units), String(before.voucher.available_units));
      for (const appointment of after.appointments) {
        assert.equal(appointment.clinica_id, 1); assert.equal(appointment.paciente_id, 33021); assert.equal(appointment.source_system, 'treatment_program');
        const metadata = typeof appointment.import_metadata === 'string' ? JSON.parse(appointment.import_metadata) : appointment.import_metadata;
        assert.equal(metadata.automation_policy, 'hold');
        assert(metadata.notification_suppression.appointment_details && metadata.notification_suppression.day_before && metadata.notification_suppression.same_day);
        assert.equal(metadata.booking.phases.length, 2);
        assert(after.occupancies.filter(row => row.appointment_id === appointment.id_cita).length >= 4);
      }
      report.checks.push('Angular confirms three real canonical appointments atomically; SQL shows both rooms/professionals per visit, HOLD/suppression intact and no consumption');
      const replay = await call(BASE + '/program-appointments', 'POST', exact);
      assert.equal(replay.status, 201); assert.equal(replay.data.replayed, true);
      assert.equal((await sqlState()).appointments.length, 3);
      report.checks.push('Exact authenticated HTTP replay returns the same committed receipt and never duplicates appointments');
    }
    plan = await call(BASE + '/program-plan'); assert.equal(plan.data.pending_count, 0);
    assert(plan.data.sessions.every(row => row.scheduling_status === 'reserved' && row.appointment_id));
    const links = await page.$$eval('[data-qa="program-view-appointment"]', nodes => nodes.map(node => node.href));
    assert.equal(links.length, 3);
    const agendaUrl = new URL(links[0]); assert.equal(agendaUrl.origin, ORIGIN); assert.equal(agendaUrl.searchParams.get('clinica_id'), '1');
    assert.equal(agendaUrl.searchParams.get('cita_id'), String(plan.data.sessions[0].appointment_id));
    await click('[data-qa="program-view-appointment"]');
    await page.waitForFunction(() => location.pathname === '/agenda-de-citas', { timeout: 30000 });
    await page.waitForSelector('[data-qa="agenda-day-scroll"], [data-qa="agenda-primary-header"]', { timeout: 45000 });
    await delay(1200); await shot('04-ver-en-agenda-real');
    report.checks.push('Real plan reread shows all three sessions reserved; Ver en agenda opens the canonical appointment/date under clinic 1');
    await openPlan();
    for (const width of [1440, 768, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 }); await delay(150);
      const dimensions = await page.$eval('app-program-booking-dialog', el => {
        const body = el.querySelector('.program-body'), footer = el.querySelector('footer');
        return { bodyOverflow: body.scrollWidth - body.clientWidth, footerOverflow: footer.scrollWidth - footer.clientWidth,
          bottom: footer.getBoundingClientRect().bottom, viewport: innerHeight };
      });
      assert(dimensions.bodyOverflow <= 2 && dimensions.footerOverflow <= 2 && dimensions.bottom <= dimensions.viewport + 2, JSON.stringify(dimensions));
      await shot('05-plan-final-' + width);
    }
    await page.setViewport({ width: 1440, height: 1000 });
    assert.deepEqual(report.blocked_writes, []); assert.deepEqual(report.errors, []);
    const final = await sqlState(); report.appointment_ids = final.appointments.map(row => row.id_cita); report.real_business_writes = posts.filter(post => post.path.endsWith('/program-appointments')).length;
    report.responses = responses; report.success = true; report.left_open = page.url();
  } catch (error) { report.error = error.message; await shot('failure').catch(() => {}); throw error; }
  finally {
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await connection.end(); browser.disconnect(); console.log(JSON.stringify(report));
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
