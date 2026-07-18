'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertValidWebDocument } = require('../../lib/webDocument');
const {
  ADAPTER_VERSION,
  ModSuiteOfflineAdapterError,
  adaptModSuiteDocument,
  publicHttpsUrl,
  sanitizeLegacyText,
  stableSerializeLegacy,
} = require('../../lib/modSuiteOfflineAdapter');

const FIXTURE_DIRECTORY = path.join(__dirname, 'fixtures', 'modsuite-offline');
const CLI_PATH = path.resolve(__dirname, '..', 'migrate_modsuite_web_document.js');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), 'utf8'));
}

function serialized(value) {
  return JSON.stringify(value);
}

function testDeterministicValidMigration() {
  const source = fixture('synthetic-safe.json');
  const first = adaptModSuiteDocument(source);
  const second = adaptModSuiteDocument(JSON.parse(JSON.stringify(source)));

  assert.deepEqual(second, first);
  assert.equal(first.report.adapter_version, ADAPTER_VERSION);
  assert.match(first.report.source_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.report.document_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.report.document_hash, assertValidWebDocument(first.document).hash);
  assert.equal(first.report.security.remote_requests_performed, 0);
  assert.equal(first.report.security.output_schema_valid, true);
  assert.equal(first.document.seo.indexing, 'noindex');
  assert.equal(first.document.consent.preview_mode, true);

  const statuses = first.report.summary.statuses;
  assert.ok(statuses.migrado > 0);
  assert.ok(statuses.aproximado > 0);
  assert.ok(statuses.requiere_revision > 0);
  assert.equal(statuses.omitido, 0);
  assert.equal(first.report.nodes.length, first.report.summary.source_nodes);

  const ids = [
    ...first.document.pages.map((page) => page.id),
    ...Object.keys(first.document.nodes),
  ];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^(?:page|node)_[a-f0-9]{32}$/);
    assert.ok(!['10', '11', '12', '13', '14', '15', '16', '17', '18'].includes(id));
  }

  const output = serialized({ document: first.document, report: first.report });
  assert.ok(!output.includes('legacy-page'));
  assert.ok(!output.includes('legacy-container'));
  assert.ok(!output.includes('stylesLaptop'));
  assert.ok(!output.includes('media.example.org/clinic-demo.jpg'));
  assert.ok(output.includes('https://clinic.example/reservar?utm_source=legacy'));
  assert.ok(Object.values(first.document.nodes).some((node) => node.type === 'intake_form'));
}

function testHostileContentNeverLeaks() {
  const source = fixture('synthetic-hostile.json');
  const { document, report } = adaptModSuiteDocument(source);
  assertValidWebDocument(document);

  const output = serialized({ document, report });
  for (const forbidden of [
    'do-not-keep',
    'synthetic-secret-must-not-leak',
    'javascript:',
    'https://localhost',
    'containerClass',
    'stylesAll',
    'legacy_custom_widget',
  ]) {
    assert.ok(!output.includes(forbidden), `se conservó contenido no permitido: ${forbidden}`);
  }
  assert.ok(output.includes('Texto visible'));
  assert.ok(output.includes('Contenido hijo seguro'));
  assert.ok(report.summary.statuses.migrado > 0);
  assert.ok(report.summary.statuses.aproximado > 0);
  assert.ok(report.summary.statuses.omitido > 0);
  assert.ok(report.summary.statuses.requiere_revision > 0);
  assert.ok(report.nodes.some((entry) => (
    entry.source_type === 'unsupported'
    && entry.status === 'omitido'
    && entry.issues.includes('wrapper_omitted_children_retained')
  )));
  assert.ok(report.nodes.some((entry) => (
    entry.source_type === 'text'
    && entry.issues.includes('executable_markup_removed')
  )));
  assert.ok(report.nodes.some((entry) => (
    entry.source_type === 'pagina'
    && entry.status === 'requiere_revision'
    && entry.issues.includes('legacy_executable_metadata_discarded')
  )));
}

