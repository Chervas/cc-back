'use strict';
const { createHash } = require('node:crypto');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// The caller supplies a reviewed manifest and an open SQL transaction. This
// only removes administrative notices from active tracking, never an inbox ACK.
async function archiveReviewedNotices({ query, receipts, reason }) {
  if (!Array.isArray(receipts) || !receipts.length || receipts.length > 5000
    || receipts.some(receipt => !uuid(receipt)) || new Set(receipts).size !== receipts.length
    || !/^historical_cleanup_[0-9]{8}$/.test(reason || '')) throw Error('notice_archive_manifest_invalid');
  const placeholders = receipts.map(() => '?').join(',');
  const rows = await query(`SELECT receipt,reconciled_at,archived_at FROM WhatsappInboxAdminSync
    WHERE receipt IN (${placeholders}) FOR UPDATE`, receipts);
  if (rows.length !== receipts.length || new Set(rows.map(row => row.receipt)).size !== receipts.length
    || rows.some(row => !receipts.includes(row.receipt) || row.reconciled_at || row.archived_at)) {
    throw Error('notice_archive_manifest_changed');
  }
  const result = await query(`UPDATE WhatsappInboxAdminSync SET archived_at=NOW(3),archive_reason=?
    WHERE receipt IN (${placeholders}) AND reconciled_at IS NULL AND archived_at IS NULL`, [reason, ...receipts]);
  if (result.affectedRows !== receipts.length) throw Error('notice_archive_count_changed');
  return { archived: receipts.length, manifestSha256: createHash('sha256').update(JSON.stringify([...receipts].sort())).digest('hex'),
    reconciled: false, clinicalReceiptsChanged: false };
}
module.exports = { archiveReviewedNotices };
