'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../models');

async function pendingWabaIds({ enabled = process.env.WHATSAPP_INBOX_ADMIN_SYNC_ENABLED === 'true' } = {}) {
  if (!enabled) return [];
  const rows = await db.sequelize.query(
    'SELECT DISTINCT waba_id FROM WhatsappInboxAdminSync WHERE reconciled_at IS NULL AND archived_at IS NULL',
    { type: QueryTypes.SELECT },
  );
  return rows.map(row => String(row.waba_id || '').trim()).filter(Boolean);
}

async function markReconciled(wabaId, syncStartedAt, { enabled = process.env.WHATSAPP_INBOX_ADMIN_SYNC_ENABLED === 'true' } = {}) {
  if (!enabled) return;
  await db.sequelize.query(
    'UPDATE WhatsappInboxAdminSync SET reconciled_at=NOW(3) WHERE waba_id=:wabaId AND reconciled_at IS NULL AND archived_at IS NULL AND created_at<=:syncStartedAt',
    { replacements: { wabaId, syncStartedAt }, type: QueryTypes.UPDATE },
  );
}

module.exports = { pendingWabaIds, markReconciled };