function testSanitizerAndUrlPolicy() {
  const paired = sanitizeLegacyText('<p>Contenido</p><script>alert(1)</script>');
  assert.equal(paired.text, 'Contenido');
  assert.equal(paired.removedDangerous, true);

  const encodedUnclosed = sanitizeLegacyText('Visible &lt;script&gt;secret()');
  assert.equal(encodedUnclosed.text, 'Visible');
  assert.equal(encodedUnclosed.removedDangerous, true);

  const css = sanitizeLegacyText('Texto .danger { display:none } final');
  assert.equal(css.text, 'Texto final');
  assert.equal(css.removedDangerous, true);

  assert.equal(publicHttpsUrl('javascript:alert(1)'), null);
  assert.equal(publicHttpsUrl('http://example.org/path'), null);
  assert.equal(publicHttpsUrl('https://user:pass@example.org/path'), null);
  assert.equal(publicHttpsUrl('https://localhost/path'), null);
  assert.equal(publicHttpsUrl('https://localhost./path'), null);
  assert.equal(publicHttpsUrl('https://127.0.0.1/path'), null);
  assert.equal(publicHttpsUrl('https://127.0.0.1./path'), null);
  assert.equal(publicHttpsUrl('https://[::1]/path'), null);
  assert.equal(publicHttpsUrl('https://intranet/path'), null);
  assert.equal(publicHttpsUrl('https://clinic.internal/path'), null);
  assert.equal(publicHttpsUrl('https://example.org/path?api_key=secret'), null);
  assert.equal(publicHttpsUrl('https://example.org/path?apiKey=secret'), null);
  assert.equal(publicHttpsUrl('https://example.org/path?accessToken=secret'), null);
  assert.equal(publicHttpsUrl('https://example.org/path#javascript%3Aalert(1)'), null);
  assert.equal(publicHttpsUrl('https://example.org/path?online=1'), null);
  assert.equal(publicHttpsUrl('https://example.org/path?utm_source=legacy'), 'https://example.org/path?utm_source=legacy');
}

function testEnvelopesSelectionAndCanonicalSource() {
  const source = fixture('synthetic-safe.json');
  const direct = adaptModSuiteDocument(source);
  const wrapped = adaptModSuiteDocument({ configuration: JSON.stringify(source) });
  assert.deepEqual(wrapped, direct);

  const catalog = [
    {
      name_block: 'PrimeraPage',
      type: 'Pagina',
      content: [{ type: 'text', content: 'Primera' }],
    },
    {
      name_block: 'SegundaPage',
      type: 'Pagina',
      content: [{ type: 'text', content: 'Segunda' }],
    },
  ];
  const selected = adaptModSuiteDocument(catalog, {
    pageNames: ['SegundaPage'],
    title: 'Página seleccionada',
    slug: 'pagina-seleccionada',
  });
  assert.equal(selected.document.pages.length, 1);
  assert.equal(selected.document.pages[0].title, 'Página seleccionada');
  assert.equal(selected.document.pages[0].slug, 'pagina-seleccionada');
  assert.ok(serialized(selected.document).includes('Segunda'));
  assert.ok(!serialized(selected.document).includes('Primera'));

  assert.throws(
    () => adaptModSuiteDocument(catalog, { pageNames: ['No existe'] }),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_page_selection_missing'
  );
  assert.throws(
    () => adaptModSuiteDocument({ unrelated: true }),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_pages_missing'
  );
}

function testStableSerializerRejectsExecutableObjectShapes() {
  assert.equal(stableSerializeLegacy({ b: 1, a: 2 }), stableSerializeLegacy({ a: 2, b: 1 }));

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => stableSerializeLegacy(circular),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_source_circular'
  );

  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { return 'unsafe'; } });
  assert.throws(
    () => stableSerializeLegacy(accessor),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_source_not_plain_json'
  );

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => stableSerializeLegacy(sparse),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_source_not_plain_json'
  );

  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, '0', { enumerable: true, get() { return 'unsafe'; } });
  assert.throws(
    () => stableSerializeLegacy(arrayAccessor),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_source_not_plain_json'
  );

  assert.throws(
    () => stableSerializeLegacy({ '\u00e9': 1, 'e\u0301': 2 }),
    (error) => error instanceof ModSuiteOfflineAdapterError && error.code === 'legacy_source_key_collision'
  );
}

