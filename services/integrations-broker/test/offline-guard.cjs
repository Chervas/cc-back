'use strict';

const net = require('node:net');
const original = net.Socket.prototype.connect;
const ports = new Set();
net.Socket.prototype.connect = function (...args) {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = typeof value === 'object' ? Number(value.port) : Number(value);
  const host = typeof value === 'object' ? value.host : args[1];
  if (!ports.has(port) || !['127.0.0.1', '::1'].includes(host)) throw Error('EXTERNAL_NETWORK_FORBIDDEN_IN_BROKER_QA');
  return original.apply(this, args);
};
global.fetch = async () => { throw Error('FETCH_FORBIDDEN_IN_BROKER_QA'); };
module.exports = { allowPort: port => ports.add(port), removePort: port => ports.delete(port) };
