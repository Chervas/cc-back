'use strict';
const fail = () => { throw Error('NETWORK_FORBIDDEN_IN_ALERT_QA'); };
require('node:net').Socket.prototype.connect = fail;
global.fetch = fail;
