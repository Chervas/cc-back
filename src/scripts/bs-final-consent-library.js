#!/usr/bin/env node
'use strict';

// Standalone operator: no models/app bootstrap, hooks, jobs, signatures or sends.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const legacy = require('./bs-consent-catalog-withdrawal');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readBytes, writePrivateJson, parseArgs, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');
const { isGlobalAdmin } = require('../lib/role-helpers');
const choices = require('../lib/consent-document-choices');

const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'bs-final-consent-library/1';
const ZIP_SHA256 = '7aa5b5e1599c397aeac194dc1b5d74226d3b20d3f9125b12dc0cef60fc34d118';
const LOPD_SHA256 = 'e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f';
const PREFIX = 'bs-final-20261015-';
const LOCK_KEY = legacy.LOCK_KEY;
const HEADER_FIELDS = Object.freeze(['public_id', 'clinic_id', 'source_catalog_id', 'source_catalog_version_id', 'catalog_key',
  'name', 'description', 'purpose', 'status', 'blocking_policy', 'validity_mode', 'is_default',
  'requires_patient_signature', 'requires_representative_when_minor', 'requires_professional_signature', 'created_by', 'createdAt', 'updatedAt']);
const VERSION_FIELDS = Object.freeze(['clinic_template_id', 'source_catalog_version_id', 'version', 'locale', 'title',
  'body_json', 'body_html', 'variable_schema', 'status', 'published_at', 'created_by', 'createdAt', 'updatedAt']);
const PIN_FILES = Object.freeze([...new Set([...legacy.PIN_FILES, 'src/scripts/bs-final-consent-library.js',
  'src/scripts/tests/bs_final_consent_library.test.js', 'src/lib/consent-document-choices.js',
  'src/lib/role-helpers.js', 'src/lib/databaseTlsConfig.js'])]);
const POLICY = Object.freeze({ sources: 44, new_headers: 88, new_published_versions: 88,
  archive_old_privacy_headers: 5, old_versions_unchanged: true, patient_documents_unchanged: true,
  packages_and_signatures_unchanged: true, requirements_remain_zero: true, treatments_unchanged: true,
  global_catalog_unchanged: true, no_treatment_associations: true, no_dispatch: true,
  clinical_defaults_disabled: true, privacy_only_default: true, no_automatic_restore_over_later_edits: true });
const fail = code => { throw Error('BS_FINAL_CONSENT_' + code); };
const equal = (a, b) => hash(a) === hash(b);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sorted = rows => [...rows].sort((a, b) => Number(a.id) - Number(b.id));
const at = value => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value || '');

