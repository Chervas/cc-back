'use strict';
module.exports = {
  async up(qi) {
    // One atomic MySQL 8 DDL; default part 0 preserves uniqueness of older codecs.
    await qi.sequelize.query('ALTER TABLE PlatformAuditEvents ADD COLUMN result_part INT UNSIGNED NOT NULL DEFAULT 0, '
      + 'DROP INDEX uq_platform_audit_stage, ADD UNIQUE INDEX uq_platform_audit_stage (correlation_id, stage, result_part)');
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query("SELECT COUNT(*) AS count FROM PlatformAuditEvents WHERE result_part <> 0 OR JSON_EXTRACT(body, '$.version') = 6");
    if (Number(rows[0].count)) throw Error('platform_audit_preserve_batched_evidence');
    await qi.sequelize.query('ALTER TABLE PlatformAuditEvents DROP INDEX uq_platform_audit_stage, '
      + 'ADD UNIQUE INDEX uq_platform_audit_stage (correlation_id, stage), DROP COLUMN result_part');
  },
};
