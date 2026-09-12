'use strict';

// Static source inventory only: no imports of models/app/.env and no provider or DB access.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const groups = {
  meta: /metaClient|metaBatch|graph\.facebook\.com|graph\.instagram\.com|MetaConnection|MetaConecction|pageAccessToken|META_(?:APP_SECRET|GRAPH_TOKEN|SYSTEM_USER_TOKEN|CAPI_TOKEN|AD_LIBRARY_ACCESS_TOKEN)/g,
  google: /googleAdsClient|googleapis\.com|google-auth-library|GoogleConnection|GoogleConnectionAssignment|GOOGLE_(?:CLIENT_SECRET|ADS_DEVELOPER_TOKEN|REFRESH_TOKEN)/g,
  whatsapp: /waAccessToken|whatsapp-embedded|phoneNumberId|WHATSAPP_(?:TOKEN|ACCESS_TOKEN)/g,
  credential_field: /\b(?:accessToken|refreshToken|access_token|refresh_token|pageAccessToken|waAccessToken|clientSecret|appSecret)\b/g,
};
const families = {
  oauth: /oauth|fb_exchange_token|authorization_code|refresh_token/i,
  webhook: /webhook|x-hub-signature|rawBody/i,
  conversion: /CAPI|datamanager|conversion|enhanced_conversion/i,
  social_publication: /publish|posting|socialPost|\/feed|\/photos/i,
  advertising: /googleads|googleAds|campaign|ad_account|marketing_api/i,
  reception: /leadgen|nativeLead|leadAds|LeadIntake|formSubmission/i,
  google_profile_analytics: /businessprofile|mybusiness|searchconsole|webmasters|analyticsdata/i,
  whatsapp: /whatsapp|waAccessToken|phoneNumberId/i,
};
function inventory(root = path.resolve(__dirname, '../..')) {
  const roots = ['src', 'models', 'migrations', 'wordpress', 'scripts', 'ops', '.github'].filter(name => fs.existsSync(path.join(root, name)));
  const files = execFileSync('rg', ['--files', '--hidden', ...roots, '-g', '*.js', '-g', '*.cjs', '-g', '*.mjs', '-g', '*.ts', '-g', '*.php', '-g', '*.yml', '-g', '*.yaml', '-g', '!node_modules', '-g', '!Documentacion'], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim().split('\n').sort();
  const rows = [];
  for (const filename of files) {
    if (filename === 'src/scripts/security-inventory-consumers.js') continue;
    const content = fs.readFileSync(path.join(root, filename), 'utf8'); const hits = [];
    for (const [group, regex] of Object.entries(groups)) {
      regex.lastIndex = 0;
      for (const match of content.matchAll(regex)) hits.push({ group, symbol: match[0], line: content.slice(0, match.index).split('\n').length });
    }
    if (!hits.length) continue;
    const qa = /(?:^|\/)(?:tests?|fixtures|qa)(?:\/|\.)/.test(filename);
    rows.push({ file: filename, sha256: createHash('sha256').update(content).digest('hex'),
      kind: qa ? 'test_or_fixture' : filename.startsWith('models/') ? 'model' : filename.startsWith('migrations/') ? 'migration' : 'consumer_candidate',
      families: Object.entries(families).filter(([, pattern]) => pattern.test(content)).map(([name]) => name),
      status: qa ? 'qa_only' : 'pending_manual_classification_and_cohort', references: hits });
  }
  return { version: 1, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    method: 'Static symbols and source hashes only. No credentials, runtime or DB inspected.',
    limitations: ['Candidates include indirect consumers and false positives.', 'No claim of complete runtime, external OPS, CI or other-server coverage.', 'Dynamic provider routes and dependencies require manual review.'],
    counts: { files: rows.length, consumerCandidates: rows.filter(row => row.kind === 'consumer_candidate').length, qaFiles: rows.filter(row => row.kind === 'test_or_fixture').length }, rows };
}
if (require.main === module) process.stdout.write(JSON.stringify(inventory(process.argv[2] ? path.resolve(process.argv[2]) : undefined), null, 2) + '\n');
module.exports = { inventory };
