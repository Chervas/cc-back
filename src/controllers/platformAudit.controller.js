'use strict';
const monitor = require('../services/platformAudit.monitor');
exports.events = async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { return res.json(await require('../services/platformAudit.view').read({ actorId: req.userData?.userId,
    sessionRef: req.authSession?.id, query: req.query })); }
  catch (error) {
    const status = [400, 403].includes(error?.status) ? error.status : 503;
    return res.status(status).json({ error: status === 400 ? 'audit_query_invalid' : status === 403 ? 'audit_view_denied' : 'audit_view_unavailable' });
  }
};
exports.health = async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { return res.json(await monitor.getHealth(req.userData?.userId)); }
  catch (error) {
    if (error?.status === 403) return res.status(403).json({ error: 'technical_admin_required' });
    const missing = [error?.original?.code, error?.parent?.code].includes('ER_NO_SUCH_TABLE');
    return res.status(503).json({ error: missing ? 'audit_migration_required' : 'audit_monitor_unavailable' });
  }
};
