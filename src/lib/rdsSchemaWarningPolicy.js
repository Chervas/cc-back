'use strict';
const { sha } = require('./rdsSchemaMigrationPolicy');
const GBP_MIGRATION = '20261111150000-business-profile-managed-associations.js';
const GBP_SQL = '08cca87641f509449b0e12cff074b955660ee3183e79c1ae3edda9c734a41125';
const GBP_MESSAGE_SHA = 'a947e3875a510823331e22329aacd5cf0733eb3fe3b6116fca640a79d1e0b2fc';
const GBP_NAME = 'mysql-8.4.11-gbp-request-char-binary/1';
function policyFor({ sql, migrationName, continuationProof }) {
  const p = continuationProof?.continuationWarningPolicy;
  return migrationName === GBP_MIGRATION && continuationProof?.migration === GBP_MIGRATION && p?.name === GBP_NAME
    && p.sqlSha256 === GBP_SQL && p.warningCount === 7 && p.code === 1287 && p.messageSha256 === GBP_MESSAGE_SHA
    && sha(String(sql)) === GBP_SQL ? GBP_NAME : NAME;
}
const NAME = 'mysql-8.4.11-tinyint1-display-width/1';
const MESSAGE = 'Integer display width is deprecated and will be removed in a future release.';
function diagnostics(rows) {
  return Array.isArray(rows) ? rows.slice(0, 64).map(row => ({ level: String(row.Level || '').slice(0, 16), code: Number(row.Code),
    ...(row.Message === MESSAGE ? { message: MESSAGE } : { messageSha256: sha(String(row.Message || '')) }) })) : [];
}
function accepted({ sql, kind, engineVersion, rows, warningStatus, migrationName, continuationProof }) {
  if (!Array.isArray(rows)) return false;
  if (!rows.length && Number(warningStatus || 0) === 0) return true;
  if (policyFor({ sql, migrationName, continuationProof }) === GBP_NAME) return engineVersion === '8.4.11' && kind === 'ddl'
    && rows.length === 7 && Number(warningStatus) === 7
    && rows.every(row => row.Level === 'Warning' && Number(row.Code) === 1287 && sha(String(row.Message || '')) === GBP_MESSAGE_SHA);
  const tokens = String(sql).replace(/'(?:''|\\.|[^'\\])*'/g, "''");
  const widths = [...tokens.matchAll(/\b(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\s*\(\s*\d+\s*\)/gi)];
  return engineVersion === '8.4.11' && kind === 'ddl' && /^(?:CREATE\s+TABLE\b|ALTER\s+TABLE\s+.+?\s+ADD\s+)/i.test(tokens)
    && widths.length > 0 && widths.every(row => /^TINYINT\(1\)$/i.test(row[0])) && rows.length === widths.length
    && Number(warningStatus) === rows.length && rows.every(row => row.Level === 'Warning' && Number(row.Code) === 1681 && row.Message === MESSAGE);
}
module.exports = { NAME, MESSAGE, GBP_NAME, diagnostics, policyFor, accepted };
