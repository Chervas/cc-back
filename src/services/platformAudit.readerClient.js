'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { createClient } = require('../lib/auditReaderClient');
function privateFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename
    || !fs.statSync(filename).isFile() || fs.statSync(filename).size > 65536 || (fs.statSync(filename).mode & 0o077)) throw Error('audit_reader_configuration_invalid');
  return fs.readFileSync(filename);
}
const clients = new Map();
function client(mode) {
  if (!['confirmed', 'reconcile'].includes(mode)) throw Error('audit_reader_configuration_invalid');
  if (!clients.has(mode)) {
    const prefix = mode === 'confirmed' ? 'PLATFORM_AUDIT_VIEW' : 'PLATFORM_AUDIT_RECONCILE';
    clients.set(mode, createClient({ origin: process.env.PLATFORM_AUDIT_READER_ORIGIN,
      ca: privateFile(process.env.PLATFORM_AUDIT_READER_CA_FILE), keyId: process.env[prefix + '_KEY_ID'],
      privateKey: privateFile(process.env[prefix + '_KEY_FILE']) }));
  }
  return clients.get(mode);
}
module.exports = { privateFile, read: command => client(command.mode).read(command) };
