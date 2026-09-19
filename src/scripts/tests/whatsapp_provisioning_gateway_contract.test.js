'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Automatic provisioning contract loads from the gateway package without the AWS broker runtime', t => {
  const root = path.resolve(__dirname, '../../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['whatsapp-provisioning-contract.js', 'whatsapp-onboarding-contract.js', 'canonical.js', 'contracts.js', 'errors.js', 'bedrock-errors.js']) {
    fs.copyFileSync(path.join(root, 'services/integrations-broker/src', file), path.join(dir, file));
  }
  const script = `const P = require('./whatsapp-provisioning-contract');
    const binding = P.publicBinding({appId:'101',configId:'102',redirectUri:'https://example.invalid/callback',
      scopes:['whatsapp_business_management','whatsapp_business_messaging']}, 'clinic:123', [123]);
    if (binding.connectionRef !== 'whatsapp-auto-clinic-123-v1' || binding.customer.selectionOnly !== true) throw Error('invalid_binding');
    process.stdout.write('gateway_contract_ready');`;
  assert.equal(execFileSync(process.execPath, ['-e', script], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  }), 'gateway_contract_ready');
});
