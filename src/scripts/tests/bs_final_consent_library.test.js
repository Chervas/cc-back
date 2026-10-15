'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const op = require('../bs-final-consent-library');
const legacy = require('../bs-consent-catalog-withdrawal');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const copy = value => structuredClone(value);
const info = { commit: 'a'.repeat(40), pins: { fixture: 'b'.repeat(64) } };
const configuration = { database: 'fixture_crm', tls_fixture: true };
const html = '<section><h1>Documento editable de prueba</h1><p>' + 'Contenido fiel, revisado y específico del documento. '.repeat(12) + '</p></section>';
const bytes = Buffer.from(html);
function manifest() {
  return { zip_sha256: op.ZIP_SHA256, items: Array.from({ length: 44 }, (_, i) => ({
    source_sha256: i === 0 ? op.LOPD_SHA256 : hash('fixture source ' + i),
    filename: `documento-${i}.pdf`, title: `Documento ${i}`, body_html_path: `/private/body-${i}.html`,
    body_html_sha256: hash(bytes), body_json: { format: 'reviewed_text' }, review_approved: true,
  })) };
}
const sourcePackage = () => op.compilePackage(manifest(), hash('approved fixture manifest'), () => bytes);
function beforeState() {
  const templates = legacy.EXPECTED_IDS.map(id => ({ id, public_id: `old-${id}`, clinic_id: id === 2 || id === 73 ? 66 : 72,
    source_catalog_id: null, source_catalog_version_id: null, catalog_key: `old-${id}`, name: `Old template ${id}`,
    description: 'Preserved old description', purpose: legacy.DATA_PROTECTION_IDS.includes(id) ? 'data_protection' : 'clinical',
    status: legacy.DATA_PROTECTION_IDS.includes(id) ? 'active' : 'archived', blocking_policy: 'hard', validity_mode: 'manual',
    is_default: legacy.DATA_PROTECTION_IDS.includes(id) ? 1 : 0, requires_patient_signature: 1,
    requires_representative_when_minor: 1, requires_professional_signature: 0, created_by: 44,
    createdAt: '2026-01-01 10:00:00', updatedAt: '2026-10-15 02:00:00' }));
  const versions = Array.from({ length: 155 }, (_, i) => ({ id: i + 1, clinic_template_id: templates[i % 86].id,
    source_catalog_version_id: null, version: 1, locale: 'es', title: 'Preserved old version', body_json: { old: true },
    body_html: '<p>Old original</p>', variable_schema: null, status: 'published', published_at: '2026-01-01 10:00:00',
    created_by: 44, createdAt: '2026-01-01 10:00:00', updatedAt: '2026-01-01 10:00:00' }));
  const protectedState = Object.fromEntries(['requirements', 'documents', 'packages', 'treatments', 'global_catalog',
    'global_catalog_versions', 'other_clinic_templates'].map(key => [key, { count: key === 'documents' ? 1087 : key === 'packages' ? 635 : 0,
    sha256: hash('fixture protected ' + key), statuses: {} }]));
  return { identity_sha256: hash('fixture database'), configuration_sha256: hash(configuration), schema_sha256: hash('fixture schema'),
    html_capacity_bytes: 65535, actor: [{ id_usuario: 1, estado_cuenta: 'activo', es_provisional: 0 }], memberships: [],
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }], templates, versions, protected: protectedState };
}
function planFor(before = beforeState(), pkg = sourcePackage()) {
  let i = 0;
  return op.makePlan({ before, info, sourcePackage: pkg, actorId: 1,
    publicId: () => 'cclin_' + (++i).toString(16).padStart(32, '0') });
}
function appliedState(plan, mutationAt = '2026-10-15 10:00:00') {
  const after = copy(plan.before);
  for (const id of plan.privacy_archive_ids) Object.assign(after.templates.find(t => t.id === id), { status: 'archived', is_default: 0, updatedAt: mutationAt });
  plan.entries.forEach((e, i) => {
    after.templates.push(op.expectedHeader(e, 1000 + i, mutationAt));
    after.versions.push(op.expectedVersion(e, 2000 + i, 1000 + i, mutationAt));
  });
  return after;
}
function harness({ state = beforeState(), failureAtVersion = null, mutateAfter = null, backupFailure = false } = {}) {
  let current = copy(state), rollbackImage, headerId = 1000, versionId = 2000, captures = 0;
  const events = [], dml = []; let commits = 0, rollbacks = 0;
  const c = { query: async (sql, values = []) => {
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('IS_USED_LOCK')) return [[{ owned: 1 }]];
    if (sql.includes('UTC_TIMESTAMP')) return [[{ mutation_at: '2026-10-15 10:00:00' }]];
    if (sql.startsWith('INSERT INTO ClinicConsentTemplates ')) {
      dml.push('header'); events.push('dml'); const id = headerId++;
      current.templates.push({ id, ...Object.fromEntries(op.HEADER_FIELDS.map((f, i) => [f, values[i]])) });
      return [{ affectedRows: 1, insertId: id }];
    }
    if (sql.startsWith('INSERT INTO ClinicConsentTemplateVersions ')) {
      dml.push('version'); events.push('dml');
      if (dml.filter(x => x === 'version').length === failureAtVersion) throw Error('FIXTURE_VERSION_FAILURE');
      const id = versionId++, row = { id, ...Object.fromEntries(op.VERSION_FIELDS.map((f, i) => [f,
        ['body_json', 'variable_schema'].includes(f) && values[i] !== null ? JSON.parse(values[i]) : values[i]])) };
      current.versions.push(row); return [{ affectedRows: 1, insertId: id }];
    }
    if (sql.startsWith('UPDATE ClinicConsentTemplates ')) {
      dml.push('archive'); events.push('dml'); const row = current.templates.find(t => t.id === values[1]);
      if (!row || row.clinic_id !== values[2] || row.purpose !== values[3] || row.status !== values[4]
        || row.is_default !== values[5] || row.updatedAt !== values[6]) return [{ affectedRows: 0 }];
      Object.assign(row, { status: 'archived', is_default: 0, updatedAt: values[0] }); return [{ affectedRows: 1 }];
    }
    if (/^(SET TRANSACTION|SELECT RELEASE_LOCK)/.test(sql)) return [[]];
    throw Error('UNEXPECTED_FIXTURE_SQL');
  }, beginTransaction: async () => { rollbackImage = copy(current); },
  rollback: async () => { current = copy(rollbackImage); rollbacks++; },
  commit: async () => { commits++; rollbackImage = null; } };
  return { connection: c, journal: { append: async e => events.push(e.phase) },
    saveBackup: () => { if (backupFailure) throw Error('FIXTURE_BACKUP_FAILURE'); events.push('backup'); },
    captureState: async () => { captures++; if (captures === 2 && mutateAfter) mutateAfter(current); return copy(current); },
    readIndependent: async () => copy(current), state: () => copy(current), events, dml,
    commits: () => commits, rollbacks: () => rollbacks };
}
const args = (plan, h, extra = {}) => ({ ...h, plan, info, sourcePackage: plan.source_package,
  configuration, actorId: 1, backupPath: '/private/fresh-backup.json', checkSource: () => info,
  checkPackage: () => plan.source_package, ...extra });

