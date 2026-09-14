'use strict';
const { privateFile } = require('./reader-main');
const { sourceRole } = require('./batch');
function main(filename) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('audit_writer_node24_required');
  const config = JSON.parse(privateFile(filename)); sourceRole(config.sourceRoleArn);
  if (config.credentialMode && config.credentialMode !== 'unix-scoped') throw Error('audit_writer_configuration_invalid');
  if (config.credentialMode === 'unix-scoped' && config.brokerSourceRoleArn !== config.sourceRoleArn) throw Error('audit_writer_configuration_invalid');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('audit_writer_configuration_invalid');
  Object.assign(process.env, { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_V1_DISABLED: 'true', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254' });
  if (config.credentialMode === 'unix-scoped') require('./scoped-credentials').runtimeClient(config, 'writer');
  const { WriterStore } = require('./writer-store'); const { createServer } = require('./writer-server');
  const store = new WriterStore(config.stateFile);
  const write = config.credentialMode === 'unix-scoped' ? input => require('./scoped-runtime').write(input, config) : require('./writer-main').run;
  const server = createServer({ store, principals: config.principals, sourceRoleArn: config.sourceRoleArn,
    write }, { key: privateFile(config.tlsKeyFile), cert: privateFile(config.tlsCertFile) });
  server.listen(config.port, config.listenAddress || '127.0.0.1');
  const close = () => server.close(() => { store.close(); process.exitCode = 0; });
  process.once('SIGTERM', close); process.once('SIGINT', close); return { server, store };
}
if (require.main === module) { try { main(process.argv[2]); } catch { process.stderr.write('AUDIT_WRITER_START_FAILED\n'); process.exitCode = 1; } }
module.exports = { main };
