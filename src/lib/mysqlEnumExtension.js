'use strict';

// Intentionally limited to MySQL's unescaped metadata representation. Unknown
// schemas fail closed; never reconstruct or reorder an unfamiliar audit ENUM.
const fail = () => { throw Error('rds_schema_enum_extension_invalid'); };
const literal = "'(?:''|[^'\\\\])*'";
const identifier = '[A-Za-z_][A-Za-z0-9_]*';
function decode(value) { return value.slice(1, -1).replace(/''/g, "'"); }
function quote(value) {
  if (typeof value !== 'string' || /[\\\\\x00-\x1f\x7f]/.test(value)) fail();
  return "'" + value.replace(/'/g, "''") + "'";
}
function values(type) {
  const match = String(type || '').match(new RegExp('^ENUM\\((' + literal + '(?:,\\s*' + literal + ')*)\\)$', 'i'));
  if (!match) fail();
  const result = [...match[1].matchAll(new RegExp(literal, 'g'))].map(item => decode(item[0]));
  if (!result.length || new Set(result).size !== result.length) fail();
  return result;
}
function column(row) {
  if (!row || row.EXTRA !== '' || row.GENERATION_EXPRESSION) fail();
  const members = values(row.COLUMN_TYPE);
  if (!['YES', 'NO'].includes(row.IS_NULLABLE) || !new RegExp('^' + identifier + '$').test(row.CHARACTER_SET_NAME || '')
    || !new RegExp('^' + identifier + '$').test(row.COLLATION_NAME || '')) fail();
  return { values: members, allowNull: row.IS_NULLABLE === 'YES', defaultValue: row.COLUMN_DEFAULT,
    comment: row.COLUMN_COMMENT || '', charset: row.CHARACTER_SET_NAME, collation: row.COLLATION_NAME };
}
function statement(input) {
  const sql = String(input).trim().replace(/;$/, '');
  const match = sql.match(new RegExp('^ALTER\\s+TABLE\\s+`(' + identifier + ')`\\s+CHANGE\\s+`(' + identifier
    + ')`\\s+`(' + identifier + ')`\\s+(ENUM\\(' + literal + '(?:,\\s*' + literal + ')*\\))'
    + '\\s+CHARACTER\\s+SET\\s+(' + identifier + ')\\s+COLLATE\\s+(' + identifier + ')'
    + '\\s+(NOT\\s+NULL|NULL)(?:\\s+DEFAULT\\s+(' + literal + '|NULL))?(?:\\s+COMMENT\\s+(' + literal + '))?$', 'i'));
  if (!match || match[2] !== match[3]) fail();
  return { table: match[1], name: match[2], values: values(match[4]), charset: match[5], collation: match[6],
    allowNull: /^NULL$/i.test(match[7]), defaultValue: !match[8] || /^NULL$/i.test(match[8]) ? null : decode(match[8]),
    comment: match[9] ? decode(match[9]) : '' };
}
function sameProperties(before, after) {
  if (['allowNull', 'defaultValue', 'comment', 'charset', 'collation'].some(key => before[key] !== after[key])) fail();
}
function validate(before, target, appendOnly = true) {
  sameProperties(before, target);
  if (appendOnly ? target.values.length <= before.values.length : target.values.length !== before.values.length) fail();
  if (before.values.some((value, index) => target.values[index] !== value)) fail();
}
function sql(table, name, definition) {
  if (![table, name, definition.charset, definition.collation].every(value => new RegExp('^' + identifier + '$').test(value))) fail();
  return 'ALTER TABLE `' + table + '` CHANGE `' + name + '` `' + name + '` ENUM('
    + definition.values.map(quote).join(',') + ') CHARACTER SET ' + definition.charset + ' COLLATE ' + definition.collation
    + (definition.allowNull ? ' NULL' : ' NOT NULL')
    + (definition.defaultValue == null ? definition.allowNull ? ' DEFAULT NULL' : '' : ' DEFAULT ' + quote(definition.defaultValue))
    + ' COMMENT ' + quote(definition.comment);
}
const metadataSql = 'SELECT COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLUMN_COMMENT,EXTRA,GENERATION_EXPRESSION,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?';
module.exports = { values, column, statement, validate, sql, metadataSql };