function source() {
  const info = legacy.source();
  for (const file of PIN_FILES) {
    const filename = path.join(ROOT, file), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename
      || hash(readBytes(filename)) !== hash(execFileSync('git', ['show', `${info.commit}:${file}`], { maxBuffer: 32 * 1024 * 1024 }))) fail('SOURCE_NOT_COMMITTED');
    info.pins[file] = hash(readBytes(filename));
  }
  return info;
}
function privatePath(filename, { existing = false } = {}) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_PATH_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(root + path.sep)) fail('PRIVATE_PATH_REQUIRED');
  for (const dir of [root, parent]) {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077) fail('PRIVATE_PERMISSIONS_INVALID');
  }
  const resolved = path.join(parent, path.basename(filename));
  if (existing) {
    const s = fs.lstatSync(resolved);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077) fail('PRIVATE_FILE_INVALID');
  }
  return resolved;
}
function privacyForm() {
  return choices.validateForm({ schema_version: choices.CHOICE_SCHEMA_VERSION,
    fields: choices.CHOICE_KEYS.map(key => ({ key, type: 'yes_no', required: true, label: choices.CHOICE_LABELS[key] })) });
}
function validateEmbeddedImages(html) {
  let count = 0, total = 0;
  const imageData = uri => {
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if (!match || match[2].length % 4) fail('EMBEDDED_IMAGE_INVALID');
    const bytes = Buffer.from(match[2], 'base64');
    const magic = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : match[1] === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!magic || bytes.toString('base64') !== match[2] || bytes.length > 512 * 1024
      || ++count > 12 || (total += bytes.length) > 2 * 1024 * 1024) fail('EMBEDDED_IMAGE_INVALID');
  };
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    let attributes = match[1].replace(/\/\s*$/, ''), src = null;
    const seen = new Set(), attribute = /\s+([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/iy;
    while (attributes.trim()) {
      attribute.lastIndex = 0; const a = attribute.exec(attributes);
      if (!a) fail('EMBEDDED_IMAGE_ATTRIBUTES_INVALID');
      const key = a[1].toLowerCase(), value = a[2] ?? a[3];
      if (seen.has(key) || !['src', 'width', 'height', 'alt', 'title', 'class', 'style'].includes(key)
        || /[<>]|javascript\s*:|expression\s*\(|behavior\s*:/i.test(value)) fail('EMBEDDED_IMAGE_ATTRIBUTES_INVALID');
      seen.add(key); if (key === 'src') src = value;
      if (['width', 'height'].includes(key) && !/^(?:\d{1,4}|100%)$/.test(value)) fail('EMBEDDED_IMAGE_ATTRIBUTES_INVALID');
      attributes = attributes.slice(a[0].length);
    }
    if (!src) fail('EMBEDDED_IMAGE_INVALID'); imageData(src);
  }
  // Native logos/clinical illustrations may be inline data URLs, never an
  // external fetch or an attached original/scanned-page gallery substitute.
  const cssUrl = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  for (const match of html.matchAll(cssUrl)) imageData((match[1] ?? match[2] ?? match[3]).trim());
  if (/url\s*\(/i.test(html.replace(cssUrl, ''))) fail('EMBEDDED_IMAGE_INVALID');
  if (/<img\b/i.test(html.replace(/<img\b[^>]*>/gi, ''))) fail('EMBEDDED_IMAGE_INVALID');
}
function compilePackage(manifest, packageSha256, readBody) {
  if (!sha(packageSha256) || manifest?.zip_sha256 !== ZIP_SHA256 || !Array.isArray(manifest.items)
    || manifest.items.length !== 44 || new Set(manifest.items.map(i => i.source_sha256)).size !== 44
    || manifest.items.filter(i => i.source_sha256 === LOPD_SHA256).length !== 1) fail('EXACT_REVIEWED_PACKAGE_REQUIRED');
  const items = manifest.items.map(item => {
    if (!sha(item.source_sha256) || !sha(item.body_html_sha256) || item.review_approved !== true
      || typeof item.title !== 'string' || item.title.trim() !== item.title || !item.title || item.title.length > 255
      || typeof item.filename !== 'string' || !item.filename.trim() || item.filename.length > 512
      || /[\x00-\x1f]/.test(item.filename + item.title) || !object(item.body_json)) fail('SOURCE_ITEM_INVALID');
    const bytes = readBody(item.body_html_path);
    if (!Buffer.isBuffer(bytes) || hash(bytes) !== item.body_html_sha256 || bytes.length > 16 * 1024 * 1024) fail('SOURCE_HTML_HASH_CHANGED');
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes), plain = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length < 100 || !/<(?:p|h[1-6]|section|article)\b/i.test(html)
      || /<(?:script|iframe|object|embed|svg|canvas|base|link|video|audio|source|form|input|meta)\b|\son[a-z]+\s*=|javascript\s*:|@import|expression\s*\(|behavior\s*:/i.test(html)) fail('SOURCE_EDITABLE_TEXT_HTML_REQUIRED');
    validateEmbeddedImages(html);
    const privacy = item.source_sha256 === LOPD_SHA256, form = privacyForm();
    if (!privacy && Object.hasOwn(item.body_json, 'consent_form')) fail('CLINICAL_CHOICE_FORM_NOT_ALLOWED');
    if (privacy && Object.hasOwn(item.body_json, 'consent_form') && !equal(choices.validateForm(item.body_json.consent_form), form)) fail('PRIVACY_CHOICES_CHANGED');
    return { source_sha256: item.source_sha256, filename: item.filename, title: item.title,
      body_html_sha256: item.body_html_sha256, body_html: html,
      body_json: privacy ? { ...item.body_json, consent_form: form } : item.body_json,
      purpose: privacy ? 'data_protection' : 'clinical', catalog_key: PREFIX + item.source_sha256 };
  }).sort((a, b) => a.source_sha256.localeCompare(b.source_sha256));
  return { package_sha256: packageSha256, zip_sha256: ZIP_SHA256, items };
}
function loadPackage(filename, approvedSha256) {
  privatePath(filename, { existing: true });
  const bytes = readBytes(filename);
  if (!sha(approvedSha256) || hash(bytes) !== approvedSha256) fail('EXACT_PACKAGE_APPROVAL_REQUIRED');
  return compilePackage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), approvedSha256,
    filename => readBytes(privatePath(filename, { existing: true })));
}

