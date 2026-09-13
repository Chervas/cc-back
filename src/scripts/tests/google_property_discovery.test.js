'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { propertyFixture } = require('./fixtures/google_property_discovery.fixture');
for (const kind of ['search_console', 'analytics']) {
  test(kind + ' registered inventory uses actual reference reader, exact tenant and no credential fields', async () => {
    const f = propertyFixture(kind); const output = await f.service.list(f.request);
    assert.equal(output.length, 1); assert.equal(f.state.calls[0].tenantRef, 'clinic:71'); assert.deepEqual(f.state.calls[0].payload, {});
    assert.equal(f.state.calls[0].operation, 'google.' + (kind === 'analytics' ? 'analytics' : 'search_console') + '.discovery.read.v1');
    assert(f.state.validation >= 5); await assert.rejects(f.service.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
    f.state.managed = false; assert.equal(await f.service.list(f.request), null); await f.service.assertLegacyAllowed();
  });
  test(kind + ' missing/disabled/blocked/malformed registry cannot fall back or reach broker', async () => {
    for (const change of [s => { s.records = []; }, s => { s.enabled = false; }, s => { s.registryFailure = true; },
      s => { s.records[0].state = 'blocked'; }, s => { s.mappings = []; }, s => { s.records[0].mapping_id++; },
      s => { s.records = Array.from({ length: 21 }, () => ({ ...s.records[0] })); },
      s => { s.mappings[0].broker_read_asset_ref = null; }, s => { s.connection.credentials_external = 0; }]) {
      const f = propertyFixture(kind); change(f.state); await assert.rejects(f.service.list(f.request)); assert.equal(f.state.calls.length, 0);
    }
  });
  test(kind + ' changes during provider await discard complete output and preserve denial codes', async () => {
    for (const [change, code] of [[s => { s.allowed = false; }, 'google_discovery_scope_forbidden'],
      [s => { s.enabled = false; }, 'broker_cohort_disabled'], [s => { s.at = 61000; }, 'broker_discovery_timeout'],
      [s => { s.records[0].state = 'blocked'; }, 'broker_binding_invalid'], [s => { s.mappings[0].googleConnectionId++; }, 'broker_binding_invalid']]) {
      const f = propertyFixture(kind); f.state.afterCall = () => change(f.state);
      await assert.rejects(f.service.list(f.request), { code }); assert.equal(f.state.calls.length, 1);
    }
  });
  test(kind + ' cooperative deadline prevents dispatch after slow metadata', async () => {
    const f = propertyFixture(kind); let count = 0;
    f.state.beforeMapping = () => { if (++count === 3) f.state.at = 61000; };
    await assert.rejects(f.service.list(f.request), { code: 'broker_discovery_timeout' }); assert.equal(f.state.calls.length, 0);
  });
}
test('GA shared property keeps each clinic grant and deduplicates only the verified public property', async () => {
  const f = propertyFixture(); f.request.clinicIds.push(72);
  f.state.records.push({ ...f.record, mapping_id: 92, clinica_id: 72 }); f.state.mappings.push({ ...f.mapping, id: 92, clinicaId: 72 });
  const output = await f.service.list(f.request); assert.equal(output.length, 1);
  assert.deepEqual(f.state.calls.map(c => c.tenantRef), ['clinic:71', 'clinic:72']);
  f.state.records[1].state = 'blocked'; await assert.rejects(f.service.list(f.request), { code: 'broker_binding_invalid' });
  f.request.clinicIds = [71]; assert.equal((await f.service.list(f.request)).length, 1);
});
test('four suspended inventories retain admission slots and release them after completion', async () => {
  const f = propertyFixture(); let release; const wait = new Promise(resolve => { release = resolve; }); f.state.afterCall = () => wait;
  const pending = Array.from({ length: 4 }, () => f.service.list(f.request));
  await new Promise(resolve => setImmediate(resolve)); await assert.rejects(f.service.list(f.request), { code: 'broker_discovery_busy' });
  assert.equal(f.state.calls.length, 4); release(); await Promise.all(pending); await f.service.list(f.request);
});
