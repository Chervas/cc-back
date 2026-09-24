'use strict';

const { OPERATION, PROVIDER } = require('./email-limits');
const contract = require('./email-contract');
const identityContract = require('./email-identity-contract');
const { createEmailIdentityHttp } = require('./email-identity-http');
const { createEmailHttp, project } = require('./email-http');
const { EmailLedger } = require('./email-ledger');

function createEmailOperations({ store, http = createEmailHttp(), identityHttp = createEmailIdentityHttp() }) {
  const ledger = new EmailLedger(store);
  const operations = { [OPERATION]: { provider: PROVIDER,
    validate: contract.validate, authorize: contract.authorize,
    async execute(context) {
      const scope = { ...context, connectionRef: context.binding.connectionRef };
      context.assertActive();
      const cached = ledger.reserve(scope);
      if (cached) return cached;
      try {
        context.assertActive();
        const result = project(await http({ payload: context.payload, token: context.secret, signal: context.signal }));
        // Persist acceptance before returning, even when the caller disconnects
        // or a block/timeout arrives after SES accepted. No second delivery.
        ledger.settle(scope, result);
        return result;
      } catch (error) { ledger.uncertain(scope); throw error; }
    },
    project,
    completionAudit: data => data.accepted ? ['integration.completed', 'success', 'email_ses_accepted']
      : ['integration.failed', 'failed', data.code],
  } };
  for (const [operation, action] of [[require('./email-limits').OPERATIONS.IDENTITY_ENSURE, 'ensure'], [require('./email-limits').OPERATIONS.IDENTITY_GET, 'get']]) {
    operations[operation] = {
      provider: PROVIDER,
      validate: identityContract.validate,
      authorize: identityContract.authorize,
      async execute(context) {
        context.assertActive();
        return identityHttp({ action, payload: context.payload, token: context.secret, signal: context.signal });
      },
      project: identityContract.project,
      completionAudit: () => ['integration.completed', 'success', action === 'ensure' ? 'email_identity_ensured' : 'email_identity_read'],
    };
  }
  return operations;
}
module.exports = { createEmailOperations };
