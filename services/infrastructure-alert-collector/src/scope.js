'use strict';
const ACCOUNT = '137819318729';
const REGION = 'eu-west-3';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-platform-alerts-role`;
const QUEUE_NAME = 'clinicaclick-mysql-staging-operations-alerts';
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:${QUEUE_NAME}`;
const QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${QUEUE_NAME}`;
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:${QUEUE_NAME}`;
const CREDENTIALS_PROCESS = '/usr/local/libexec/clinicaclick-infrastructure-alert-credentials';
const fail = code => { throw Error(code); };
const validHandle = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
function parseInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('alerts_input_invalid');
  const keys = Object.keys(value).sort().join(',');
  if (value.operation === 'receive' && keys === 'max,operation,visibilitySeconds'
    && Number.isInteger(value.max) && value.max >= 1 && value.max <= 10 && value.visibilitySeconds === 120) return value;
  if (value.operation === 'ack' && keys === 'operation,receiptHandle' && validHandle(value.receiptHandle)) return value;
  fail('alerts_input_invalid');
}
function verifyIdentity(value) {
  if (value?.Account !== ACCOUNT || typeof value.Arn !== 'string'
    || !new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-platform-alerts-role/[A-Za-z0-9+=,.@_-]{1,128}$`).test(value.Arn)) fail('alerts_identity_invalid');
  return { accountId: ACCOUNT, roleArn: ROLE };
}
function verifyQueue(value) {
  const a = value?.Attributes;
  if (a?.QueueArn !== QUEUE_ARN || a.MessageRetentionPeriod !== '1209600'
    || a.VisibilityTimeout !== '120' || a.SqsManagedSseEnabled !== 'true') fail('alerts_queue_identity_invalid');
}
function projectMessages(value, maximum) {
  const messages = value?.Messages === undefined ? [] : value.Messages;
  if (!Array.isArray(messages) || messages.length > maximum) fail('alerts_response_invalid');
  const seen = new Set();
  return messages.map(message => {
    if (!validHandle(message?.ReceiptHandle) || seen.has(message.ReceiptHandle)
      || typeof message.Body !== 'string' || !message.Body.length || Buffer.byteLength(message.Body) > 65536) fail('alerts_response_invalid');
    seen.add(message.ReceiptHandle);
    return { receiptHandle: message.ReceiptHandle, snsEnvelopeRaw: message.Body };
  });
}
const SAFE = new Set(['alerts_input_invalid', 'alerts_identity_invalid', 'alerts_queue_identity_invalid',
  'alerts_response_invalid', 'alerts_credentials_invalid', 'alerts_credentials_unavailable', 'alerts_timeout', 'alerts_ack_unknown']);
const safeError = error => SAFE.has(error?.message) ? error.message : error?.name === 'AbortError' ? 'alerts_timeout' : 'alerts_transport_unavailable';
module.exports = { ACCOUNT, REGION, ROLE, QUEUE_ARN, QUEUE_URL, TOPIC_ARN, CREDENTIALS_PROCESS,
  fail, validHandle, parseInput, verifyIdentity, verifyQueue, projectMessages, safeError };
