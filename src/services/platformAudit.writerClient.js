'use strict';
const { privateFile } = require('./platformAudit.readerClient');
const { createClient } = require('../lib/auditWriterClient');
let client;
module.exports = { write(input) {
  if (!client) {
    const caFile = process.env.PLATFORM_AUDIT_WRITER_CA_FILE;
    // Re-read only trust for each new TLS connection. Signing identity and
    // destination stay fixed; an unreadable replacement fails without retries.
    client = createClient({ origin: process.env.PLATFORM_AUDIT_WRITER_ORIGIN,
      ca: () => privateFile(caFile), keyId: process.env.PLATFORM_AUDIT_WRITER_KEY_ID,
      privateKey: privateFile(process.env.PLATFORM_AUDIT_WRITER_KEY_FILE) });
  }
  return client.write(input);
} };
