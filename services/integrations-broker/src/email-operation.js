'use strict';

const { OPERATION, PROVIDER } = require('./email-limits');
const contract = require('./email-contract');
const { createEmailHttp, project } = require('./email-http');
const { EmailLedger } = require('./email-ledger');

function createEmailOperations({ store, http = createEmailHttp() }) {
  const ledger = new EmailLedger(store);
  return { [OPERATION]: { provider: PROVIDER,
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
}
module.exports = { createEmailOperations };
