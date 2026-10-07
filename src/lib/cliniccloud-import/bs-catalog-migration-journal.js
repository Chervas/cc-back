'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./adapter');
const { PRIVATE_ROOT, syncDirectory } = require('./io');
const MAX_BYTES = 64 * 1024 * 1024;
const fail = code => { throw Error(code); };
function privatePath(filename) {
    if (!path.isAbsolute(filename || '')) fail('BS_CATALOG_PRIVATE_PATH_REQUIRED');
    const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) fail('BS_CATALOG_PRIVATE_PATH_OUTSIDE_ROOT');
    for (const directory of [root, parent]) {
        const stat = fs.statSync(directory);
        if ((stat.mode & 0o077) || stat.uid !== process.getuid()) fail('BS_CATALOG_PRIVATE_DIRECTORY_INVALID');
    }
    return path.join(parent, path.basename(filename));
}
function checkedStat(descriptor) {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail('BS_CATALOG_PRIVATE_FILE_INVALID');
    return stat;
}
function readPrivateBytes(filename) {
    const descriptor = fs.openSync(privatePath(filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { checkedStat(descriptor); return fs.readFileSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function readJournalEntries(bytes, planSha256) {
    const text = bytes.toString('utf8');
    if (text && !text.endsWith('\n')) fail('BS_CATALOG_JOURNAL_TRUNCATED_REQUIRES_REVIEW');
    const entries = []; let previous = null;
    for (const line of text ? text.trimEnd().split('\n') : []) {
        const item = JSON.parse(line), { entry_sha256, ...body } = item;
        if (body.plan_sha256 !== planSha256 || body.sequence !== entries.length + 1
            || body.previous_entry_sha256 !== previous || hash(body) !== entry_sha256) fail('BS_CATALOG_JOURNAL_INTEGRITY_INVALID');
        entries.push(item); previous = entry_sha256;
    }
    return entries;
}
function openBsCatalogJournal(filename, planSha256, { readOnly = false, now = () => new Date() } = {}) {
    const destination = privatePath(filename);
    const descriptor = fs.openSync(destination, readOnly ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    let entries;
    try {
        checkedStat(descriptor); entries = readJournalEntries(fs.readFileSync(descriptor), planSha256);
        if (!readOnly) { fs.fsyncSync(descriptor); syncDirectory(path.dirname(destination)); }
    } catch (error) { fs.closeSync(descriptor); throw error; }
    return { entries, filename: destination, async append(entry) {
        if (readOnly) fail('BS_CATALOG_READ_ONLY_JOURNAL');
        const body = { ...entry, plan_sha256: planSha256, sequence: entries.length + 1,
            previous_entry_sha256: entries.at(-1)?.entry_sha256 || null, journal_at: now().toISOString() };
        const item = { ...body, entry_sha256: hash(body) };
        const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
        if (checkedStat(descriptor).size + bytes.length > MAX_BYTES) fail('BS_CATALOG_JOURNAL_SIZE_LIMIT');
        let written = 0;
        while (written < bytes.length) {
            const amount = fs.writeSync(descriptor, bytes, written, bytes.length - written);
            if (amount <= 0) fail('BS_CATALOG_JOURNAL_SHORT_WRITE'); written += amount;
        }
        fs.fsyncSync(descriptor); entries.push(item); return item;
    }, close() { fs.closeSync(descriptor); } };
}
async function acquireBsCatalogExecutorLocks(connection, planSha256, filename) {
    // Serialize all catalogue plans, not only the same digest. This also avoids
    // two distinct plans creating an empty journal concurrently.
    for (const key of ['bs-catalog:crm:group29', `bs-catalog:j:${hash(privatePath(filename)).slice(0, 48)}`]) {
        const [rows] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [key]);
        if (Number(rows[0]?.acquired) !== 1) fail('BS_CATALOG_EXECUTOR_ALREADY_RUNNING');
    }
}
module.exports = { privatePath, readPrivateBytes, readJournalEntries, openBsCatalogJournal, acquireBsCatalogExecutorLocks };
