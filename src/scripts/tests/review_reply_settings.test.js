'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewReplySettings, SCOPE, MAX_PROMPT_LENGTH } = require('../../services/reviewReplySettings.service');

function fixture() {
  let row = null, reads = 0, creates = 0, commits = 0;
  const audit = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    sequelize: { transaction: async work => {
      const before = row && { ...row, rules: { ...row.rules } }; const length = audit.length;
      try { const result = await work(transaction); commits++; return result; }
      catch (error) { row = before; audit.length = length; throw error; }
    } },
    SecurityMonitoringSetting: {
      async findOne({ where }) { assert.equal(where.scope, SCOPE); reads++; return row; },
      async findOrCreate({ where, defaults, transaction: tx }) {
        assert.equal(where.scope, SCOPE); assert.equal(tx, transaction);
        if (!row) { creates++; row = { ...defaults,
          async reload(options) { assert.equal(options.lock, 'UPDATE'); },
          async update(values, options) { assert.equal(options.transaction, transaction); Object.assign(this, values, { updated_at: '2026-11-02T10:00:00Z' }); },
        }; }
        return [row];
      },
    },
    SecurityMonitoringChange: { async create(event, options) { assert.equal(options.transaction, transaction); audit.push(event); } },
  };
  return { service: createReviewReplySettings({ models }), audit, counts: () => ({ reads, creates, commits }) };
}

test('GET is empty/unconfigured, status contains only configured and reads never write', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.get(1), { success: true, settings: { prompt: '', configured: false, version: 0, updatedAt: null } });
  assert.deepEqual(await f.service.status(), { configured: false });
  assert.deepEqual(f.counts(), { reads: 2, creates: 0, commits: 0 });
});

test('only root admins can read/edit the global prompt; clinic ownership cannot override it', async () => {
  const f = fixture();
  for (const actor of [2, 21, 0, null]) {
    await assert.rejects(f.service.get(actor), { code: 'technical_admin_required', status: 403 });
    await assert.rejects(f.service.put({ prompt: 'Ficticio', expectedVersion: 0 }, actor), { code: 'technical_admin_required' });
  }
  assert.deepEqual(f.counts(), { reads: 0, creates: 0, commits: 0 });
});

test('versioned prompt updates, conflicts, clearing and metadata-only audit use existing settings row', async () => {
  const f = fixture();
  const first = await f.service.put({ prompt: ' FICTITIOUS_EDITORIAL_PROMPT ', expectedVersion: 0 }, 44);
  assert.equal(first.settings.prompt, 'FICTITIOUS_EDITORIAL_PROMPT'); assert.equal(first.settings.version, 1);
  assert.deepEqual(await f.service.status(), { configured: true });
  assert.equal(f.audit.length, 1); assert.equal(f.audit[0].actor_id, 44);
  assert.doesNotMatch(JSON.stringify(f.audit), /FICTITIOUS_EDITORIAL_PROMPT/);
  await assert.rejects(f.service.put({ prompt: 'Stale', expectedVersion: 0 }, 1), { code: 'review_reply_settings_version_conflict', status: 409 });
  assert.equal((await f.service.get(1)).settings.prompt, 'FICTITIOUS_EDITORIAL_PROMPT');
  await f.service.put({ prompt: 'FICTITIOUS_EDITORIAL_PROMPT', expectedVersion: 1 }, 1); assert.equal(f.audit.length, 1);
  const cleared = await f.service.put({ prompt: '', expectedVersion: 1 }, 1);
  assert.equal(cleared.settings.version, 2); assert.equal(cleared.settings.configured, false);
});

test('invalid input is rejected before any DB write or prompt truncation', async () => {
  const f = fixture();
  for (const input of [null, [], {}, { prompt: null, expectedVersion: 0 }, { prompt: 'x', expectedVersion: -1 },
    { prompt: 'x', expectedVersion: '0' }, { prompt: 'x', expectedVersion: 0, clinicId: 7 },
    { prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1), expectedVersion: 0 }, { prompt: '\u0000', expectedVersion: 0 }]) {
    await assert.rejects(f.service.put(input, 1), { code: 'review_reply_settings_invalid' });
  }
  assert.equal(f.counts().creates, 0);
});
