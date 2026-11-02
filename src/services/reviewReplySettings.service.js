'use strict';

const { createHash } = require('node:crypto');
const { isGlobalAdmin } = require('../lib/role-helpers');

// Dedicated global row in the existing admin settings store; no clinic setting
// or provider payload is used. Reads never create a row or seed a prompt.
const SCOPE = 'google_review_reply_draft';
const MAX_PROMPT_LENGTH = 12000;
const fail = (code, status = 400) => { throw Object.assign(Error(code), { code, status }); };

function serialize(row) {
  const prompt = typeof row?.rules?.prompt === 'string' ? row.rules.prompt : '';
  return { prompt, configured: !!prompt.trim(), version: Number(row?.rules?.version) || 0,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null };
}

function createReviewReplySettings({ models, adminCheck = isGlobalAdmin } = {}) {
  const db = () => models || require('../../models');
  const checkAdmin = userId => { if (!adminCheck(userId)) fail('technical_admin_required', 403); };
  async function read() {
    return serialize(await db().SecurityMonitoringSetting.findOne({ where: { scope: SCOPE } }));
  }
  return {
    read,
    async get(userId) { checkAdmin(userId); return { success: true, settings: await read() }; },
    async status() { return { configured: (await read()).configured }; },
    async put(input, userId) {
      checkAdmin(userId);
      if (!input || Array.isArray(input) || Object.keys(input).some(k => !['prompt', 'expectedVersion'].includes(k))
        || typeof input.prompt !== 'string' || input.prompt.length > MAX_PROMPT_LENGTH
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.prompt)
        || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) fail('review_reply_settings_invalid');
      const prompt = input.prompt.trim();
      const m = db();
      return m.sequelize.transaction(async transaction => {
        const [row] = await m.SecurityMonitoringSetting.findOrCreate({ where: { scope: SCOPE },
          defaults: { scope: SCOPE, rules: { prompt: '', version: 0 }, updated_by: Number(userId) }, transaction });
        await row.reload({ transaction, lock: transaction.LOCK.UPDATE });
        const previous = serialize(row);
        if (previous.version !== input.expectedVersion) fail('review_reply_settings_version_conflict', 409);
        if (previous.prompt === prompt) return { success: true, settings: previous };
        const version = previous.version + 1;
        await row.update({ rules: { prompt, version }, updated_by: Number(userId) }, { transaction });
        await m.SecurityMonitoringChange.create({ entity_type: 'ai_reply_settings', entity_id: SCOPE,
          action: 'update', actor_id: Number(userId), detail: { version, configured: !!prompt,
            prompt_sha256: createHash('sha256').update(prompt).digest('hex') } }, { transaction });
        return { success: true, settings: serialize(row) };
      });
    },
  };
}

module.exports = { ...createReviewReplySettings(), createReviewReplySettings, SCOPE, MAX_PROMPT_LENGTH };
