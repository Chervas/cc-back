'use strict';
const { sha } = require('./rdsSchemaMigrationPolicy');
const NAME = 'mysql-8.4.11-tinyint1-display-width/1';
const MESSAGE = 'Integer display width is deprecated and will be removed in a future release.';
function diagnostics(rows) {
  return Array.isArray(rows) ? rows.slice(0, 64).map(row => ({ level: String(row.Level || '').slice(0, 16), code: Number(row.Code),
    ...(row.Message === MESSAGE ? { message: MESSAGE } : { messageSha256: sha(String(row.Message || '')) }) })) : [];
}
function accepted({ sql, kind, engineVersion, rows, warningStatus }) {
  if (!Array.isArray(rows)) return false;
  if (!rows.length && Number(warningStatus || 0) === 0) return true;
  const tokens = String(sql).replace(/'(?:''|\\.|[^'\\])*'/g, "''");
  const widths = [...tokens.matchAll(/\b(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\s*\(\s*\d+\s*\)/gi)];
  return engineVersion === '8.4.11' && kind === 'ddl' && /^(?:CREATE\s+TABLE\b|ALTER\s+TABLE\s+.+?\s+ADD\s+)/i.test(tokens)
    && widths.length > 0 && widths.every(row => /^TINYINT\(1\)$/i.test(row[0])) && rows.length === widths.length
    && Number(warningStatus) === rows.length && rows.every(row => row.Level === 'Warning' && Number(row.Code) === 1681 && row.Message === MESSAGE);
}
module.exports = { NAME, MESSAGE, diagnostics, accepted };
