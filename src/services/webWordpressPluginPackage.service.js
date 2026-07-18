'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../../models');
const { canonicalSerialize } = require('../lib/webDocument');
const { openBootstrapTicket } = require('../lib/webWordpressBootstrapTicket');
const { scopeColumns } = require('./webProjects.service');
const wordpress = require('./webWordpressInstallations.service');
const { WebPublicationServiceError } = require('./webPublications.service');

const PLUGIN_VERSION = '2.0.0-alpha.3';
const PLUGIN_ARCHIVE_ROOT = 'clinicaclick-web';
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '../../wordpress/clinicaclick-web');
const MAX_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function packageError(code, message, status = 503) {
  throw new WebPublicationServiceError(code, message, status);
}

function secureTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safePluginRoot(value = process.env.MARKETING_WEB_PLUGIN_SOURCE_ROOT) {
  const root = path.resolve(String(value || DEFAULT_PLUGIN_ROOT));
  if (!path.isAbsolute(root) || root === '/' || root.length < 8) {
    packageError('web_wordpress_plugin_source_invalid', 'El paquete mantenido de WordPress no está disponible.');
  }
  return root;
}

async function sourceEntries(pluginRoot) {
  const includesRoot = path.join(pluginRoot, 'includes');
  const includeNames = (await fs.readdir(includesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^class-ccw-[a-z0-9-]+\.php$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (includeNames.length < 5) {
    packageError('web_wordpress_plugin_source_incomplete', 'El paquete mantenido de WordPress está incompleto.');
  }
  return [
    ['clinicaclick.php', `${PLUGIN_ARCHIVE_ROOT}/clinicaclick.php`],
    ['uninstall.php', `${PLUGIN_ARCHIVE_ROOT}/uninstall.php`],
    ['readme.txt', `${PLUGIN_ARCHIVE_ROOT}/readme.txt`],
    ['README.md', `${PLUGIN_ARCHIVE_ROOT}/README.md`],
    ...includeNames.map((name) => [`includes/${name}`, `${PLUGIN_ARCHIVE_ROOT}/includes/${name}`]),
  ];
}

async function readSafeSource(root, relative) {
  const source = path.resolve(root, relative);
  const rootReal = await fs.realpath(root);
  const sourceReal = await fs.realpath(source);
  if (!sourceReal.startsWith(`${rootReal}${path.sep}`)) {
    packageError('web_wordpress_plugin_source_invalid', 'El paquete mantenido de WordPress contiene una ruta no permitida.');
  }
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_SOURCE_FILE_BYTES) {
    packageError('web_wordpress_plugin_source_invalid', 'El paquete mantenido de WordPress contiene un fichero no permitido.');
  }
  return fs.readFile(source);
}

function installationConfig(credentials) {
  const body = canonicalSerialize(credentials);
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024) {
    packageError('web_wordpress_plugin_config_too_large', 'La configuración del plugin supera el tamaño permitido.');
  }
  return Buffer.from(`<?php http_response_code(404); exit; __halt_compiler(); ?>\n${body}\n`, 'utf8');
}

function zipStored(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (7 << 5) | 17;
  for (const entry of entries) {
    const archivePath = String(entry.path || '');
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body || '');
    if (!/^clinicaclick-web\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(archivePath)) {
      packageError('web_wordpress_plugin_archive_path_invalid', 'El paquete contiene una ruta no permitida.');
    }
    const name = Buffer.from(archivePath, 'utf8');
    const checksum = crc32(body);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, name, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0x81a40000, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + body.length;
  }
  const localBody = Buffer.concat(local);
  const centralBody = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(localBody.length, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([localBody, centralBody, end]);
  if (archive.length > MAX_PACKAGE_BYTES) {
    packageError('web_wordpress_plugin_package_too_large', 'El paquete de WordPress supera el tamaño permitido.');
  }
  return archive;
}

async function buildProvisionedPluginPackage({ credentials, pluginRoot = null } = {}) {
  const root = safePluginRoot(pluginRoot);
  const definitions = await sourceEntries(root);
  const entries = [];
  for (const [relative, archivePath] of definitions) {
    entries.push({ path: archivePath, body: await readSafeSource(root, relative) });
  }
  entries.push({ path: `${PLUGIN_ARCHIVE_ROOT}/config/installation.php`, body: installationConfig(credentials) });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const buffer = zipStored(entries);
  return {
    buffer,
    filename: 'clinicaclick-web.zip',
    content_type: 'application/zip',
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size_bytes: buffer.length,
    plugin_version: PLUGIN_VERSION,
    entries: entries.map((entry) => entry.path),
  };
}

async function provisionWordpressPluginPackage({
  actorId,
  installationId,
  bootstrapTicket,
  requestId = null,
  env = process.env,
  models = db,
  pluginRoot = null,
  signingOptions = {},
  getInstallation = wordpress.getInstallationForActor,
} = {}) {
  const ticket = openBootstrapTicket(bootstrapTicket, { env });
  const actor = Number(actorId);
  if (ticket.actor_id !== actor || ticket.installation_id !== String(installationId || '').trim().toLowerCase()) {
    packageError('web_wordpress_bootstrap_ticket_invalid', 'La descarga del plugin ha caducado o no es válida.', 410);
  }
  const { installation, scope } = await getInstallation({ actorId: actor, installationId, models });
  if (installation.status === 'revoked' || !secureTextEqual(
    wordpress.tokenHash(ticket.token),
    installation.tokenHash
  )) {
    packageError('web_wordpress_bootstrap_ticket_invalid', 'La descarga del plugin ha caducado o no es válida.', 410);
  }
  // The bootstrap package establishes identity and the out-of-band trust
  // anchor only. It must be installable while the connection is still
  // pending; signed runtime/artifact state arrives later through desired-state.
  const descriptor = wordpress.pluginKeyDescriptor(signingOptions);
  if (!secureTextEqual(descriptor.key_id, installation.publicKeyId)) {
    packageError(
      'web_installation_signing_key_rotation_required',
      'La instalación necesita completar la rotación de la clave de publicación.',
      409
    );
  }
  const apiBase = wordpress.installationApiBase(env);
  const result = await buildProvisionedPluginPackage({
    pluginRoot,
    credentials: {
      installation_id: installation.id,
      api_base: apiBase,
      token: ticket.token,
      trust_descriptor: descriptor,
    },
  });
  await models.WebAuditEvent.create({
    projectId: null,
    ...scopeColumns(scope),
    actorUserId: actor,
    eventType: 'web.wordpress_installation.plugin_downloaded',
    entityType: 'web_wordpress_installation',
    entityId: installation.id,
    requestId,
    metadata: {
      plugin_version: result.plugin_version,
      package_sha256: result.sha256,
      bootstrap_status: installation.status,
      desired_artifact_hash: null,
    },
  });
  return result;
}

module.exports = {
  DEFAULT_PLUGIN_ROOT,
  MAX_PACKAGE_BYTES,
  PLUGIN_ARCHIVE_ROOT,
  PLUGIN_VERSION,
  buildProvisionedPluginPackage,
  crc32,
  provisionWordpressPluginPackage,
  safePluginRoot,
  zipStored,
};
