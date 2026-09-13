'use strict';
const { fixture } = require('../../../../services/integrations-broker/test/whatsapp-onboarding-fixture.cjs');
const { createWhatsappOnboardingBrokerClient } = require('../../../lib/whatsappOnboardingBrokerClient');
function brokerForGateway(t) {
  const f = fixture(t); const b = f.binding.whatsappOnboarding;
  const metadata = { connectionRef: f.binding.connectionRef, ...Object.fromEntries(['scopeKey','clinicIds','appId','configId','redirectUri','scopes'].map(k => [k, b[k]])) };
  const state = { calls: [], before: null, after: null, binding: metadata };
  const transport = { async execute(command) {
    state.calls.push(command.operation); await state.before?.(command);
    const signed = f.signed(command); const result = await f.current.broker.execute(signed.raw, signed.headers);
    return state.after ? state.after(command, result) : result;
  } };
  const client = createWhatsappOnboardingBrokerClient({ client: transport, loadBinding: async () => state.binding, guard: () => {} });
  return { f, state, client, transport, metadata };
}
module.exports = { brokerForGateway };
