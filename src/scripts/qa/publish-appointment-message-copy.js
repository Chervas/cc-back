#!/usr/bin/env node
'use strict';
// Native authenticated publication only. Catalog writes are deliberately not
// supported: the fresh-inference acceptance gate has not passed for that copy.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { publishEntry } = require('../../lib/appointment-copy-publication');

async function main() {
  const [mode, planFile, validationFile] = process.argv.slice(2);
  assert.equal(mode, '--flows-without-catalog-changes');
  for (const file of [planFile, validationFile]) {
    assert(file?.startsWith('/home/ubuntu/secure-imports/') && path.isAbsolute(file));
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
  }
  const plan = JSON.parse(fs.readFileSync(planFile)), validation = JSON.parse(fs.readFileSync(validationFile));
  assert.equal(plan.target, 'crm'); assert.equal(plan.read_only, true);
  assert.equal(validation.graphs, plan.entries.length); assert.equal(validation.passed, plan.entries.length);
  assert.equal(validation.failed.length, 0);
  const browser = await require('puppeteer-core').connect({ browserURL: 'http://127.0.0.1:9227', defaultViewport: null });
  let page;
  try {
    page = await browser.newPage(); page.setDefaultTimeout(120000);
    await page.goto('https://crm.clinicaclick.com/assets/i18n/es.json?message-copy-operator=1', { waitUntil: 'domcontentloaded' });
    const request = (method, route, body) => page.evaluate(async ({ method, route, body }) => {
      const allowed = method === 'GET' && /^\/api\/automations\/v2\/templates\/[^/]+\/versions\?include_nodes=1&limit=200$/.test(route)
        || method === 'POST' && (route === '/api/automations/v2/templates'
          || /^\/api\/automations\/v2\/templates\/[^/]+\/versions\/\d+\/publish$/.test(route));
      if (!allowed) throw Error('copy_publication_route_not_allowed');
      const token = localStorage.getItem('accessToken');
      const response = await fetch(route, { method, credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (!response.ok) throw Error('copy_publication_http_' + response.status + '_' + (value.error || 'rejected'));
      return value;
    }, { method, route, body });
    const entries = [...plan.entries].sort((a, b) => Number(a.source.is_active) - Number(b.source.is_active));
    for (const [index, entry] of entries.entries()) {
      const result = await publishEntry(entry, request);
      const receipt = { at: new Date().toISOString(), ordinal: index + 1, sourceId: entry.source.id, ...result };
      fs.appendFileSync(path.join(path.dirname(planFile), 'copy-publication-receipts.jsonl'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
      console.log(JSON.stringify(receipt));
    }
  } finally { if (page && !page.isClosed()) await page.close(); browser.disconnect(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
