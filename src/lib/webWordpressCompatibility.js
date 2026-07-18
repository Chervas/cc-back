'use strict';

const MIN_GLOBAL_INTAKE_PLUGIN_VERSION = '2.0.0-alpha.7';

function parseSemver(value) {
  const match = String(value || '').trim().match(
    /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match) return null;
  const numeric = match.slice(1, 4).map((part) => Number(part));
  if (numeric.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((identifier) => ({
        value: identifier,
        numeric: /^(0|[1-9][0-9]*)$/.test(identifier),
        invalidNumeric: /^[0-9]+$/.test(identifier) && !/^(0|[1-9][0-9]*)$/.test(identifier),
      }))
    : [];
  if (prerelease.some((identifier) => (
    identifier.invalidNumeric
      || (identifier.numeric && !Number.isSafeInteger(Number(identifier.value)))
  ))) {
    return null;
  }
  return { numeric, prerelease };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numeric[index] !== b.numeric[index]) {
      return a.numeric[index] < b.numeric[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (!aIdentifier || !bIdentifier) return aIdentifier ? 1 : -1;
    if (aIdentifier.value === bIdentifier.value) continue;
    if (aIdentifier.numeric && bIdentifier.numeric) {
      return Number(aIdentifier.value) < Number(bIdentifier.value) ? -1 : 1;
    }
    if (aIdentifier.numeric !== bIdentifier.numeric) return aIdentifier.numeric ? -1 : 1;
    return aIdentifier.value < bIdentifier.value ? -1 : 1;
  }
  return 0;
}

function semverAtLeast(actual, minimum) {
  const comparison = compareSemver(actual, minimum);
  return comparison !== null && comparison >= 0;
}

function documentHasGlobalIntakeForm(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  const nodes = document.nodes && typeof document.nodes === 'object' && !Array.isArray(document.nodes)
    ? document.nodes
    : {};
  const roots = [document.globals?.header_node_id, document.globals?.footer_node_id]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const pending = [...roots];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes[id];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (node.type === 'intake_form') return true;
    for (const childId of Array.isArray(node.children) ? node.children : []) {
      const normalized = String(childId || '').trim();
      if (normalized) pending.push(normalized);
    }
  }
  return false;
}

function manifestHasGlobalIntakeContract(manifest) {
  const forms = manifest?.intake_forms;
  if (!forms || typeof forms !== 'object' || Array.isArray(forms)) return false;
  return Object.values(forms).some((contract) => (
    contract
    && typeof contract === 'object'
    && !Array.isArray(contract)
    && (
      contract.scope === 'global'
      || (contract.page_contracts
        && typeof contract.page_contracts === 'object'
        && !Array.isArray(contract.page_contracts))
    )
  ));
}

module.exports = {
  MIN_GLOBAL_INTAKE_PLUGIN_VERSION,
  compareSemver,
  documentHasGlobalIntakeForm,
  manifestHasGlobalIntakeContract,
  parseSemver,
  semverAtLeast,
};
