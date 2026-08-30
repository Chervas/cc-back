'use strict';

const systemNotificationsService = require('../services/systemNotifications.service');
const jobScheduler = require('../services/jobScheduler.service');
const { isGlobalAdmin } = require('../lib/role-helpers');

function assertGlobalAdmin(req, res) {
  if (!isGlobalAdmin(req.userData?.userId)) {
    res.status(403).json({ success: false, error: 'admin_only' });
    return false;
  }
  return true;
}

function errorCode(error) {
  return error?.code || error?.message || 'system_monitoring_error';
}

function channelOverrides(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!raw) return null;
  const allowed = ['panel', 'email', 'whatsapp'];
  const picked = {};
  for (const channel of allowed) {
    if (raw[channel] !== undefined) picked[channel] = raw[channel] === true;
  }
  return Object.keys(picked).length ? picked : null;
}

async function triggerCreatedJobs(queueResult) {
  const jobs = Array.isArray(queueResult?.created) ? queueResult.created : [];
  const results = await Promise.allSettled(
    jobs
      .map((item) => Number(item.jobRequestId || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
      .map((id) => jobScheduler.triggerImmediate(id))
  );
  return results.map((result) => (
    result.status === 'fulfilled'
      ? { ok: true, triggered: result.value }
      : { ok: false, error: errorCode(result.reason) }
  ));
}

exports.notificationsOverview = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    res.json(await systemNotificationsService.getOverview());
  } catch (error) {
    console.error('[system-monitoring] overview failed:', errorCode(error));
    res.status(error?.status || 500).json({ success: false, error: errorCode(error) });
  }
};

exports.updateNotificationSettings = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    res.json(await systemNotificationsService.updateSettings(req.body || {}));
  } catch (error) {
    console.error('[system-monitoring] settings update failed:', errorCode(error));
    res.status(error?.status || 500).json({ success: false, error: errorCode(error) });
  }
};

exports.prepareWhatsappTemplate = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const result = await systemNotificationsService.ensureSystemWhatsappTemplate({ submitToMeta: true });
    res.json({
      success: Boolean(result?.ok),
      reason: result?.reason || null,
      overview: await systemNotificationsService.getOverview(),
    });
  } catch (error) {
    console.error('[system-monitoring] whatsapp template prepare failed:', errorCode(error));
    res.status(error?.status || 500).json({ success: false, error: errorCode(error) });
  }
};

exports.sendTestNotification = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const queueResult = await systemNotificationsService.queueNotification({
      eventKey: 'system.notification_test',
      payload: {
        title: req.body?.title,
        message: req.body?.message,
        action: req.body?.action,
        severity: req.body?.severity || 'info',
      },
      force: true,
      channelsOverride: channelOverrides(req.body?.channels),
      metadata: {
        source: 'system_monitoring_manual_test',
        dry_run: req.body?.dryRun === true || req.body?.dry_run === true,
      },
    });
    const triggered = req.body?.runImmediately === false ? [] : await triggerCreatedJobs(queueResult);
    await systemNotificationsService.ensureSettings().then((setting) => setting.update({ last_tested_at: new Date() }));
    res.status(202).json({ success: true, queue: queueResult, triggered });
  } catch (error) {
    console.error('[system-monitoring] test notification failed:', errorCode(error));
    res.status(error?.status || 500).json({ success: false, error: errorCode(error) });
  }
};

exports.runNotificationCheck = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const result = await systemNotificationsService.runActiveChecks({ force: req.body?.force === true });
    const queues = Array.isArray(result?.queued) ? result.queued : [];
    const triggerResults = [];
    if (req.body?.runImmediately !== false) {
      for (const queueResult of queues) {
        triggerResults.push(...await triggerCreatedJobs(queueResult));
      }
    }
    res.status(202).json({ success: true, result, triggered: triggerResults });
  } catch (error) {
    console.error('[system-monitoring] notification check failed:', errorCode(error));
    res.status(error?.status || 500).json({ success: false, error: errorCode(error) });
  }
};