test('exact 44 sources yield 43 clinical +1 privacy; LOPD requires all four unanswered choices', () => {
  const pkg = sourcePackage(); assert.equal(pkg.items.length, 44);
  const privacy = pkg.items.filter(i => i.purpose === 'data_protection'); assert.equal(privacy.length, 1);
  assert.equal(privacy[0].body_json.consent_form.fields.length, 4);
  assert.deepEqual(privacy[0].body_json.consent_form, op.privacyForm());
  assert.ok(privacy[0].body_json.consent_form.fields.every(f => !Object.hasOwn(f, 'answer') && f.required));
});
test('rejects changed ZIP, missing review, duplicate source, empty/generic unsafe or changed HTML', () => {
  for (const alter of [m => m.zip_sha256 = '0'.repeat(64), m => m.items[0].review_approved = false,
    m => m.items[1].source_sha256 = m.items[2].source_sha256, m => m.items[0].body_html_sha256 = '0'.repeat(64)]) {
    const m = manifest(); alter(m); assert.throws(() => op.compilePackage(m, hash('fixture'), () => bytes));
  }
  for (const body of ['<p>generic</p>', html + '<img src="data:bad">', html + '<script>bad()</script>', html + '<p onclick="bad()">x</p>']) {
    const b = Buffer.from(body), m = manifest(); m.items.forEach(i => i.body_html_sha256 = hash(b));
    assert.throws(() => op.compilePackage(m, hash('fixture'), () => b), /EDITABLE_TEXT_HTML_REQUIRED|EMBEDDED_IMAGE_INVALID/);
  }
});
test('plan pins 88 identities, no global copies/requirements; clinical defaults false and only two privacy defaults', () => {
  const p = planFor(); assert.equal(p.entries.length, 88); assert.equal(p.entries.filter(e => e.is_default).length, 2);
  assert.ok(p.entries.filter(e => e.purpose === 'clinical').every(e => e.is_default === 0));
  assert.deepEqual(p.privacy_archive_ids, [2, 73, 90, 92, 154]);
  assert.ok(p.entries.every(e => e.catalog_key === op.PREFIX + e.source_sha256 && e.created_by === 1));
  op.validatePlan(p, info, p.source_package, configuration, 1);
});
test('incomplete protected baseline, inactive actor, wrong scope and over-capacity HTML fail before planning', () => {
  for (const change of [s => s.protected.requirements.count = 1, s => s.actor[0].estado_cuenta = 'suspendido',
    s => s.clinics[0].grupoClinicaId = 30, s => s.templates[0].is_default = 0]) {
    const b = beforeState(); change(b); assert.throws(() => planFor(b));
  }
  const pkg = sourcePackage(); pkg.items[0].body_html = 'á'.repeat(40000);
  assert.throws(() => planFor(beforeState(), pkg), /LIVE_COLUMN_CAPACITY/);
});
test('plan rejects payload/package/source/actor tampering and expired preparation', () => {
  const p = planFor(), modified = copy(p); modified.entries[0].body_html += 'changed';
  assert.throws(() => op.validatePlan(modified, info, p.source_package, configuration, 1), /TAMPERED/);
  assert.throws(() => op.validatePlan(p, info, p.source_package, configuration, 44), /CHANGED/);
  assert.throws(() => op.validatePlan(p, info, p.source_package, configuration, 1, { now: Date.parse(p.generated_at) + 7200001 }), /EXPIRED/);
});
test('verification preserves all old versions/headers/custom fields and protects hashes', () => {
  const p = planFor(), a = appliedState(p); assert.equal(op.verifyAfter(p, a, '2026-10-15 10:00:00').length, 88);
  for (const change of [s => s.versions[0].body_html += 'x', s => s.templates[1].description += 'x',
    s => s.protected.documents.sha256 = 'c'.repeat(64), s => s.templates[86].is_default = 1,
    s => s.versions[155].body_json = {}, s => s.versions.push(copy(s.versions[155]))]) {
    const changed = copy(a); change(changed); assert.throws(() => op.verifyAfter(p, changed, '2026-10-15 10:00:00'));
  }
});
test('dry run performs exact 88+88+5 inside transaction, durable backup first, rollback independently verified', async () => {
  const p = planFor(), h = harness(); const receipt = await op.execute(args(p, h, { dryRun: true }));
  assert.equal(receipt.status, 'rolled_back_and_verified'); assert.equal(h.commits(), 0); assert.equal(h.rollbacks(), 1);
  assert.equal(h.dml.filter(x => x === 'header').length, 88); assert.equal(h.dml.filter(x => x === 'version').length, 88);
  assert.equal(h.dml.filter(x => x === 'archive').length, 5); assert.ok(h.events.indexOf('backup') < h.events.indexOf('dml'));
  assert.deepEqual(h.state(), p.before);
});
test('apply verifies independently and exact replay performs zero DML', async () => {
  const p = planFor(), h = harness(); const receipt = await op.execute(args(p, h));
  assert.equal(receipt.status, 'committed_and_verified'); assert.equal(h.commits(), 1);
  assert.equal(receipt.identities.length, 88); assert.equal(receipt.created_headers, 88);
  const replay = harness({ state: receipt.after }); const r = await op.execute(args(p, replay));
  assert.equal(r.status, 'replay_preserved'); assert.equal(replay.dml.length, 0); assert.equal(replay.commits(), 0);
});
test('source change/backup failure prevents any DML; midway version failure rolls all rows back', async () => {
  const p = planFor(); const b = harness({ backupFailure: true });
  await assert.rejects(op.execute(args(p, b))); assert.equal(b.dml.length, 0);
  const s = harness(); await assert.rejects(op.execute(args(p, s, { checkSource: () => ({ commit: 'changed' }) })), /SOURCE_OR_PACKAGE_CHANGED/);
  assert.equal(s.dml.length, 0);
  const h = harness({ failureAtVersion: 31 }); await assert.rejects(op.execute(args(p, h)));
  assert.equal(h.commits(), 0); assert.equal(h.dml.filter(x => x === 'archive').length, 0); assert.deepEqual(h.state(), p.before);
});
test('post-write protected-data drift prevents commit and exact partial replay cannot widen scope', async () => {
  const p = planFor(), h = harness({ mutateAfter: s => s.protected.packages.sha256 = 'd'.repeat(64) });
  await assert.rejects(op.execute(args(p, h)), /PROTECTED_STATE/); assert.equal(h.commits(), 0); assert.deepEqual(h.state(), p.before);
  const partial = appliedState(p); partial.templates.pop(); const replay = harness({ state: partial });
  await assert.rejects(op.execute(args(p, replay))); assert.equal(replay.dml.length, 0);
});
test('CLI requires CRM target, exact source package approval and actual actor', () => {
  const base = ['--mode', 'prepare', '--target', 'crm', '--package', '/private/package.json', '--approved-package-sha256', 'f'.repeat(64), '--actor-id', '1', '--private-output', '/private/plan.json'];
  assert.equal(op.parseOptions(base)['--actor-id'], '1');
  assert.throws(() => op.parseOptions(base.map(x => x === 'crm' ? 'dev' : x)));
  assert.throws(() => op.parseOptions(base.filter((_, i) => ![8, 9].includes(i))));
});
test('bounded native inline logos/illustrations are allowed, never external sources or SVG/events', () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
  op.validateEmbeddedImages(`<img width="83" alt="Logotipo" src="data:image/png;base64,${png}">`);
  op.validateEmbeddedImages(`<style>.logo{background-image:url("data:image/png;base64,${png}")}</style>`);
  for (const body of ['<img src="https://external.test/image.png">', '<img src="data:image/svg+xml;base64,AA==">',
    `<img src="data:image/png;base64,${png}" srcset="https://external.test/x">`, '<img src="data:image/png;base64,YmFk">',
    `<img src="data:image/png;base64,${png}" onerror="bad()">`, '<style>.logo{background:url(https://external.test/x)}</style>',
    '<style>.logo{background:url(https://external.test/x</style>',
    Array.from({ length: 13 }, () => `<img src="data:image/png;base64,${png}">`).join('')]) {
    assert.throws(() => op.validateEmbeddedImages(body), /EMBEDDED_IMAGE/);
  }
});
test('fresh real document/package counts are captured, not rejected by stale hardcoded live totals', () => {
  const b = beforeState(); b.protected.documents.count = 1095; b.protected.packages.count = 641;
  const p = planFor(b); assert.equal(p.before.protected.documents.count, 1095);
  const after = appliedState(p); op.verifyAfter(p, after, '2026-10-15 10:00:00');
  after.protected.documents.count++; assert.throws(() => op.verifyAfter(p, after, '2026-10-15 10:00:00'), /PROTECTED_STATE/);
});
