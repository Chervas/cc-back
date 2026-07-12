'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function targetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function ipv4Bytes(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  });
  return bytes.some((value) => value === null) ? null : bytes;
}

function ipv6Bytes(address) {
  let value = normalizeHostname(address).split('%')[0];
  if (!value) return null;

  const ipv4TailMatch = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4TailMatch) {
    const tail = ipv4Bytes(ipv4TailMatch[1]);
    if (!tail) return null;
    value = value.slice(0, -ipv4TailMatch[1].length)
      + `${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;

  const bytes = [];
  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    bytes.push((parsed >> 8) & 0xff, parsed & 0xff);
  }
  return bytes;
}

function cidrContains(bytes, prefixBytes, prefixLength) {
  if (!bytes || !prefixBytes || bytes.length !== prefixBytes.length) return false;
  const wholeBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== prefixBytes[index]) return false;
  }
  if (!remainingBits) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes] & mask) === (prefixBytes[wholeBytes] & mask);
}

function ipv4InCidr(bytes, prefix, prefixLength) {
  return cidrContains(bytes, ipv4Bytes(prefix), prefixLength);
}

function ipv6InCidr(bytes, prefix, prefixLength) {
  return cidrContains(bytes, ipv6Bytes(prefix), prefixLength);
}

function isUnsafeIpv4(address) {
  const bytes = ipv4Bytes(address);
  if (!bytes) return true;
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([prefix, length]) => ipv4InCidr(bytes, prefix, length));
}

function isUnsafeIpv6(address) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  // Only currently allocated global-unicast space is eligible. Explicitly
  // exclude special-purpose ranges contained inside 2000::/3 as well.
  if (!ipv6InCidr(bytes, '2000::', 3)) return true;
  return [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['2620:4f:8000::', 48],
    ['3fff::', 20],
  ].some(([prefix, length]) => ipv6InCidr(bytes, prefix, length));
}

function isUnsafeIpAddress(address) {
  const clean = normalizeHostname(address).split('%')[0];
  const family = net.isIP(clean);
  if (family === 4) return isUnsafeIpv4(clean);
  if (family === 6) return isUnsafeIpv6(clean);
  return true;
}

/**
 * Performs the synchronous part of public URL validation. This is suitable for
 * persisting a destination or client preview: it rejects credentials, local
 * hostnames and non-public IP literals without performing a network lookup.
 * Call resolveSafeHttpTarget as well before the server ever fetches the URL.
 */
function publicHttpUrl(rawUrl, { requireHttps = false } = {}) {
  if (typeof rawUrl !== 'string') return null;
  const clean = rawUrl.trim();
  if (!clean) return null;

  let parsed;
  try {
    parsed = new URL(clean);
  } catch (_error) {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || (requireHttps && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password) {
    return null;
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')) {
    return null;
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily && isUnsafeIpAddress(hostname)) return null;
  // A single-label non-IP hostname is an intranet target, not a public URL.
  if (!literalFamily && !hostname.includes('.')) return null;
  return parsed.toString();
}

function normalizeResolvedAddresses(rows) {
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const address = normalizeHostname(typeof row === 'string' ? row : row?.address).split('%')[0];
    const family = net.isIP(address);
    if (!family) continue;
    unique.set(`${family}:${address}`, { address, family });
  }
  return Array.from(unique.values());
}

async function resolvePublicAddresses(hostname, { lookup = dns.lookup } = {}) {
  const cleanHostname = normalizeHostname(hostname);
  if (!cleanHostname) throw targetError('INVALID_TARGET_HOST', 'El destino no tiene un host válido');

  const literalFamily = net.isIP(cleanHostname);
  const addresses = literalFamily
    ? [{ address: cleanHostname, family: literalFamily }]
    : normalizeResolvedAddresses(await lookup(cleanHostname, { all: true, verbatim: true }));
  if (!addresses.length) {
    throw targetError('TARGET_DNS_EMPTY', 'El dominio no resolvió ninguna dirección IP');
  }
  const unsafe = addresses.find((item) => isUnsafeIpAddress(item.address));
  if (unsafe) {
    throw targetError('UNSAFE_TARGET_ADDRESS', `El dominio resuelve a una dirección no pública (${unsafe.address})`);
  }
  return addresses;
}

function createPinnedLookup(hostname, addresses) {
  const expectedHostname = normalizeHostname(hostname);
  const pinned = normalizeResolvedAddresses(addresses);
  if (!expectedHostname || !pinned.length || pinned.some((item) => isUnsafeIpAddress(item.address))) {
    throw targetError('INVALID_PINNED_TARGET', 'No se puede fijar un destino HTTP no validado');
  }

  return (requestedHostname, options, callback) => {
    let normalizedOptions = options;
    let done = callback;
    if (typeof options === 'function') {
      done = options;
      normalizedOptions = {};
    } else if (typeof options === 'number') {
      normalizedOptions = { family: options };
    }
    if (normalizeHostname(requestedHostname) !== expectedHostname) {
      done(targetError('PINNED_HOST_MISMATCH', 'El cliente HTTP intentó resolver un host distinto del validado'));
      return;
    }

    const family = Number(normalizedOptions?.family) || 0;
    const candidates = family ? pinned.filter((item) => item.family === family) : pinned;
    if (!candidates.length) {
      done(targetError('PINNED_FAMILY_UNAVAILABLE', 'No hay una dirección validada para la familia IP solicitada'));
      return;
    }
    if (normalizedOptions?.all === true) {
      done(null, candidates.map((item) => ({ ...item })));
      return;
    }
    done(null, candidates[0].address, candidates[0].family);
  };
}

async function resolveSafeHttpTarget(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_error) {
    throw targetError('INVALID_TARGET_URL', 'La URL de verificación no es válida');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw targetError('INVALID_TARGET_PROTOCOL', 'Solo se permiten URLs HTTP(S) sin credenciales');
  }
  const hostname = normalizeHostname(parsed.hostname);
  const addresses = await resolvePublicAddresses(hostname, options);
  const pinnedLookup = createPinnedLookup(hostname, addresses);
  return {
    url: parsed.toString(),
    hostname,
    addresses,
    httpAgent: new http.Agent({ keepAlive: false, lookup: pinnedLookup }),
    httpsAgent: new https.Agent({ keepAlive: false, lookup: pinnedLookup }),
  };
}

module.exports = {
  createPinnedLookup,
  isUnsafeIpAddress,
  normalizeHostname,
  publicHttpUrl,
  resolvePublicAddresses,
  resolveSafeHttpTarget,
  targetError,
};
