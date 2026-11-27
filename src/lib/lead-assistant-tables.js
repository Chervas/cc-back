'use strict';

const plain = value => value.replace(/\*\*|__|`/g, '').trim();
const normalize = value => plain(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
function cells(line) {
  const text = line.trim();
  if (!text.startsWith('|') || !text.endsWith('|')) return [];
  return text.slice(1, -1).split(/(?<!\\)\|/).map(value => plain(value.replace(/\\\|/g, '|')));
}

function tableRows(markdown, headings, { includeHeading = false } = {}) {
  const lines = markdown.split(/\r?\n/);
  const results = [];
  let heading = '';
  for (let i = 0; i + 1 < lines.length; i++) {
    if (includeHeading && /^#{1,6}\s/.test(lines[i])) heading = plain(lines[i].replace(/^#{1,6}\s+/, ''));
    const header = cells(lines[i]).map(normalize);
    if (!header.length) continue;
    const indexes = headings.map(pattern => header.findIndex(value => pattern.test(value)));
    const divider = cells(lines[i + 1]);
    if (indexes.includes(-1) || divider.length !== header.length || !divider.every(value => /^:?-{3,}:?$/.test(value))) continue;
    for (i += 2; i < lines.length; i++) {
      const row = cells(lines[i]);
      if (row.length !== header.length) break;
      const values = indexes.map(index => row[index]);
      results.push(includeHeading ? { heading, values } : values);
    }
    i--;
  }
  return results;
}

module.exports = { tableRows, normalize };
