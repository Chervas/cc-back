'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const { ADMIN_USER_IDS } = require('../../lib/role-helpers');
const flowEngine = require('../../services/flowEngineV2.service');

async function main() {
  const userId = Number(ADMIN_USER_IDS[0]);
  assert.ok(userId, 'an administrative QA recipient is required');

  const executionId = `qa-persistent-alert-${Date.now()}`;
  const nodeId = 'QA_ALERT';
  const dedupeKey = `automation:${executionId}:${nodeId}:${userId}`;
  const fallbackExecutionId = `qa-persistent-alert-fallback-${Date.now()}`;
  const fallbackDedupePrefix = `automation:${fallbackExecutionId}:QA_ALERT_FALLBACK:`;
  const node = {
    id: nodeId,
    type: 'action/send_system_notification',
    config: {
      title: 'QA alerta persistente idempotente',
      message: 'Prueba automatizada sin información de pacientes.',
      assignee_type: 'user',
      assignee_id: userId,
      display_mode: 'persistent_alert',
      alert_level: 'error',
      presentation_preference_key: 'automation.appointment_data.confirmed_with_reply',
    },
    outputs: { on_success: null, on_fail: null },
  };
  const context = { clinic: { id: 66 } };
  const runtime = { execution: { id: executionId, clinic_id: 66, trigger_type: 'qa' } };

  try {
    const first = await flowEngine._processNode(node, context, runtime);
    const second = await flowEngine._processNode(node, context, runtime);
    const rows = await db.Notification.findAll({ where: { dedupeKey }, raw: true });

    assert.equal(first.output.notifications_created, 1);
    assert.equal(second.output.notifications_created, 0);
    assert.equal(second.output.notifications_reused, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'automation.persistent_alert');
    assert.equal(rows[0].level, 'error');
    assert.equal(rows[0].data?.displayMode, 'persistent_alert');
    assert.equal(
      rows[0].data?.presentationPreferenceKey,
      'automation.appointment_data.confirmed_with_reply',
    );
    assert.equal(rows[0].data?.requiresAcknowledgement, true);

    const fallback = await flowEngine._processNode({
      ...node,
      id: 'QA_ALERT_FALLBACK',
      config: {
        ...node.config,
        assignee_type: 'user',
        assignee_id: 2147483647,
      },
      outputs: { on_success: null },
    }, context, {
      execution: { id: fallbackExecutionId, clinic_id: 66, trigger_type: 'qa' },
    });
    assert.equal(fallback.output.used_admin_fallback, true);
    assert.ok(fallback.output.notifications_created >= 1);
    for (const adminUserId of ADMIN_USER_IDS) {
      assert.ok(fallback.output.assignee_user_ids.includes(adminUserId));
    }
    assert.equal(fallback.output.assignee_user_ids.includes(2147483647), false);

    const originalFindOrCreate = db.Notification.findOrCreate;
    db.Notification.findOrCreate = async () => {
      throw new Error('qa_notification_persistence_failure');
    };
    try {
      await assert.rejects(
        flowEngine._processNode({
          ...node,
          id: 'QA_ALERT_PERSISTENCE_FAILURE',
          outputs: { on_success: null },
        }, context, {
          execution: {
            id: `qa-persistent-alert-error-${Date.now()}`,
            clinic_id: 66,
            trigger_type: 'qa',
          },
        }),
        /qa_notification_persistence_failure/,
      );
    } finally {
      db.Notification.findOrCreate = originalFindOrCreate;
    }
    console.log('system_notification_idempotency.test.js OK');
  } finally {
    await db.Notification.destroy({ where: { dedupeKey } });
    await db.Notification.destroy({
      where: { dedupeKey: { [Op.like]: `${fallbackDedupePrefix}%` } },
    });
  }
}

main().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_closeError) {}
  process.exit(1);
});
