'use strict';
const fs = require('node:fs'); const cp = require('node:child_process'); const path = require('node:path');
const { createHash } = require('node:crypto'); const z = require('node:zlib');
const { applyEdits } = require('./whatsapp-dispatch-release');
const root = path.resolve(__dirname, '../..'); const dir = process.argv[2];
const BASELINE = '672cae7a760bb2a248faa691823c37e1f66762ef';
if (!dir || !path.isAbsolute(dir)) throw Error('private_artifact_directory_required');
const previous = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json')));
const src = name => fs.readFileSync(path.join(root, 'services/integrations-broker/src', name), 'utf8');
const git = (revision, name) => cp.execFileSync('git', ['show', revision + ':services/integrations-broker/src/' + name], { cwd: root, encoding: 'utf8' });
const hash = value => createHash('sha256').update(value).digest('hex');
const entry = value => ({ data: Buffer.from(value).toString('base64'), sha: hash(value) });
const current = src('broker.js'), old = git(BASELINE, 'broker.js');
const line = (text, prefix) => text.split('\n').find(l => l.startsWith(prefix));
const constructor = line(old, '  constructor('), assignment = line(old, '    this.operations =');
const nonce = line(old, '    this.store.acceptNonce(');
const identity = '    const identity = { operation: request.operation, tenantRef: request.tenantRef,';
const edits = {
  'broker.js': [
    { before: constructor, after: line(current, '  constructor(') },
    { before: assignment, after: line(current, '    this.operations =') },
    { before: nonce, after: current.slice(current.indexOf('    const admissionLane ='), current.indexOf('    let operation;')).trimEnd() },
    { before: identity, after: current.slice(current.indexOf('    let release;'), current.indexOf(identity)) + identity },
    { before: "  }\n  block(ref, event, state = 'blocked') {", after: "    } finally { release?.(); }\n  }\n  block(ref, event, state = 'blocked') {" },
  ],
  'errors.js': [{ before: '  idempotency_conflict: 409, outcome_unknown: 409, rate_limited: 429,',
    after: '  idempotency_conflict: 409, outcome_unknown: 409, rate_limited: 429,\n' + line(src('errors.js'), '  whatsapp_capacity_concurrency:') }],
};
if (applyEdits(old, edits['broker.js']) !== current || applyEdits(git(BASELINE, 'errors.js'), edits['errors.js']) !== src('errors.js')) throw Error('local_diff_not_reproduced');
// The pinned AWS release predates the local identity variable. Insert the same
// admission block before its inline digest without promoting other broker code.
const activeDigest = "    const digest = createHash('sha256').update(canonical({ operation: request.operation, tenantRef: request.tenantRef,";
edits['broker.js'][3] = { before: activeDigest,
  after: current.slice(current.indexOf('    let release;'), current.indexOf(identity)) + activeDigest };
edits['broker.js'].push({ before: '      const work = metadataOnly ? execute(null) : this.secrets.withSecret(binding, execute,',
  after: '      const work = metadataOnly || operation.secretless === true ? execute(null) : this.secrets.withSecret(binding, execute,' });
const files = {};
for (const name of Object.keys(previous.baseHashes).filter(f => !edits[f])) {
  if (name === 'whatsapp-activation-reader.js') {
    const active = git('4f5c78e3e8243deff4e7645e2fac5d101edbefd3', name);
    if (hash(active) !== previous.baseHashes[name]) throw Error('activation_reader_baseline_changed');
    files[name] = entry(applyEdits(active, [{ before: "require('./whatsapp-authorized-status').READ];",
      after: "require('./whatsapp-authorized-status').READ,require('./whatsapp-send-receipt').READ];" }]));
  } else {
    if (hash(git(BASELINE, name)) !== previous.baseHashes[name]) throw Error('local_baseline_not_active:' + name);
    files[name] = entry(src(name));
  }
}
const newFiles = Object.fromEntries(['whatsapp-dispatch-capacity.js', 'whatsapp-send-receipt.js'].map(f => [f, entry(src(f))]));
const plan = { version: 1, baseHashes: previous.baseHashes, files, edits, newFiles };
const operator = fs.readFileSync(path.join(__dirname, 'whatsapp-dispatch-release.js'), 'utf8');
const artifact = z.gzipSync(Buffer.from(JSON.stringify({ plan, operator })));
fs.writeFileSync(path.join(dir, 'plan-v5.json'), JSON.stringify(plan), { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'release-v5.json.gz'), artifact, { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'upload-v5.b64'), artifact.toString('base64'), { mode: 0o600 });
console.log(JSON.stringify({ version: 5, bytes: artifact.length, artifactSha: hash(artifact), preservedActiveBaseline: true,
  noNewSystemPackages: true, sourceFiles: Object.keys(previous.baseHashes), newFiles: Object.keys(newFiles) }));
