'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Capture the directories created by this fixture, never discover old datadirs.
function ownedMysqlDataLifecycle(root, data, { fsImpl = fs } = {}) {
  assert.equal(path.dirname(root), '/tmp', 'Fixture root must be directly under /tmp');
  assert(path.basename(root).startsWith('cc-campaign-opt-mysql-'), 'Unexpected fixture root');
  assert.equal(data, path.join(root, 'data'), 'Only the owned data directory may be removed');
  const identity = directory => {
    const stat = fsImpl.lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Fixture directory must not be a symlink');
    assert.equal(stat.uid, process.getuid(), 'Fixture directory must belong to this user');
    assert.equal(fsImpl.realpathSync(directory), directory, 'Fixture path must be canonical');
    return { dev: stat.dev, ino: stat.ino };
  };
  const rootIdentity = identity(root);
  assert.equal(fsImpl.lstatSync(root).mode & 0o077, 0, 'Fixture root must be private');
  const dataIdentity = identity(data);

  return ({ successful, closedCleanly, keepData = false }) => {
    if (!successful) return { status: 'retained', reason: 'test_failed' };
    if (!closedCleanly) return { status: 'retained', reason: 'unclean_shutdown' };
    if (keepData) return { status: 'retained', reason: 'explicit_keep' };
    assert.deepEqual(identity(root), rootIdentity, 'Fixture root was replaced');
    assert.deepEqual(identity(data), dataIdentity, 'Fixture data directory was replaced');
    // The result, error log and other evidence remain in root.
    fsImpl.rmSync(data, { recursive: true, force: false });
    return { status: 'removed', reason: 'successful_clean_shutdown' };
  };
}

module.exports = { ownedMysqlDataLifecycle };
