'use strict';

const P = require('../lib/infrastructureNotificationProtocol');
const { createIngestor, createWorker } = require('../lib/infrastructureNotificationIngestion');
const transport = require('./infrastructureNotificationCollector.service');

async function runJob({ env = process.env } = {}) {
 if (!P.runtimeEnabled(env)) return { status: 'skipped', reason: 'infrastructure_notifications_disabled' };
 // No AWS SDK or application bootstrap in the API. No configuration reads or
 // child calls happen when the staging-only gate is disabled.
 const configuration = transport.loadConfiguration(env);
 const db = require('../../models');
 P.need(db.sequelize.config.host === P.HOST && db.sequelize.config.database === 'clinicaclick', 'infrastructure_database_binding');
 const { queueNotification } = require('./systemNotifications.service');
 const ingestor = createIngestor({ sequelize: db.sequelize, Receipt: db.InfrastructureNotificationReceipt,
  State: db.InfrastructureNotificationState, queueNotification, configuration });
 return createWorker({ ingest: ingestor.ingest, collector: transport.createCollector() })();
}
module.exports = { runJob };
