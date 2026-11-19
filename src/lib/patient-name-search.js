'use strict';

const { Op, literal } = require('sequelize');

function normalizePatientSearchQuery(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function escapeLike(value) {
  return String(value ?? '').replace(/[!%_]/g, character => `!${character}`);
}

function buildPatientNameSearch(query, sequelize, { allowSubstring = false } = {}) {
  const tokens = (String(query ?? '').normalize('NFD').replace(/\p{M}+/gu, '')
    .match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
  if (!tokens.length || !tokens.some(token => [...token].length > 1)) return null;

  const fold = (column) => `REGEXP_REPLACE(${column}, ${sequelize.escape('\\p{M}+')}, '')`;
  const combined = fold("CONCAT_WS(' ', `Paciente`.`nombre`, `Paciente`.`apellidos`)");
  const separated = `REGEXP_REPLACE(${combined}, ${sequelize.escape('[^\\p{L}\\p{N}]+')}, ' ')`;
  const fullName = `(CONVERT(TRIM(${separated}) USING utf8mb4) COLLATE utf8mb4_0900_ai_ci)`;
  const words = `CONCAT(' ', ${fullName})`;
  const like = (expression, pattern) => `${expression} LIKE ${sequelize.escape(pattern)} ESCAPE '!'`;
  const phrase = tokens.map(escapeLike).join(' ');
  const wordPrefixes = tokens.map(token => like(words, `% ${escapeLike(token)}%`));
  const comparisons = allowSubstring
    ? tokens.map((token, index) => [...token].length === 1 ? wordPrefixes[index] : like(fullName, `%${escapeLike(token)}%`))
    : wordPrefixes;

  // Prefixes of complete words allow an initial and a second surname, including
  // older records with multiple name parts saved in the same field.
  return {
    where: { [Op.and]: comparisons.map(literal) },
    rank: literal(`CASE
      WHEN ${fullName} = ${sequelize.escape(tokens.join(' '))} THEN 0
      WHEN ${like(fullName, `${phrase}%`)} THEN 1
      WHEN ${like(words, `% ${phrase}%`)} THEN 2
      ${allowSubstring ? `WHEN ${wordPrefixes.join(' AND ')} THEN 3` : ''}
      ELSE 4 END`),
  };
}

module.exports = { buildPatientNameSearch, escapeLike, normalizePatientSearchQuery };
