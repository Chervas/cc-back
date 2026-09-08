#!/usr/bin/env node
'use strict';

const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { prepareReview } = require('../lib/cliniccloud-import/review');

function run(args) {
  const options = parseArgs(args, ['--plan', '--local-snapshot', '--review', '--private-output']);
  for (const key of ['--plan', '--local-snapshot', '--review', '--private-output']) if (!options[key]) throw new Error('MISSING_REQUIRED_CLI_ARGUMENT');
  const read = (key) => JSON.parse(readBytes(options[key]).toString('utf8'));
  const result = prepareReview({ plan: read('--plan'), snapshot: read('--local-snapshot'), review: read('--review') });
  writePrivateJson(options['--private-output'], result);
  const counts = result.commands.reduce((out, row) => { out[row.command] = (out[row.command] || 0) + 1; return out; }, {});
  return { package_sha256: result.package_sha256, commands: counts, unresolved_review_actions: result.unresolved_review_actions, executable: false, automation_policy: 'hold' };
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${/^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'CLINICCLOUD_REVIEW_FAILED'}\n`); process.exitCode = 1; }
}
module.exports = { run };
