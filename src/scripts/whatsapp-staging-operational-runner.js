#!/usr/bin/env node
'use strict';
// Reuse the effective public API configuration without writing another secret file.
const path=require('node:path');
const entries={ 'fresh-inbound':'whatsapp-fresh-inbound-dispatch.js', 'same-day-20260916':'whatsapp-reminders-20260916.js' };
const action=process.argv[2];if(!entries[action])throw Error('invalid_whatsapp_operational_action');
const {observedEnvironment}=require('./security-email-login-metadata');
const observed=observedEnvironment('staging');
Object.assign(process.env,observed.env);process.env.JOBS_CRON_LEADER='false';
process.chdir(observed.root);
require('../lib/whatsappBrokerClient').assertStaging(process.env);
process.argv=[process.argv[0],path.join(__dirname,entries[action]),...process.argv.slice(3)];
require(path.join(__dirname,entries[action]));
