'use strict';

// No dependencies, DB connections, logging or side effects. Record numbers are
// physical source lines (quoted multiline fields do not lose their provenance).
function parseCsv(input, { delimiter = ';', required = [] } = {}) {
  if (delimiter.length !== 1) throw new Error('CSV_INVALID_DELIMITER');
  const text = String(input).replace(/^\uFEFF/, '');
  const records = [];
  let values = [], value = '', quoted = false, closed = false, line = 1, startLine = 1;
  function field() { values.push(value); value = ''; closed = false; }
  function record() {
    field();
    if (values.some((v) => v !== '')) records.push({ line: startLine, values });
    values = [];
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (c === '"') { quoted = false; closed = true; }
      else { value += c; if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line += 1; }
      continue;
    }
    if (c === '"') {
      if (value || closed) throw new Error(`CSV_UNEXPECTED_QUOTE_AT_LINE_${line}`);
      quoted = true;
    } else if (c === delimiter) field();
    else if (c === '\r' || c === '\n') {
      record();
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      line += 1; startLine = line;
    } else {
      if (closed) throw new Error(`CSV_TRAILING_QUOTED_FIELD_AT_LINE_${line}`);
      value += c;
    }
  }
  if (quoted) throw new Error(`CSV_UNTERMINATED_QUOTE_AT_LINE_${startLine}`);
  if (value || values.length || closed) record();
  const headers = records.shift()?.values.map((v) => v.trim()) || [];
  if (!headers.length || headers.some((v) => !v) || new Set(headers).size !== headers.length) throw new Error('CSV_INVALID_HEADERS');
  if (required.some((name) => !headers.includes(name))) throw new Error('CSV_MISSING_REQUIRED_HEADERS');
  return records.map(({ line: rowLine, values: cells }) => {
    if (cells.length !== headers.length) throw new Error(`CSV_COLUMN_COUNT_AT_LINE_${rowLine}`);
    return { source_row: rowLine, values: Object.fromEntries(headers.map((h, i) => [h, cells[i]])) };
  });
}

module.exports = { parseCsv };
