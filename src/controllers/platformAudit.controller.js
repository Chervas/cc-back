'use strict';
const monitor = require('../services/platformAudit.monitor');
exports.health = async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { return res.json(await monitor.getHealth(req.userData?.userId)); }
  catch (error) {
    if (error?.status === 403) return res.status(403).json({ error: 'technical_admin_required' });
    const missing = [error?.original?.code, error?.parent?.code].includes('ER_NO_SUCH_TABLE');
    return res.status(503).json({ error: missing ? 'audit_migration_required' : 'audit_monitor_unavailable' });
  }
};
