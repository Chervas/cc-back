'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const filename = path.join(__dirname, '..', 'deploy', 'clinicaclick-google-business-profile@.service');

test('Google Business Profile unit keeps its own OS identity, state and hardened Node 24 runtime', () => {
  const unit = fs.readFileSync(filename, 'utf8');
  for (const line of [
    'User=cc-google-gbp-%i',
    'Group=cc-google-gbp-%i',
    'WorkingDirectory=/opt/clinicaclick-google-business-profile/current',
    'ExecStart=/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin/node --max-old-space-size=128 src/google-main.js /etc/clinicaclick-google-business-profile-%i/config.json',
    'ReadWritePaths=/var/lib/clinicaclick-google-business-profile-%i',
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'PrivateDevices=true',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    'UMask=0077',
  ]) assert.match(unit, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

  for (const forbidden of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'EnvironmentFile=', 'DynamicUser=true']) {
    assert.equal(unit.includes(forbidden), false);
  }
});
