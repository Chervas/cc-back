'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const controller = require('../../controllers/notifications.controller');

async function run() {
  const originalDestroy = db.Notification.destroy;
  let destroyWhere = null;
  db.Notification.destroy = async ({ where }) => {
    destroyWhere = where;
    return 7;
  };

  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  try {
    await controller.removeAll({ userData: { userId: 321 } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, { deleted: 7 });
    assert.deepEqual(destroyWhere, { userId: 321 });
  } finally {
    db.Notification.destroy = originalDestroy;
    await db.sequelize.close();
  }

  console.log('notifications_bulk_delete.test.js OK');
}

run().catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch {}
  process.exit(1);
});
