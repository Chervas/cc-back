#!/usr/bin/env node
'use strict';

// Normal DEV session, isolated database, synthetic retained demo only. A second
// run verifies the exact two revisions; it never overwrites later human edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { normalizeValues, payloadHash } = require('../../lib/treatmentPrograms.contract');
const origin = 'http://localhost:4203', clinic = 110, marker = 'dev-clinical-workspace-v1';
const key = 'dev-program-price-revision-v1', name = 'DEMO · Seguimiento nutricional';

async function main() {
  assert.equal(process.env.QA_DEV_PROGRAM_PRICE_WRITES, key, 'EXPLICIT_SYNTHETIC_DEV_QA_REQUIRED');
  process.umask(0o077);
  const out = fs.mkdtempSync('/home/ubuntu/secure-imports/dev-program-price-revision-');
  const db = await connectOperatorDatabase('dev');
  const browser = await require('puppeteer-core').connect({ browserURL: 'http://127.0.0.1:9227', defaultViewport: null });
  let page, existing, priorClinic, failure;
  const report = { success: false, target: 'dev', synthetic_only: true, checks: [], screenshots: [], errors: [] };
  const fingerprint = async () => {
    const result = {};
    for (const table of ['Clinicas', 'Pacientes', 'Tratamientos', 'CitasPacientes', 'AppointmentBookingOccupancies',
      'PatientVouchers', 'PatientProgramSessions', 'PatientConsentDocuments', 'EconomicBudgets', 'EconomicPayments']) {
      const [rows] = await db.query('SELECT * FROM `' + table + '`');
      result[table] = { count: rows.length, sha256: hash(rows.map(row => hash(row)).sort()) };
    }
    return result;
  };
  try {
    const [[c]] = await db.query('SELECT nombre_clinica,configuracion FROM Clinicas WHERE id_clinica=?', [clinic]);
    assert.equal(c.nombre_clinica, 'Clínica multiárea · DEMO'); assert.equal(c.configuracion.qa_demo.key, marker);
    const [[t]] = await db.query('SELECT * FROM Tratamientos WHERE clinica_id=? AND nombre=?', [clinic, 'DEMO · Consulta nutricional']);
    assert.equal(t.clinical_config.qa_demo, marker); assert.equal(t.activo, 1);
    const initial = { name, kind: 'program', status: 'draft', total_price: null, cadence: null,
      appointments: [0, 7, 14].map((day, i) => ({ key: `demo_nutrition_${i + 1}`, label: `Seguimiento DEMO ${i + 1}`, treatment_ids: [t.id_tratamiento], offset_days: day })),
      notes: 'Ejemplo ficticio de revisión de precio. No es una tarifa ni pauta clínica real. No vender ni reservar.' };
    const revision = { expected_version: 1, total_price: 150, notes: initial.notes + ' Importe ficticio actualizado conservando las tres sesiones.' };
    const expected = normalizeValues(revision, { current: initial });
    const requestKey = payloadHash([clinic, key]);
    const [oldPrograms] = await db.query('SELECT * FROM TreatmentPrograms WHERE request_key IS NULL OR request_key<>? ORDER BY id', [requestKey]);
    const [oldRevisions] = await db.query('SELECT r.* FROM TreatmentProgramRevisions r JOIN TreatmentPrograms p ON p.id=r.program_id WHERE p.request_key IS NULL OR p.request_key<>? ORDER BY r.id', [requestKey]);
    const baseline = await fingerprint();
    existing = (await browser.pages()).find(p => p.url().startsWith(origin + '/') && !p.url().includes('/sign-in'));
    assert(existing, 'NORMAL_DEV_SESSION_REQUIRED'); priorClinic = await existing.evaluate(() => localStorage.getItem('selectedClinicId'));
    const call = (route, method = 'GET', payload) => existing.evaluate(async ({ route, method, payload }) => {
      const r = await fetch('/api/' + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('accessToken') }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      return { status: r.status, body: await r.json() };
    }, { route, method, payload });
    assert.equal((await call('auth/me')).status, 200);
    const preview = await call(`treatment-programs/preview?clinic_id=${clinic}`, 'POST', expected);
    assert.equal(preview.status, 200); assert.equal(preview.body.item.purchase_enabled, false);
    assert(!preview.body.item.summary.issues.some(i => i.code === 'price_required'));
    let [[row]] = await db.query('SELECT * FROM TreatmentPrograms WHERE request_key=?', [requestKey]);
    if (!row) {
      const created = await call(`treatment-programs?clinic_id=${clinic}`, 'POST', { ...initial, idempotency_key: key });
      assert.equal(created.status, 201); assert.equal(created.body.item.version, 1);
      [[row]] = await db.query('SELECT * FROM TreatmentPrograms WHERE request_key=?', [requestKey]);
    }
    assert.equal(row.clinic_id, clinic); assert.equal(row.name, name); assert.equal(row.status, 'draft');
    const route = `treatment-programs/${row.public_id}?clinic_id=${clinic}`;
    if (row.version_number === 1) {
      assert.equal(hash(normalizeValues(row)), hash(normalizeValues(initial)), 'DEMO_EDITED_DO_NOT_OVERWRITE');
      const changed = await call(route, 'PATCH', revision);
      assert.equal(changed.status, 200); assert.equal(changed.body.item.version, 2); assert.equal(changed.body.item.purchase_enabled, false);
    }
    [[row]] = await db.query('SELECT * FROM TreatmentPrograms WHERE request_key=?', [requestKey]);
    assert.equal(row.version_number, 2, 'DEMO_EDITED_DO_NOT_OVERWRITE'); assert.equal(hash(normalizeValues(row)), hash(expected));
    const stale = await call(route, 'PATCH', revision); assert.equal(stale.status, 409);
    const [revisions] = await db.query('SELECT * FROM TreatmentProgramRevisions WHERE program_id=? ORDER BY version_number', [row.id]);
    assert.deepEqual(revisions.map(r => r.version_number), [1, 2]);
    assert.equal(hash(normalizeValues(revisions[0].snapshot)), hash(normalizeValues(initial)));
    assert.equal(hash(normalizeValues(revisions[1].snapshot)), hash(expected));
    report.checks.push('Canonical preview, create/update, two SQL revisions, stale version 409; draft not purchasable');
    page = await browser.newPage(); await page.bringToFront();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.evaluateOnNewDocument(({ origin, clinic }) => { if (location.origin === origin) localStorage.setItem('selectedClinicId', String(clinic)); }, { origin, clinic });
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await page.goto(origin + '/catalogo-tratamientos/programas', { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForFunction(name => document.body.innerText.includes(name), { timeout: 20000 }, name);
      const text = await page.evaluate(() => document.body.innerText);
      assert(text.includes('150,00') || text.includes('150 €'), 'Expected synthetic price on list');
      assert(text.includes('Borrador'));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      const file = 'program-price-' + width + '.png'; await page.screenshot({ path: path.join(out, file) }); report.screenshots.push(file);
      if (width === 390) {
        await page.$eval('td.mat-column-price', cell => cell.scrollIntoView({ block: 'center', inline: 'center' }));
        const file = 'program-price-mobile-columns.png'; await page.screenshot({ path: path.join(out, file) }); report.screenshots.push(file);
      }
      await page.evaluate(name => [...document.querySelectorAll('td button')].find(button => button.textContent.trim() === name).click(), name);
      await page.waitForFunction(() => document.querySelector('mat-dialog-container input[type="number"]')?.value === '150');
      assert.equal(await page.$eval('mat-dialog-container input[type="number"]', input => input.readOnly), true);
      const detail = await page.$eval('mat-dialog-container', dialog => dialog.innerText);
      assert(detail.includes('Composición de las citas'));
      assert(await page.$$eval('mat-dialog-container input', inputs => inputs.some(input => input.value === 'Seguimiento DEMO 1')));
      await page.evaluate(async () => {
        const dialog = document.querySelector('mat-dialog-container');
        await Promise.allSettled(dialog.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const detailFile = 'program-detail-' + width + '.png'; await page.screenshot({ path: path.join(out, detailFile) }); report.screenshots.push(detailFile);
      await page.evaluate(() => [...document.querySelectorAll('mat-dialog-container button')].find(button => button.textContent.trim() === 'Cerrar').click());
      await page.waitForSelector('mat-dialog-container', { hidden: true });
    }
    report.checks.push('Published DEV program list, final price and draft status at desktop/mobile sizes');
    assert.deepEqual(await fingerprint(), baseline, 'PROTECTED_DATA_CHANGED_INSPECT_DO_NOT_RESTORE');
    const [otherPrograms] = await db.query('SELECT * FROM TreatmentPrograms WHERE request_key IS NULL OR request_key<>? ORDER BY id', [requestKey]);
    const [otherRevisions] = await db.query('SELECT r.* FROM TreatmentProgramRevisions r JOIN TreatmentPrograms p ON p.id=r.program_id WHERE p.request_key IS NULL OR p.request_key<>? ORDER BY r.id', [requestKey]);
    assert.equal(hash(otherPrograms), hash(oldPrograms)); assert.equal(hash(otherRevisions), hash(oldRevisions));
    assert.deepEqual(report.errors, []); report.protected_tables = Object.keys(baseline).length;
    report.retained_demo = { program_id: row.public_id, version: 2, price: 150, status: 'draft' }; report.success = true;
  } catch (error) {
    failure = error; report.error = error.message;
    await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  } finally {
    if (existing && priorClinic !== undefined) await existing.evaluate(({ priorClinic, clinic }) => {
      if (localStorage.getItem('selectedClinicId') === String(clinic)) priorClinic === null ? localStorage.removeItem('selectedClinicId') : localStorage.setItem('selectedClinicId', priorClinic);
    }, { priorClinic, clinic }).catch(() => {});
    await page?.close(); browser.disconnect(); await db.end();
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, evidence: out }));
  }
  if (failure) throw failure;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
