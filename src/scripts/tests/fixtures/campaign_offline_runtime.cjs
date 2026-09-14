'use strict';

// Test-only preload: production queues and sockets must never be reached by these regressions.
const net = require('node:net');
const connect = net.Socket.prototype.connect;
const fail = () => { throw new Error('NETWORK_FORBIDDEN_IN_OFFLINE_CAMPAIGN_TEST'); };
net.Socket.prototype.connect = fail;
global.fetch = fail;
const filename = require.resolve('../../../services/queue.service');
const queues = Object.fromEntries(['outboundWhatsApp', 'webhookWhatsApp', 'whatsappTemplateCreate',
  'whatsappTemplateSync', 'whatsappPhoneSync', 'automationDefaults'].map(name => [name, {
  add: fail, waitUntilReady: async () => {}, close: async () => {},
}]));
require.cache[filename] = { id: filename, filename, loaded: true, exports: { queues, createWorker: fail,
  connection: { connection: { url: 'redis://offline.invalid:1' } } } };

// Only a server created by the test can receive HTTP; provider and database sockets remain blocked.
exports.connectionForTestServer = server => {
  if (!(server instanceof require('node:http').Server) || !server.listening) fail();
  const address = server.address();
  if (!address || address.address !== '127.0.0.1') fail();
  return (_options, callback) => {
    if (!server.listening || server.address()?.port !== address.port) fail();
    return connect.call(new net.Socket(), { host: address.address, port: address.port }, callback);
  };
};
