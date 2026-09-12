'use strict';
const fail = () => { throw Error('NETWORK_FORBIDDEN_IN_AUDIT_QA'); };
const net = require('node:net'); const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = fail;
global.fetch = fail;
exports.httpsAgentForTestServer = server => {
  const https = require('node:https'); const tls = require('node:tls');
  if (!(server instanceof https.Server) || !server.listening || server.address()?.address !== '127.0.0.1') fail();
  const port = server.address().port; const agent = new https.Agent();
  agent.createConnection = (options, callback) => {
    if (!server.listening || server.address()?.port !== port || options.host !== '127.0.0.1' || Number(options.port) !== port) fail();
    const socket = original.call(new net.Socket(), { host: '127.0.0.1', port });
    return tls.connect({ ...options, socket }, callback);
  };
  return agent;
};
