'use strict';
module.exports = {
  up: qi => qi.addIndex('PlatformAuditEvents', ['state', 'occurred_at', 'event_id'], { name: 'idx_platform_audit_view' }),
  down: qi => qi.removeIndex('PlatformAuditEvents', 'idx_platform_audit_view'),
};
