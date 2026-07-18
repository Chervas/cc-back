'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '../../..');
const testDirectory = path.join(repositoryRoot, 'src/scripts/tests');
const explicitContracts = new Set([
  'appointment_lead_milestone_conversion.test.js',
  'google_ads_conversion_tracking.test.js',
  'google_ads_clinicaclick_goal_policy.test.js',
  'google_lead_lifecycle_conversion.test.js',
  'marketing_web_campaign_integration.test.js',
  'qualified_lead_milestone.test.js',
  'scheduled_jobs_orchestration.test.js',
]);

const missing = [...explicitContracts].filter((fileName) => (
  !fs.existsSync(path.join(testDirectory, fileName))
));
if (missing.length > 0) {
  throw new Error(`Faltan contratos canónicos de campañas: ${missing.join(', ')}`);
}

const tests = fs.readdirSync(testDirectory)
  .filter((fileName) => fileName.endsWith('.test.js') && (
    fileName.startsWith('campaign_')
    || fileName.startsWith('guided_campaign_')
    || fileName.startsWith('external_campaign_')
    || fileName.startsWith('managed_campaign_')
    || explicitContracts.has(fileName)
  ))
  .sort()
  .map((fileName) => path.relative(repositoryRoot, path.join(testDirectory, fileName)));
console.log(`Marketing Campañas: ejecutando ${tests.length} contratos Node.`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
