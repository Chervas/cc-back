'use strict';
const { privateFile } = require('./platformAudit.readerClient');
const { createClient } = require('../lib/auditWriterClient');
let client;
module.exports = { write(input) {
  if (!client) client = createClient({ origin: process.env.PLATFORM_AUDIT_WRITER_ORIGIN,
    ca: privateFile(process.env.PLATFORM_AUDIT_WRITER_CA_FILE), keyId: process.env.PLATFORM_AUDIT_WRITER_KEY_ID,
    privateKey: privateFile(process.env.PLATFORM_AUDIT_WRITER_KEY_FILE) });
  return client.write(input);
} };
