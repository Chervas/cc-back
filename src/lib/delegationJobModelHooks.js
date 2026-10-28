'use strict';
const context = require('./delegationAuditContext');
function prepare(instance) {
  const read = key => typeof instance.getDataValue === 'function' ? instance.getDataValue(key) : instance[key];
  const payload = context.attachJob(read('payload'), { kind: 'native', type: String(read('type') || '') });
  if (typeof instance.setDataValue === 'function') instance.setDataValue('payload', payload);
  else instance.payload = payload;
}
function update(instance) {
  if (!instance.changed?.('payload') && !instance.changed?.('type')) return;
  if (context.current()) return prepare(instance);
  const previous = instance.previous?.('payload'), type = String(instance.getDataValue('type') || '');
  if (!previous || !Object.hasOwn(previous, context.PAYLOAD_KEY)) return prepare(instance);
  // Normal scheduler/checkpoint updates retain the already verified creator;
  // arbitrary replacement JSON is never allowed to replace that attribution.
  context.restoreJob(previous, { kind: 'native', type });
  const payload = context.cleanPayload(instance.getDataValue('payload'));
  payload[context.PAYLOAD_KEY] = previous[context.PAYLOAD_KEY];
  instance.setDataValue('payload', payload);
}
module.exports = { prepare, update, prepareBulk: instances => { for (const instance of instances) prepare(instance); } };
