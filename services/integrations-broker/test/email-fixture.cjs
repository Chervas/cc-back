'use strict';
const { randomUUID } = require('node:crypto');
const L = require('../src/email-limits');
const credentials = { accessKeyId: 'AKIAFICTITIOUS1234567', secretAccessKey: 'FICTITIOUS_EMAIL_SECRET_0123456789abcdef' };
function payload(patch = {}) {
  return { outboxId: `em_${randomUUID()}`, attempt: 1, timeoutMs: 15000,
    templateKey: 'auth.email_verification', stream: 'transactional', recipientPolicy: 'allowlist',
    to: 'qa@example.test', from: 'QA <no-reply@example.test>', replyTo: null, configurationSet: 'qa-transactional',
    subject: 'Fictitious verification', text: 'FICTITIOUS_EMAIL_CODE_123456 ñ 日本語 👍', html: '<p>FICTITIOUS_EMAIL_BODY</p>', ...patch };
}
function binding() {
  return { connectionRef: 'email:staging', provider: L.PROVIDER, initialState: 'active',
    secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/email/ses/key-abcdef',
    email: { region: L.REGION, fromAddresses: ['QA <no-reply@example.test>'], replyToAddresses: ['qa@example.test'],
      configurationSets: ['qa-transactional'], templates: [...L.TEMPLATES], recipientAllowlist: ['qa@example.test'],
      registeredAccountTemplates: [...L.AUTH_TEMPLATES] } };
}
const accepted = () => ({ accepted: true, provider: 'ses', providerMessageId: 'fictitious-ses-message' });
const throttled = () => ({ accepted: false, code: 'email_ses_throttled', retryable: true });
module.exports = { payload, binding, credentials, accepted, throttled };
