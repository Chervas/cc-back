'use strict';
module.exports = {
 async up(q, D) {
  await q.createTable('InfrastructureNotificationReceipts', {
   receipt_key: { type: D.CHAR(64), primaryKey: true }, topic_arn: { type: D.STRING(255), allowNull: false },
   sns_message_id: { type: D.CHAR(36), allowNull: false }, payload_sha256: { type: D.CHAR(64), allowNull: false },
   resource_arn: { type: D.STRING(512), allowNull: false }, delivery_test_nonce: { type: D.CHAR(36), unique: true },
   source_kind: { type: D.STRING(24), allowNull: false }, event_id: D.STRING(40), event_category: D.STRING(32),
   state_changed_at: { type: D.DATE(3), allowNull: false }, outcome: { type: D.STRING(16), allowNull: false },
   received_at: { type: D.DATE(3), allowNull: false }, processed_at: D.DATE(3), notification_result: D.JSON,
  }, { engine: 'InnoDB', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
  await q.createTable('InfrastructureNotificationStates', {
   alarm_key: { type: D.CHAR(64), primaryKey: true }, alarm_arn: { type: D.STRING(512), allowNull: false },
   state: { type: D.STRING(24), allowNull: false }, state_changed_at: D.DATE(3), last_receipt_key: D.CHAR(64),
   updated_at: { type: D.DATE(3), allowNull: false },
  }, { engine: 'InnoDB', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
 },
 async down() { throw Error('infrastructure_receipts_retirement_requires_explicit_review'); },
};
