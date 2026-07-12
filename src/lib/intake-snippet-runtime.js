'use strict';

const CURRENT_CONSENT_BRIDGE_VERSION = '3.3.0';

const readScriptAttr = (tag, attr) => {
  const re = new RegExp(`${attr}\\s*=\\s*['\"]([^'\"]+)['\"]`, 'i');
  return String(tag || '').match(re)?.[1] || null;
};

const normalizeVersion = (value) => {
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+){0,3})$/);
  return match?.[1] || null;
};

const versionAtLeast = (actual, minimum) => {
  const normalizedActual = normalizeVersion(actual);
  const normalizedMinimum = normalizeVersion(minimum);
  if (!normalizedActual || !normalizedMinimum) return false;
  const a = normalizedActual.split('.').map((part) => Number.parseInt(part, 10));
  const b = normalizedMinimum.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
};

const parseRuntimeSourceInfo = (body) => {
  const source = String(body || '');
  const version =
    normalizeVersion(source.match(/ClinicaClick\s+Intake\s+Snippet\s+v([0-9]+(?:\.[0-9]+){0,3})/i)?.[1]) ||
    normalizeVersion(source.match(/\bversion\s*:\s*['\"]([0-9]+(?:\.[0-9]+){0,3})['\"]/i)?.[1]) ||
    null;
  const hasConsentMode =
    /consent_mode_enabled/i.test(source) &&
    (/gtag\s*\(\s*['\"]consent['\"]/i.test(source) || /Consent\s+Mode/i.test(source));
  const hasProviderBridge =
    /consent_provider/i.test(source) &&
    /external_cmp_provider/i.test(source) &&
    /cmplz_has_consent/i.test(source) &&
    /cmplz_set_consent/i.test(source);
  return {
    version,
    hasConsentMode,
    hasProviderBridge,
  };
};

const parseLoaderRuntimeDescriptor = ({ body, loaderUrl, tag }) => {
  const source = String(body || '');
  const declaredVersion = normalizeVersion(
    source.match(/\bRUNTIME_VERSION\s*=\s*['\"]([0-9]+(?:\.[0-9]+){0,3})['\"]/i)?.[1]
  );
  const runtimeFile = source.match(/\bRUNTIME_FILE\s*=\s*['\"]([^'\"]+)['\"]/i)?.[1] || null;
  const explicitRuntimeUrl = readScriptAttr(tag, 'data-runtime-url');
  if (!explicitRuntimeUrl && !runtimeFile) {
    return { declaredVersion, runtimeUrl: null };
  }
  try {
    const runtimeUrl = new URL(explicitRuntimeUrl || runtimeFile, loaderUrl).toString();
    const parsed = new URL(runtimeUrl);
    if (!explicitRuntimeUrl && declaredVersion && !parsed.searchParams.has('v')) {
      parsed.searchParams.set('v', declaredVersion);
    }
    return {
      declaredVersion,
      runtimeUrl: parsed.toString(),
    };
  } catch (_error) {
    return { declaredVersion, runtimeUrl: null };
  }
};

const compareVersions = (left, right) => {
  if (versionAtLeast(left, right) && !versionAtLeast(right, left)) return 1;
  if (versionAtLeast(right, left) && !versionAtLeast(left, right)) return -1;
  return 0;
};

/**
 * Inspecciona el runtime servido realmente. La query `?v=` y la constante del
 * loader solo se conservan como diagnóstico: nunca prueban compatibilidad.
 * `fetchScript` debe aplicar allowlist, resolución DNS segura y límites HTTP.
 */
const inspectSnippetRuntime = async ({
  tags,
  checkedUrl,
  fetchScript,
  isAllowedAssetUrl,
  minimumBridgeVersion = CURRENT_CONSENT_BRIDGE_VERSION,
}) => {
  let usesLoader = false;
  let runtimeVersion = null;
  let declaredRuntimeVersion = null;
  let runtimeCompatible = false;
  let runtimeSource = null;

  const inspectRuntimeUrl = async (runtimeUrl, sourceType) => {
    if (!runtimeUrl || !isAllowedAssetUrl(runtimeUrl, checkedUrl)) return;
    const fetched = await fetchScript(runtimeUrl, checkedUrl);
    if (!fetched?.body) return;
    const actual = parseRuntimeSourceInfo(fetched.body);
    if (actual.version && (!runtimeVersion || compareVersions(actual.version, runtimeVersion) > 0)) {
      runtimeVersion = actual.version;
      runtimeSource = fetched.finalUrl || runtimeUrl;
    }
    if (
      versionAtLeast(actual.version, minimumBridgeVersion) &&
      actual.hasConsentMode &&
      actual.hasProviderBridge
    ) {
      runtimeCompatible = true;
      runtimeVersion = actual.version;
      runtimeSource = fetched.finalUrl || runtimeUrl;
    }
    return { sourceType, actual };
  };

  for (const tag of Array.isArray(tags) ? tags : []) {
    const src = readScriptAttr(tag, 'src') || '';
    if (/loader\.js(?:[?#]|$)/i.test(src)) {
      usesLoader = true;
      if (!isAllowedAssetUrl(src, checkedUrl)) continue;
      const loader = await fetchScript(src, checkedUrl);
      if (!loader?.body) continue;
      const loaderUrl = loader.finalUrl || new URL(src, checkedUrl).toString();
      const descriptor = parseLoaderRuntimeDescriptor({ body: loader.body, loaderUrl, tag });
      declaredRuntimeVersion = descriptor.declaredVersion || declaredRuntimeVersion;
      await inspectRuntimeUrl(descriptor.runtimeUrl, 'loader');
      continue;
    }

    if (/intake\.js(?:[?#]|$)/i.test(src)) {
      const declared = src.match(/[?&]v=([0-9]+(?:\.[0-9]+){0,3})/i)?.[1] || null;
      declaredRuntimeVersion = normalizeVersion(declared) || declaredRuntimeVersion;
      await inspectRuntimeUrl(src, 'direct');
    }
  }

  return {
    uses_loader: usesLoader,
    runtime_version: runtimeVersion,
    runtime_declared_version: declaredRuntimeVersion,
    runtime_compatible: runtimeCompatible,
    runtime_source: runtimeSource,
    // This is only a capability of the served runtime. The controller must
    // additionally observe the install attributes and the provider bootstrap
    // in page HTML before reporting consent_mode_detected.
    consent_mode_capable: runtimeCompatible,
  };
};

module.exports = {
  CURRENT_CONSENT_BRIDGE_VERSION,
  inspectSnippetRuntime,
  normalizeVersion,
  parseLoaderRuntimeDescriptor,
  parseRuntimeSourceInfo,
  readScriptAttr,
  versionAtLeast,
};
