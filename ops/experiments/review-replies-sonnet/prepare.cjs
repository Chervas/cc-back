'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function prepare(source, destination) {
  source = fs.realpathSync(source);
  destination = path.resolve(destination);
  if (fs.existsSync(destination) || destination.startsWith(source + path.sep)) throw Error('Use a new isolated destination');
  for (const relative of ['src', 'src/bedrock-contract.js', 'src/bedrock-http.js', 'src/bedrock-limits.js']) {
    if (fs.lstatSync(path.join(source, relative)).isSymbolicLink()) throw Error('Overlay targets must not be symlinks');
  }
  const contract = fs.readFileSync(path.join(source, 'src/bedrock-contract.js'));
  const http = fs.readFileSync(path.join(source, 'src/bedrock-http.js'));
  const limits = fs.readFileSync(path.join(source, 'src/bedrock-limits.js'), 'utf8');
  if (sha(contract) !== 'a9d92b8b65a5440e9baa122b3054fc2ad9f93461b727ec11421bbf031991a940') throw Error('Original contract changed; review before preparing');
  if (sha(http) !== '955444fead5f3e4dbcec39bf7b064f61e88fb98b7e7c97578c702749a94460c8') throw Error('Original HTTP changed; review before preparing');
  if (!limits.includes("'automation_attention_late_follow_up'")) throw Error('Unexpected original runtime');
  fs.cpSync(source, destination, { recursive: true, dereference: false });
  for (const [name, overlay] of [['bedrock-contract', 'contract.cjs'], ['bedrock-http', 'http.cjs']]) {
    const original = path.join(source, 'src', name + '.js');
    const mode = fs.statSync(original).mode & 0o777;
    const backup = path.join(destination, 'src', name + '-original.js');
    const target = path.join(destination, 'src', name + '.js');
    fs.copyFileSync(original, backup);
    fs.chmodSync(backup, mode);
    fs.copyFileSync(path.join(__dirname, overlay), target);
    // copyFileSync adopts the overlay's mode (often 0600 after upload).
    // The broker service UID needs exactly the original runtime permissions.
    fs.chmodSync(target, mode);
  }
  if (!limits.includes("'google_review_reply_draft'")) {
    fs.writeFileSync(path.join(destination, 'src/bedrock-limits.js'), limits.replace("'automation_attention_late_follow_up'", "'automation_attention_late_follow_up', 'google_review_reply_draft'"));
  }
  return { destination, originalContractSHA256: sha(contract), overlaySHA256: sha(fs.readFileSync(path.join(__dirname, 'contract.cjs'))),
    originalHttpSHA256: sha(http), httpOverlaySHA256: sha(fs.readFileSync(path.join(__dirname, 'http.cjs'))) };
}
if (require.main === module) console.log(JSON.stringify(prepare(process.argv[2], process.argv[3])));
module.exports = { prepare };
