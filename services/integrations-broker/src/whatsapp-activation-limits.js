'use strict';
// Registration may finish at Meta after a short local timeout. Keep its budget
// separate from ordinary reads, with outer deadlines above the inner deadline.
module.exports = Object.freeze({
  ACTIVATE: 'meta.whatsapp.onboarding.activate.v1',
  REGISTER_TIMEOUT_MS: 60000,
  EXECUTE_TIMEOUT_MS: 90000,
  LEASE_MS: 120000,
  CLIENT_TIMEOUT_MS: 100000,
  SERVER_TIMEOUT_MS: 110000,
});
