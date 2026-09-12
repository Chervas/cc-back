#!/usr/bin/env node
'use strict';
// Static paths/symbols/hashes only; never include connection values or source lines.
const fs = require('node:fs'); const path = require('node:path');
const { execFileSync } = require('node:child_process'); const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const files = execFileSync('rg', ['--files','-g','*.js','-g','!node_modules','-g','!services/*/node_modules','-g','!public','-g','!static'],
  { cwd: root, encoding: 'utf8' }).trim().split('\n');
const patterns = {
  sequelize_constructor: /new\s+(?:Sequelize|sequelize\.Sequelize)\s*\(/,
  mysql_connection: /\b(?:mysql|mysql2)\.(?:createConnection|createPool)\s*\(|require\(['"]mysql2(?:\/promise)?['"]\)\.(?:createConnection|createPool)\s*\(/,
  direct_db_env: /process\.env\.(?:DB_HOST|DB_USERNAME|DB_PASSWORD|DB_NAME)\b/,
};
const items = [];
for (const file of files.sort()) {
  const buffer = fs.readFileSync(path.join(root,file)); const source = buffer.toString('utf8'); const hits = [];
  source.split('\n').forEach((line,index) => { const symbols = Object.entries(patterns).filter(([,regex]) => regex.test(line)).map(([name]) => name);
    if (symbols.length) hits.push({ line: index + 1, symbols }); });
  if (!hits.length) continue;
  const classification = file === 'src/services/socket.service.js' ? 'namespace_only_not_db_client'
    : file === 'scripts/consolidate-propdental-sant-marti.js' ? 'uses_shared_models'
      : file.includes('/tests/') || file.includes('.test.') ? 'qa'
        : file.includes('/scripts/') || file.startsWith('scripts/') ? 'script' : 'runtime_candidate';
  items.push({ path: file, classification, tlsHelperReferenced: /databaseTlsConfig|dialectOptions/.test(source),
    hits, sha256: createHash('sha256').update(buffer).digest('hex') });
}
process.stdout.write(JSON.stringify({ version: 1, source: 'static_heuristic_requires_manual_callsite_review', items }, null, 2) + '\n');
