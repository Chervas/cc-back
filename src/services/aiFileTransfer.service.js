'use strict';
const { createClient, configuration } = require('../lib/aiFileTransferClient');
let client;
module.exports = {
  // Internal only. The caller must check its existing ACL and AI pause before
  // minting. The capability stays inside this callback, then is revoked.
  withTransfer(input, callback) {
    client ||= createClient({ config: configuration(process.env.AI_FILE_TRANSFER_CONFIG_FILE) });
    return client.withTransfer(input, callback);
  },
};
