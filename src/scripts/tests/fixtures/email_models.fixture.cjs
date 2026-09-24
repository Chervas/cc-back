'use strict';
require('./security_offline_runtime.cjs');
// Unit tests replace individual operations. Unconfigured SQL is always an error;
// importing the application model index is unnecessary and forbidden here.
const forbidden = () => { throw Error('UNEXPECTED_EMAIL_TEST_DATABASE_CALL'); };
const stub = () => Object.fromEntries(['findOne','findByPk','findAll','findOrCreate','findAndCountAll','create','update','count','destroy','transaction','query'].map(name => [name, forbidden]));
const db = { sequelize: stub(), Sequelize: require('sequelize') };
for (const name of ['literal','fn','col','where']) db.sequelize[name] = db.Sequelize[name];
for (const name of [
  'EmailMessage','EmailProviderEvent','EmailSuppression','PasswordResetToken','SystemNotificationDelivery','Usuario','JobRequest',
  'MarketingPatientList','MarketingPatientListItem','MarketingPatientContactEvent','MarketingEmailUnsubscribe',
  'EmailSenderIdentity','EmailSendingDomain','MarketingEmailTemplate','Clinica',
]) db[name] = stub();
const id = require.resolve('../../../../models');
if (require.cache[id]) throw Error('EMAIL_TEST_MODEL_CACHE_ALREADY_POPULATED');
require.cache[id] = { id, filename: id, loaded: true, exports: db };
module.exports = db;
