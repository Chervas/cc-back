'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
function buildDatabaseTlsOptions(env, readFile = file => fs.readFileSync(file)) {
  const required = env.DB_TLS_REQUIRED;
  if (required === undefined || required === '' || required === 'false') return {};
  if (required !== 'true') throw Error('database_tls_mode_invalid');
  const file = env.DB_TLS_CA_FILE;
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('database_tls_ca_required');
  let ca;
  try {
    ca = readFile(file);
    if (!Buffer.isBuffer(ca)) ca = Buffer.from(ca);
    if (!ca.length || ca.length > 1024 * 1024) throw Error();
    const pem = ca.toString('utf8');
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw Error();
    for (const certificate of certificates) {
      const parsed = new X509Certificate(certificate);
      if (!parsed.ca) throw Error();
    }
  } catch { throw Error('database_tls_ca_invalid'); }
  // mysql2 3.14.1 otherwise does not check server identity just from rejectUnauthorized.
  return { ssl: { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } };
}
module.exports = { buildDatabaseTlsOptions };