async function capture(c, configuration, { actorId, lock = false } = {}) {
  const q = async (sql, values = [], limit = 10000) => {
    const [rows] = await c.query(sql, values);
    if (!Array.isArray(rows) || rows.length > limit) fail('BOUNDED_SCOPE_EXCEEDED');
    return rows;
  };
  const [identity] = await q('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name');
  if (identity?.database_name !== configuration.database) fail('DATABASE_IDENTITY_CHANGED');
  const tables = await q('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [legacy.TABLES]);
  const columns = await q('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_OCTET_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION', [legacy.TABLES]);
  const indexes = await q('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', [legacy.TABLES]);
  const triggers = await q("SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('ClinicConsentTemplates','ClinicConsentTemplateVersions') ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME");
  const foreignKeys = await q("SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('ClinicConsentTemplates','ClinicConsentTemplateVersions') AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,COLUMN_NAME");
  if (legacy.TABLES.some(name => !tables.some(t => t.TABLE_NAME === name && t.ENGINE === 'InnoDB')) || triggers.length) fail('TRANSACTIONAL_SCHEMA_OR_TRIGGERS_INVALID');
  const fields = table => columns.filter(c => c.TABLE_NAME === table).map(c => c.COLUMN_NAME).sort();
  if (!equal(fields('ClinicConsentTemplates'), ['id', ...HEADER_FIELDS].sort())
    || !equal(fields('ClinicConsentTemplateVersions'), ['id', ...VERSION_FIELDS].sort())) fail('EXACT_COLUMNS_CHANGED');
  const capacity = Number(columns.find(c => c.TABLE_NAME === 'ClinicConsentTemplateVersions' && c.COLUMN_NAME === 'body_html')?.CHARACTER_OCTET_LENGTH);
  if (!Number.isSafeInteger(capacity) || capacity < 65535) fail('HTML_CAPACITY_UNKNOWN');
  const share = lock ? ' LOCK IN SHARE MODE' : '', update = lock ? ' FOR UPDATE' : '';
  const actor = await q('SELECT id_usuario,estado_cuenta,es_provisional FROM Usuarios WHERE id_usuario=?' + share, [actorId], 1);
  const memberships = await q('SELECT id_usuario,id_clinica,rol_clinica,estado_invitacion FROM UsuarioClinica WHERE id_usuario=? AND id_clinica IN (66,72) ORDER BY id_clinica' + share, [actorId], 2);
  const clinics = await q('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica' + share, [], 2);
  const templates = await q('SELECT * FROM ClinicConsentTemplates WHERE clinic_id IN (66,72) ORDER BY id LIMIT 175' + update, [], 174);
  const ids = templates.map(r => r.id);
  const versions = await q('SELECT * FROM ClinicConsentTemplateVersions WHERE clinic_template_id IN (?) ORDER BY id LIMIT 244' + update, [ids], 243);
  const protectedState = {};
  const queries = {
    requirements: ['SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN (66,72) OR clinic_template_id IN (?) ORDER BY id', [ids]],
    documents: ['SELECT * FROM PatientConsentDocuments WHERE clinica_id IN (66,72) OR clinic_template_id IN (?) ORDER BY id', [ids]],
    packages: ['SELECT * FROM ConsentSignaturePackages WHERE clinica_id IN (66,72) OR id IN (SELECT package_id FROM PatientConsentDocuments WHERE clinic_template_id IN (?)) ORDER BY id', [ids]],
    treatments: ['SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) ORDER BY id_tratamiento', []],
    global_catalog: ['SELECT * FROM ConsentTemplateCatalogs ORDER BY id', []],
    global_catalog_versions: ['SELECT * FROM ConsentTemplateCatalogVersions ORDER BY id', []],
    other_clinic_templates: ['SELECT * FROM ClinicConsentTemplates WHERE clinic_id NOT IN (66,72) ORDER BY id', []],
  };
  // Patient data never enters backup/receipt, only complete ordered-row hashes.
  for (const [key, [sql, values]] of Object.entries(queries)) protectedState[key] = legacy.digest(await q(sql + ' LIMIT 10001' + share, values));
  return { identity_sha256: hash(identity), configuration_sha256: hash(configuration), schema_sha256: hash({ tables, columns, indexes, triggers, foreignKeys }),
    html_capacity_bytes: capacity, actor, memberships, clinics, templates, versions, protected: protectedState };
}
function validateState(state, actorId) {
  if (!positive(actorId) || state.actor?.length !== 1 || Number(state.actor[0].id_usuario) !== Number(actorId)
    || state.actor[0].estado_cuenta !== 'activo' || Number(state.actor[0].es_provisional) !== 0
    || (!isGlobalAdmin(actorId) && ![66, 72].every(id => state.memberships?.some(m => Number(m.id_clinica) === id && m.rol_clinica === 'propietario' && m.estado_invitacion === 'aceptada')))) fail('ACTIVE_AUTHORIZED_ACTOR_REQUIRED');
  if (!equal(state.clinics, [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }])
    || !Array.isArray(state.templates) || !Array.isArray(state.versions)
    || ![86, 174].includes(state.templates.length) || ![155, 243].includes(state.versions.length)
    || !equal(state.templates.map(r => r.id), [...new Set(state.templates.map(r => r.id))].sort((a, b) => a - b))
    || !equal(state.versions.map(r => r.id), [...new Set(state.versions.map(r => r.id))].sort((a, b) => a - b))
    || !sha(state.schema_sha256) || !sha(state.identity_sha256) || !sha(state.configuration_sha256)) fail('EXACT_STATE_INVALID');
  if (state.protected?.requirements?.count !== 0
    || !equal(Object.keys(state.protected), ['requirements', 'documents', 'packages', 'treatments', 'global_catalog', 'global_catalog_versions', 'other_clinic_templates'])
    || Object.values(state.protected).some(v => !sha(v.sha256) || !Number.isInteger(v.count) || v.count < 0)) fail('PROTECTED_BASELINE_CHANGED');
}
function makePlan({ before, info, sourcePackage, actorId, generatedAt = new Date().toISOString(), publicId = () => 'cclin_' + crypto.randomUUID().replace(/-/g, '') }) {
  validateState(before, actorId);
  if (before.templates.length !== 86 || before.versions.length !== 155 || !equal(before.templates.map(t => t.id), legacy.EXPECTED_IDS)
    || before.templates.some(t => legacy.DATA_PROTECTION_IDS.includes(t.id)
      ? t.purpose !== 'data_protection' || t.status !== 'active' || Number(t.is_default) !== 1
      : t.status !== 'archived' || Number(t.is_default) !== 0)
    || !Number.isFinite(Date.parse(generatedAt))) fail('EXACT_PRE_IMPORT_BASELINE_REQUIRED');
  if (sourcePackage?.zip_sha256 !== ZIP_SHA256 || sourcePackage.items?.length !== 44 || !sha(sourcePackage.package_sha256)) fail('PACKAGE_INVALID');
  const entries = [];
  for (const clinicId of [66, 72]) for (const item of sourcePackage.items) {
    if (Buffer.byteLength(item.body_html, 'utf8') > before.html_capacity_bytes) fail('HTML_EXCEEDS_LIVE_COLUMN_CAPACITY');
    const privacy = item.purpose === 'data_protection';
    entries.push({ source_sha256: item.source_sha256, clinic_id: clinicId, public_id: publicId(), catalog_key: item.catalog_key,
      name: item.title, description: `Fuente final aportada: ${item.filename}. SHA-256 ${item.source_sha256}. ZIP ${ZIP_SHA256}. Biblioteca editable; sin asociación automática a tratamientos.`,
      purpose: item.purpose, status: 'active', blocking_policy: 'hard', validity_mode: privacy ? 'manual' : 'single_act',
      is_default: privacy ? 1 : 0, requires_patient_signature: 1, requires_representative_when_minor: 1,
      requires_professional_signature: 0, created_by: Number(actorId), title: item.title, body_json: item.body_json,
      body_html: item.body_html, body_html_sha256: item.body_html_sha256, variable_schema: null });
  }
  if (new Set(entries.map(e => e.public_id)).size !== 88 || entries.some(e => !/^cclin_[a-f0-9]{32}$/.test(e.public_id))
    || entries.filter(e => e.purpose === 'data_protection').length !== 2) fail('PREPARED_IDENTITIES_INVALID');
  const body = { version: VERSION, target: 'crm', group_id: 29, clinic_ids: [66, 72], generated_at: generatedAt,
    source: info, source_package: sourcePackage, source_package_sha256: hash(sourcePackage), actor_id: Number(actorId),
    before, before_sha256: hash(before), entries, privacy_archive_ids: legacy.DATA_PROTECTION_IDS, policy: POLICY };
  return { ...body, plan_sha256: hash(body) };
}
function validatePlan(plan, info, sourcePackage, configuration, actorId, { requireFresh = true, now = Date.now() } = {}) {
  if (plan?.version !== VERSION || plan.target !== 'crm' || !equal(plan.source, info) || !equal(plan.source_package, sourcePackage)
    || plan.before?.configuration_sha256 !== hash(configuration) || Number(plan.actor_id) !== Number(actorId)) fail('PLAN_SOURCE_TARGET_OR_PACKAGE_CHANGED');
  let i = 0;
  const expected = makePlan({ before: plan.before, info, sourcePackage, actorId, generatedAt: plan.generated_at, publicId: () => plan.entries[i++]?.public_id });
  if (!equal(plan, expected)) fail('PLAN_TAMPERED');
  const generated = Date.parse(plan.generated_at);
  if (!Number.isFinite(generated) || generated > now || requireFresh && now - generated > 7200000) fail('PLAN_EXPIRED');
}
function expectedHeader(entry, id, mutationAt) {
  const row = { id };
  for (const field of HEADER_FIELDS) row[field] = ['createdAt', 'updatedAt'].includes(field) ? mutationAt
    : ['source_catalog_id', 'source_catalog_version_id'].includes(field) ? null : entry[field];
  return row;
}
function expectedVersion(entry, id, headerId, mutationAt) {
  return { id, clinic_template_id: headerId, source_catalog_version_id: null, version: 1, locale: 'es', title: entry.title,
    body_json: entry.body_json, body_html: entry.body_html, variable_schema: null, status: 'published', published_at: mutationAt,
    created_by: entry.created_by, createdAt: mutationAt, updatedAt: mutationAt };
}
function verifyAfter(plan, after, mutationAt) {
  validateState(after, plan.actor_id);
  if (!at(mutationAt)) fail('MUTATION_TIMESTAMP_INVALID');
  const oldIds = new Set(plan.before.templates.map(t => t.id));
  const newHeaders = after.templates.filter(t => !oldIds.has(t.id)), newVersions = [];
  if (newHeaders.length !== 88 || new Set(newHeaders.map(t => t.public_id)).size !== 88) fail('EXACT_NEW_HEADERS_REQUIRED');
  const headers = plan.before.templates.map(t => plan.privacy_archive_ids.includes(t.id) ? { ...t, status: 'archived', is_default: 0, updatedAt: mutationAt } : t);
  for (const entry of plan.entries) {
    const h = newHeaders.find(t => t.public_id === entry.public_id);
    if (!h || !positive(h.id) || !equal(h, expectedHeader(entry, h.id, mutationAt))) fail('NEW_HEADER_CHANGED');
    const versions = after.versions.filter(v => v.clinic_template_id === h.id);
    if (versions.length !== 1 || !positive(versions[0].id) || !equal(versions[0], expectedVersion(entry, versions[0].id, h.id, mutationAt))) fail('NEW_VERSION_CHANGED');
    headers.push(h); newVersions.push(versions[0]);
  }
  const expected = { ...plan.before, templates: sorted(headers), versions: sorted([...plan.before.versions, ...newVersions]) };
  if (!equal(expected, after)) fail('PROTECTED_STATE_OR_OLD_ROWS_CHANGED');
  return newHeaders.map(t => ({ id: t.id, public_id: t.public_id, clinic_id: t.clinic_id, catalog_key: t.catalog_key,
    version_id: newVersions.find(v => v.clinic_template_id === t.id).id }));
}
async function independentCapture(configuration, actorId) {
  const c = await connectOperatorDatabase('crm');
  try { await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); const s = await capture(c, configuration, { actorId }); await c.rollback(); return s; }
  finally { await c.end(); }
}
async function execute({ connection: c, plan, info, sourcePackage, configuration, actorId, dryRun = false, backupPath, journal,
  captureState = capture, readIndependent = independentCapture, checkSource = source, checkPackage, saveBackup = writePrivateJson }) {
  validatePlan(plan, info, sourcePackage, configuration, actorId);
  if (typeof checkPackage !== 'function') fail('FRESH_PACKAGE_READER_REQUIRED');
  const [[lock]] = await c.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK_KEY]);
  if (Number(lock?.acquired) !== 1) fail('ANOTHER_OPERATOR_ACTIVE');
  let transaction = false, commitAttempted = false;
  const fresh = () => { if (!equal(checkSource(), info) || !equal(checkPackage(), sourcePackage)) fail('SOURCE_OR_PACKAGE_CHANGED'); };
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await c.beginTransaction(); transaction = true;
    const before = await captureState(c, configuration, { actorId, lock: true }); validateState(before, actorId);
    if (!equal(before, plan.before)) {
      const mutationAt = before.templates.find(t => t.public_id === plan.entries[0].public_id)?.createdAt;
      const identities = verifyAfter(plan, before, mutationAt); fresh();
      await c.rollback(); transaction = false;
      const current = await readIndependent(configuration, actorId);
      if (!equal(current, before)) fail('REPLAY_READBACK_CHANGED');
      await journal.append({ phase: 'exact_replay_preserved_no_dml', after_sha256: hash(current) });
      return { version: VERSION + ':receipt', status: 'replay_preserved', plan_sha256: plan.plan_sha256, source: info,
        package_sha256: sourcePackage.package_sha256, mutation_at: mutationAt, identities, after: current, after_sha256: hash(current),
        created_headers: 0, created_versions: 0, archived_privacy_headers: 0, policy: POLICY };
    }
    const [[clock]] = await c.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS mutation_at");
    const mutationAt = clock?.mutation_at;
    if (!at(mutationAt)) fail('MUTATION_TIMESTAMP_INVALID');
    const backup = { version: VERSION + ':backup', plan_sha256: plan.plan_sha256, source: info,
      package_sha256: sourcePackage.package_sha256, mutation_at: mutationAt, before, before_sha256: hash(before),
      restoration_policy: 'Manual reviewed compensation only after exact after-image comparison. Preserve patient evidence and later edits; no automatic broad rollback.' };
    saveBackup(backupPath, backup);
    await journal.append({ phase: 'full_headers_versions_backup_durable_before_dml', backup_path: backupPath,
      backup_sha256: hash(backup), new_headers: 88, new_versions: 88, old_privacy_headers: plan.privacy_archive_ids });
    fresh();
    const [[ownership]] = await c.query('SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS owned', [LOCK_KEY]);
    if (Number(ownership?.owned) !== 1) fail('OPERATOR_LOCK_LOST');
    const identities = [];
    for (const entry of plan.entries) {
      const row = expectedHeader(entry, null, mutationAt); delete row.id;
      const [h] = await c.query('INSERT INTO ClinicConsentTemplates (' + HEADER_FIELDS.map(f => '`' + f + '`').join(',')
        + ') VALUES (' + HEADER_FIELDS.map(() => '?').join(',') + ')', HEADER_FIELDS.map(f => row[f]));
      if (Number(h?.affectedRows) !== 1 || !positive(h.insertId)) fail('HEADER_INSERT_FAILED');
      const v = expectedVersion(entry, null, Number(h.insertId), mutationAt); delete v.id;
      const [version] = await c.query('INSERT INTO ClinicConsentTemplateVersions (' + VERSION_FIELDS.map(f => '`' + f + '`').join(',')
        + ') VALUES (' + VERSION_FIELDS.map(() => '?').join(',') + ')', VERSION_FIELDS.map(f => ['body_json', 'variable_schema'].includes(f) && v[f] !== null ? JSON.stringify(v[f]) : v[f]));
      if (Number(version?.affectedRows) !== 1 || !positive(version.insertId)) fail('VERSION_INSERT_FAILED');
      identities.push({ id: Number(h.insertId), version_id: Number(version.insertId), public_id: entry.public_id, clinic_id: entry.clinic_id, catalog_key: entry.catalog_key });
    }
    // New defaults and all 88 published bodies exist before retiring privacy;
    // none become visible outside this atomic transaction until COMMIT.
    for (const id of plan.privacy_archive_ids) {
      const row = before.templates.find(t => t.id === id);
      const [r] = await c.query("UPDATE ClinicConsentTemplates SET status='archived',is_default=0,updatedAt=? WHERE id=? AND clinic_id=? AND purpose=? AND status=? AND is_default=? AND updatedAt <=> ?",
        [mutationAt, id, row.clinic_id, row.purpose, row.status, row.is_default, row.updatedAt]);
      if (Number(r?.affectedRows) !== 1) fail('OLD_PRIVACY_CAS_FAILED');
    }
    const after = await captureState(c, configuration, { actorId, lock: true });
    const checkedIdentities = verifyAfter(plan, after, mutationAt);
    if (!equal(sorted(identities), sorted(checkedIdentities))) fail('INSERT_IDENTITIES_CHANGED');
    fresh(); await journal.append({ phase: 'exact_new_library_and_unchanged_patient_evidence_verified', mutation_at: mutationAt,
      identities, after_sha256: hash(after), protected: after.protected });
    if (dryRun) {
      await c.rollback(); transaction = false;
      const current = await readIndependent(configuration, actorId);
      if (!equal(current, before)) fail('ROLLBACK_OR_CONCURRENT_EVIDENCE_CHANGED');
      await journal.append({ phase: 'dry_run_rolled_back_and_independently_verified', final_sha256: hash(current) });
      return { version: VERSION + ':receipt', status: 'rolled_back_and_verified', plan_sha256: plan.plan_sha256,
        source: info, package_sha256: sourcePackage.package_sha256, mutation_at: mutationAt, after, after_sha256: hash(after),
        final_sha256: hash(current), identities, created_headers: 0, created_versions: 0, archived_privacy_headers: 0, policy: POLICY };
    }
    commitAttempted = true; await c.commit(); transaction = false;
    await journal.append({ phase: 'committed', after_sha256: hash(after), identities });
    const current = await readIndependent(configuration, actorId); verifyAfter(plan, current, mutationAt);
    if (!equal(current, after)) fail('INDEPENDENT_READBACK_CHANGED');
    await journal.append({ phase: 'committed_and_independently_verified', after_sha256: hash(current), protected: current.protected });
    return { version: VERSION + ':receipt', status: 'committed_and_verified', plan_sha256: plan.plan_sha256, source: info,
      package_sha256: sourcePackage.package_sha256, mutation_at: mutationAt, identities, after: current, after_sha256: hash(current),
      created_headers: 88, created_versions: 88, archived_privacy_headers: 5, policy: POLICY };
  } catch (error) {
    if (transaction) await c.rollback().catch(() => {});
    await journal.append({ phase: commitAttempted ? 'commit_result_requires_manual_review_no_blind_retry' : 'rolled_back_without_commit_attempt',
      error_code: /^BS_FINAL_CONSENT_[A-Z_]+$/.test(error.message) ? error.message : 'BOUNDED_OPERATOR_FAILED' }).catch(() => {});
    if (commitAttempted) fail('COMMIT_OUTCOME_REQUIRES_PRIVATE_JOURNAL_REVIEW');
    throw error;
  } finally { await c.query('SELECT RELEASE_LOCK(?)', [LOCK_KEY]).catch(() => {}); }
}
function parseOptions(args) {
  const o = parseArgs(args, ['--mode', '--target', '--package', '--approved-package-sha256', '--actor-id', '--private-output',
    '--plan', '--approved-plan-sha256', '--private-backup', '--private-journal', '--receipt']);
  if (!['prepare', 'dry-run', 'apply', 'check'].includes(o['--mode']) || o['--target'] !== 'crm'
    || !o['--package'] || !sha(o['--approved-package-sha256']) || !positive(o['--actor-id']) || !o['--private-output']) fail('EXPLICIT_MODE_TARGET_PACKAGE_ACTOR_REQUIRED');
  return o;
}
async function run(args) {
  const o = parseOptions(args), mode = o['--mode'], actorId = Number(o['--actor-id']);
  privatePath(o['--private-output']);
  const sourcePackage = loadPackage(o['--package'], o['--approved-package-sha256']), info = source(), configuration = databaseOptions('crm');
  let plan;
  if (mode !== 'prepare') { plan = privateJson(o['--plan']); validatePlan(plan, info, sourcePackage, configuration, actorId, { requireFresh: mode !== 'check' }); }
  if (['apply', 'dry-run'].includes(mode)) {
    if (o['--approved-plan-sha256'] !== plan.plan_sha256 || !o['--private-backup'] || !o['--private-journal']) fail('EXACT_APPROVAL_BACKUP_JOURNAL_REQUIRED');
    const paths = [o['--private-output'], o['--private-backup'], o['--private-journal']].map(p => privatePath(p));
    if (new Set(paths).size !== 3 || paths.some(p => fs.existsSync(p))) fail('FRESH_DISTINCT_ARTIFACTS_REQUIRED');
  }
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    await c.query('SET SESSION lock_wait_timeout=10');
    if (mode === 'prepare' || mode === 'check') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const state = await capture(c, configuration, { actorId }); validateState(state, actorId); await c.rollback();
      if (mode === 'prepare') {
        plan = makePlan({ before: state, info, sourcePackage, actorId }); writePrivateJson(o['--private-output'], plan);
        return { status: 'prepared_read_only', plan_sha256: plan.plan_sha256, package_sha256: sourcePackage.package_sha256, policy: POLICY };
      }
      let status;
      if (o['--receipt']) {
        const receipt = privateJson(o['--receipt']);
        if (receipt.version !== VERSION + ':receipt' || !['committed_and_verified', 'replay_preserved'].includes(receipt.status)
          || receipt.plan_sha256 !== plan.plan_sha256 || receipt.package_sha256 !== sourcePackage.package_sha256
          || !equal(receipt.source, info) || receipt.after_sha256 !== hash(receipt.after) || !equal(receipt.policy, POLICY)) fail('COMMITTED_RECEIPT_REQUIRED');
        verifyAfter(plan, state, receipt.mutation_at);
        if (!equal(state, receipt.after)) fail('RECEIPT_READBACK_CHANGED');
        status = 'checked_committed_read_only';
      } else { if (!equal(state, plan.before)) fail('PREPARED_STATE_CHANGED'); status = 'checked_unchanged_read_only'; }
      const proof = { version: VERSION + ':check', status, checked_at: new Date().toISOString(), plan_sha256: plan.plan_sha256,
        package_sha256: sourcePackage.package_sha256, snapshot_sha256: hash(state), source: info, protected: state.protected, policy: POLICY };
      writePrivateJson(o['--private-output'], proof); return proof;
    }
    journal = newJournal(o['--private-journal'], plan.plan_sha256);
    const receipt = await execute({ connection: c, plan, info, sourcePackage, configuration, actorId,
      dryRun: mode === 'dry-run', backupPath: o['--private-backup'], journal,
      checkPackage: () => loadPackage(o['--package'], o['--approved-package-sha256']) });
    try { writePrivateJson(o['--private-output'], receipt); }
    catch (error) { if (receipt.status === 'committed_and_verified') fail('COMMITTED_RECEIPT_WRITE_FAILED_REVIEW_JOURNAL'); throw error; }
    return { status: receipt.status, plan_sha256: plan.plan_sha256, created_headers: receipt.created_headers,
      created_versions: receipt.created_versions, archived_privacy_headers: receipt.archived_privacy_headers, policy: POLICY };
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => process.stdout.write(JSON.stringify(r) + '\n')).catch(e => {
  process.stderr.write((/^BS_FINAL_CONSENT_[A-Z_]+$/.test(e.message) ? e.message : 'BS_FINAL_CONSENT_FAILED_REVIEW_PRIVATE_JOURNAL') + '\n'); process.exitCode = 1;
});
module.exports = { VERSION, ZIP_SHA256, LOPD_SHA256, PREFIX, LOCK_KEY, HEADER_FIELDS, VERSION_FIELDS, PIN_FILES, POLICY,
  source, privatePath, privacyForm, validateEmbeddedImages, compilePackage, loadPackage, capture, validateState, makePlan, validatePlan,
  expectedHeader, expectedVersion, verifyAfter, independentCapture, execute, parseOptions, run };
