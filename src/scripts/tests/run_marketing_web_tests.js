'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '../../..');
const testDirectory = path.join(repositoryRoot, 'src/scripts/tests');
const explicitContracts = new Set([
  'access_policy.test.js',
  'agency_marketing_privacy_contract.test.js',
  'campaign_phase_a.test.js',
  'intake_config_runtime_hooks.test.js',
  'intake_config_write_merge.test.js',
  'intake_public_authentication.test.js',
  'intake_quickchat_outbox.test.js',
  'intake_snippet_runtime.test.js',
  'intake_verification_attestation.test.js',
  'job_admin_authorization.test.js',
  'job_request_transactional_outbox.test.js',
  'public_media_clinic_access.test.js',
  'scheduled_jobs_orchestration.test.js',
]);

function selectedTest(fileName) {
  return fileName.endsWith('.test.js') && (
    fileName.startsWith('web_')
    || fileName.startsWith('marketing_web_')
    || fileName.startsWith('modsuite_')
    || explicitContracts.has(fileName)
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    // La suite valida por separado las allowlists de rollout. El runner
    // general no debe heredar las allowlists reales de dev/staging, porque
    // convertiría fixtures de otras clínicas en falsos negativos.
    env: {
      ...process.env,
      MARKETING_WEB_ENABLED_SCOPES: '',
      MARKETING_WEB_DISABLED_SCOPES: '',
      MARKETING_WEB_PUBLISHING_SCOPES: '',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const tests = fs.readdirSync(testDirectory)
  .filter(selectedTest)
  .sort()
  .map((fileName) => path.relative(repositoryRoot, path.join(testDirectory, fileName)));

if (!tests.length) throw new Error('No se encontraron contratos de Marketing Web.');

console.log(`Marketing Web: ejecutando ${tests.length} contratos Node.`);
run(process.execPath, ['--test', '--test-concurrency=1', ...tests]);
console.log('Marketing Web: ejecutando contratos WordPress, Ed25519, compilador y provisionador.');
run('bash', ['wordpress/clinicaclick-web/tests/run.sh']);
