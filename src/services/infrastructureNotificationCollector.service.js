'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const P = require('../lib/infrastructureNotificationProtocol');
const ENTRY = path.resolve(__dirname, '../../services/infrastructure-alert-collector/src/main.js');
const BINARY = '/opt/clinicaclick-runtime/node-v24.21.0/bin/node';
const CONFIG = '/etc/clinicaclick-infrastructure-alerts/staging.json';
const CONFIG_DIRECTORY = path.dirname(CONFIG);
const CLEAN_ENV = Object.freeze({ PATH: '/usr/bin:/bin', TZ: 'UTC', LANG: 'C.UTF-8',
 AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' });
function loadConfiguration(env = process.env, io = fs) {
 P.need(env.INFRASTRUCTURE_NOTIFICATIONS_CONFIG_FILE === CONFIG, 'infrastructure_configuration_required');
 for (const directory of ['/', '/etc', CONFIG_DIRECTORY]) {
  const st = io.lstatSync(directory);
  P.need(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0
   && (directory !== CONFIG_DIRECTORY || st.gid === 1000 && (st.mode & 0o7777) === 0o750),
   'infrastructure_configuration_directory');
 }
 P.need(io.realpathSync(CONFIG) === CONFIG, 'infrastructure_configuration_canonical');
 const fd = io.openSync(CONFIG, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 let value;
 try {
  const st = io.fstatSync(fd);P.need(st.isFile() && st.nlink === 1 && st.uid === 0 && st.gid === 1000
   && (st.mode & 0o7777) === 0o640 && st.size <= 16384, 'infrastructure_private_configuration');
  value = JSON.parse(io.readFileSync(fd, 'utf8'));
 } finally { io.closeSync(fd); }
 P.need(value?.schema === 'clinicaclick-infrastructure-notifications-config/1' && value.physicalDbId === P.DBI
  && value.databaseHost === P.HOST && value.databaseName === 'clinicaclick' && Array.isArray(value.deliveryTests)
  && value.deliveryTests.length <= 10, 'infrastructure_configuration_scope');
 for (const [file, expected] of [[BINARY, value.nodeBinarySha256], [ENTRY, value.collectorSha256],
  [path.join(path.dirname(ENTRY), 'scope.js'), value.collectorScopeSha256],
  [path.join(path.dirname(ENTRY), 'credentials.js'), value.collectorCredentialsSha256]]) {
  P.need(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected)
   && P.hash(io.readFileSync(file)) === expected, 'infrastructure_collector_changed');
 }
 for (const test of value.deliveryTests) P.need(P.uuid(test.nonce) && Object.hasOwn(P.ALARMS, test.alarmArn)
  && Number.isSafeInteger(test.approvedAtEpochMs) && Number.isSafeInteger(test.expiresAtEpochMs)
  && test.expiresAtEpochMs > test.approvedAtEpochMs && test.expiresAtEpochMs - test.approvedAtEpochMs <= 900000,
  'infrastructure_delivery_test_configuration');
 return value;
}
function createCollector({ execute = execFile } = {}) {
 function call(request, timeoutMs) {
  P.parseInput(request);P.need(Number.isFinite(timeoutMs) && timeoutMs > 0, 'infrastructure_worker_deadline');
  return new Promise((resolve, reject) => {
   const child = execute(BINARY, [ENTRY], { timeout: Math.min(20000, Math.ceil(timeoutMs)), maxBuffer: 1024 * 1024,
    encoding: 'utf8', env: { ...CLEAN_ENV }, windowsHide: true }, (error, stdout, stderr) => {
    if (error || stderr) { reject(Error('infrastructure_collector_unavailable'));return; }
    try {
     const result = JSON.parse(stdout);
     P.need(result?.ok === true && result.operation === request.operation, 'infrastructure_collector_rejected');
     resolve(result);
    } catch { reject(Error('infrastructure_collector_invalid_response')); }
   });
   child?.stdin?.on('error', () => {});
   child?.stdin?.end(JSON.stringify(request));
  });
 }
 return { receive: timeout => call({ operation: 'receive', max: 10, visibilitySeconds: 120 }, timeout),
  ack: (receiptHandle, timeout) => call({ operation: 'ack', receiptHandle }, timeout) };
}
module.exports = { ENTRY, BINARY, CONFIG, CLEAN_ENV, loadConfiguration, createCollector };
