#!/usr/bin/env node
'use strict';
// Static heuristic: source paths/methods/templates only, no runtime/bootstrap/request values.
const fs = require('node:fs'); const path = require('node:path');
const { createHash } = require('node:crypto'); const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const files = execFileSync('rg', ['--files', 'src/routes', '-g', '*.js'], { cwd: root, encoding: 'utf8' }).trim().split('\n').sort();
const implemented = new Set(['/sign-in', '/sign-in-with-token', '/unlock-session']);
const sessionSuccess = new Set(['/sign-up', '/claim-invite', '/sign-out', '/revoke-sessions']);
const items = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8'); const routes = [];
  const pattern = /\brouter\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"])([^'"\n]*)\2/g;
  for (const match of source.matchAll(pattern)) {
    const prepared = file === 'src/routes/auth.routes.js' && match[1] === 'post' && implemented.has(match[3]);
    routes.push({ method: match[1].toUpperCase(), localTemplate: match[3], line: source.slice(0, match.index).split('\n').length,
      platformAudit: prepared ? 'auth_semantic_prepared_disabled' : file === 'src/routes/auth.routes.js' && sessionSuccess.has(match[3])
        ? 'session_success_prepared_disabled' : file === 'src/routes/system-monitoring.routes.js' && match[1] === 'get' && match[3] === '/audit/events'
          ? 'audit_view_semantic_prepared_disabled' : file === 'src/routes/access-policy.routes.js'
            && (match[1] === 'get' && ['/catalog', '/overrides', '/assignments'].includes(match[3]) || match[1] === 'put' && match[3] === '/overrides')
              ? 'permissions_semantic_prepared_disabled' : 'pending_semantic_review' });
  }
  items.push({ path: file, sha256: createHash('sha256').update(source).digest('hex'), routes });
}
const routes = items.flatMap(item => item.routes);
process.stdout.write(JSON.stringify({ version: 1, source: 'static_heuristic_not_runtime_coverage',
  limits: ['Local router templates, not complete mounted URLs', 'Comments/conditional mounts may affect results',
    'Dynamic routes, alternate router variables, socket events, jobs and scripts need separate review',
    'Existing domain audit tables are not proof of platform audit delivery'],
  totals: { files: items.length, declarations: routes.length,
    preparedDisabled: routes.filter(route => route.platformAudit === 'auth_semantic_prepared_disabled').length,
    sessionSuccessPreparedDisabled: routes.filter(route => route.platformAudit === 'session_success_prepared_disabled').length,
    auditViewPreparedDisabled: routes.filter(route => route.platformAudit === 'audit_view_semantic_prepared_disabled').length,
    permissionsPreparedDisabled: routes.filter(route => route.platformAudit === 'permissions_semantic_prepared_disabled').length }, items }, null, 2) + '\n');
