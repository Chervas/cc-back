'use strict';
// Read-only bridge for operational consumers. A discovered candidate is not an
// operational authorization; registry.assert still verifies its explicit grant.
const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');
const { privateFile } = require('./google-main');
const { validateConfig } = require('./whatsapp-onboarding-main');
const { bindingFromSlot } = require('./whatsapp-provisioning-contract');
const { BrokerError, fail } = require('./errors');
function enrollmentLoader(config) {
  return ref => {
    let body; let db;
    try {
      body = privateFile(config.enrollmentConfigFile);
      const current = validateConfig(JSON.parse(body.toString('utf8')));
      if (current.stateFile !== config.enrollmentStateFile) fail('invalid_request');
      const binding = current.policy.connections.find(value => value.connectionRef === ref);
      if (binding || !current.provisioning) return binding;
      const stat = fs.statSync(current.stateFile);
      if (!stat.isFile() || stat.mode & 0o077 || fs.realpathSync(current.stateFile) !== current.stateFile) fail('invalid_request');
      db = new DatabaseSync(current.stateFile,{readOnly:true}); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
      const row = db.prepare('SELECT * FROM whatsapp_provisioned_slots WHERE connection=?').get(ref);
      return row ? bindingFromSlot(current.provisioning,row) : undefined;
    } catch(error) { throw new BrokerError(error instanceof BrokerError ? error.code : 'connection_blocked'); }
    finally { body?.fill(0); db?.close(); }
  };
}
module.exports = { enrollmentLoader };
