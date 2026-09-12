'use strict';

const { configFor, collectReport, safeError } = require('./report');
async function run(config) {
  configFor(config);
  const { fromInstanceMetadata, fromTemporaryCredentials } = require('@aws-sdk/credential-providers');
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand, ListCostAllocationTagsCommand } = require('@aws-sdk/client-cost-explorer');
  const { BudgetsClient, DescribeBudgetCommand } = require('@aws-sdk/client-budgets');
  const masterCredentials = fromInstanceMetadata({ timeout: 1500, maxRetries: 1 });
  const credentials = fromTemporaryCredentials({ masterCredentials,
    params: { RoleArn: config.roleArn, RoleSessionName: 'clinicaclick-cost-collector', DurationSeconds: 900 },
    clientConfig: { region: 'eu-west-3', maxAttempts: 2 } });
  const sts = new STSClient({ region: 'eu-west-3', credentials, maxAttempts: 2 });
  const ce = new CostExplorerClient({ region: 'us-east-1', credentials, maxAttempts: 2 });
  const budgets = new BudgetsClient({ region: 'us-east-1', credentials, maxAttempts: 2 });
  try {
    return await collectReport(config, {
      identity: () => sts.send(new GetCallerIdentityCommand({})),
      listTags: input => ce.send(new ListCostAllocationTagsCommand(input)),
      usage: input => ce.send(new GetCostAndUsageCommand(input)),
      forecast: input => ce.send(new GetCostForecastCommand(input)),
      budget: input => budgets.send(new DescribeBudgetCommand(input)),
    });
  } finally { sts.destroy(); ce.destroy(); budgets.destroy(); }
}
if (require.main === module) {
  (async () => {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 2048) throw Error('cost_scope_invalid'); }
    const value = await run(JSON.parse(input));
    process.stdout.write(JSON.stringify({ ok: true, snapshot: value }));
  })().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: safeError(error) })); process.exitCode = 1; });
}
module.exports = { run };