function testOfflineCli() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicaclick-modsuite-offline-'));
  try {
    const input = path.join(FIXTURE_DIRECTORY, 'synthetic-safe.json');
    const output = path.join(temporaryDirectory, 'web-document.json');
    const report = path.join(temporaryDirectory, 'migration-report.json');
    const args = [CLI_PATH, '--input', input, '--output', output, '--report', report];

    const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Migración offline completada/);
    assert.ok(!success.stdout.includes('Atención cercana'));
    assertValidWebDocument(JSON.parse(fs.readFileSync(output, 'utf8')));
    const parsedReport = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(parsedReport.security.remote_requests_performed, 0);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.statSync(report).mode & 0o777, 0o600);

    const noOverwrite = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(noOverwrite.status, 1);
    assert.match(noOverwrite.stderr, /output_exists/);

    const forced = spawnSync(process.execPath, [...args, '--force'], { encoding: 'utf8' });
    assert.equal(forced.status, 0, forced.stderr);

    const reviewOutput = path.join(temporaryDirectory, 'review-document.json');
    const reviewReport = path.join(temporaryDirectory, 'review-report.json');
    const failOnReview = spawnSync(process.execPath, [
      CLI_PATH,
      '--input', input,
      '--output', reviewOutput,
      '--report', reviewReport,
      '--fail-on-review',
    ], { encoding: 'utf8' });
    assert.equal(failOnReview.status, 2, failOnReview.stderr);
    assert.ok(fs.existsSync(reviewOutput));
    assert.ok(fs.existsSync(reviewReport));

    const remoteInput = spawnSync(process.execPath, [
      CLI_PATH,
      '--input', 'https://example.org/export.json',
      '--output', path.join(temporaryDirectory, 'remote-document.json'),
      '--report', path.join(temporaryDirectory, 'remote-report.json'),
    ], { encoding: 'utf8' });
    assert.equal(remoteInput.status, 1);
    assert.match(remoteInput.stderr, /remote_paths_forbidden/);

    const linkedInput = path.join(temporaryDirectory, 'linked-input.json');
    fs.symlinkSync(input, linkedInput);
    const symlinkInput = spawnSync(process.execPath, [
      CLI_PATH,
      '--input', linkedInput,
      '--output', path.join(temporaryDirectory, 'linked-document.json'),
      '--report', path.join(temporaryDirectory, 'linked-report.json'),
    ], { encoding: 'utf8' });
    assert.equal(symlinkInput.status, 1);
    assert.match(symlinkInput.stderr, /input_not_regular_file/);

    const protectedTarget = path.join(temporaryDirectory, 'protected-target.json');
    const linkedOutput = path.join(temporaryDirectory, 'linked-output.json');
    fs.writeFileSync(protectedTarget, '{"protected":true}\n', { mode: 0o600 });
    fs.symlinkSync(protectedTarget, linkedOutput);
    const symlinkOutput = spawnSync(process.execPath, [
      CLI_PATH,
      '--input', input,
      '--output', linkedOutput,
      '--report', path.join(temporaryDirectory, 'safe-report.json'),
      '--force',
    ], { encoding: 'utf8' });
    assert.equal(symlinkOutput.status, 1);
    assert.match(symlinkOutput.stderr, /unsafe_output_path/);
    assert.equal(fs.readFileSync(protectedTarget, 'utf8'), '{"protected":true}\n');

    const hardlinkInput = path.join(temporaryDirectory, 'hardlink-input.json');
    const hardlinkOutput = path.join(temporaryDirectory, 'hardlink-output.json');
    fs.copyFileSync(input, hardlinkInput);
    fs.linkSync(hardlinkInput, hardlinkOutput);
    const hardlinkAttempt = spawnSync(process.execPath, [
      CLI_PATH,
      '--input', hardlinkInput,
      '--output', hardlinkOutput,
      '--report', path.join(temporaryDirectory, 'hardlink-report.json'),
      '--force',
    ], { encoding: 'utf8' });
    assert.equal(hardlinkAttempt.status, 1);
    assert.match(hardlinkAttempt.stderr, /output_overwrites_input/);
    assert.deepEqual(fs.readFileSync(hardlinkInput), fs.readFileSync(input));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function run() {
  testDeterministicValidMigration();
  testHostileContentNeverLeaks();
  testSanitizerAndUrlPolicy();
  testEnvelopesSelectionAndCanonicalSource();
  testStableSerializerRejectsExecutableObjectShapes();
  testOfflineCli();
  console.log('modsuite_offline_adapter.test.js: ok');
}

run();
