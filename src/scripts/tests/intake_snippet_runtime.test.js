'use strict';

const assert = require('assert');
const {
  inspectSnippetRuntime,
  parseLoaderRuntimeDescriptor,
  parseRuntimeSourceInfo,
  versionAtLeast,
} = require('../../lib/intake-snippet-runtime');

const checkedUrl = 'https://www.propdental.es/';

const runtimeSource = (version, { bridge = true } = {}) => `
  /** ClinicaClick Intake Snippet v${version} */
  var CONFIG = { features: { consent_mode_enabled: true${bridge ? ", consent_provider: 'clinicaclick', external_cmp_provider: 'complianz'" : ''} } };
  window.gtag('consent', 'default', {});
  ${bridge ? "window.cmplz_has_consent('marketing'); window.cmplz_set_consent('marketing', 'deny');" : ''}
  window.ClinicaClickIntake = { version: '${version}' };
`;

const loaderSource = (declaredVersion, runtimeFile = 'intake.js') => `
  /** ClinicaClick Intake Loader */
  var RUNTIME_VERSION = '${declaredVersion}';
  var RUNTIME_FILE = '${runtimeFile}';
`;

const allowed = (value, base = checkedUrl) => {
  try {
    const host = new URL(value, base).hostname.toLowerCase();
    return host === 'clinicaclick.com' || host.endsWith('.clinicaclick.com');
  } catch (_error) {
    return false;
  }
};

const makeFetcher = (sources, calls) => async (value, base = checkedUrl) => {
  const absolute = new URL(value, base).toString();
  calls.push(absolute);
  const withoutQuery = absolute.replace(/\?.*$/, '');
  const body = sources[absolute] || sources[withoutQuery] || null;
  return body ? { body, finalUrl: absolute } : null;
};

async function run() {
  assert.equal(versionAtLeast('3.3.0', '3.3.0'), true);
  assert.equal(versionAtLeast('3.2.9', '3.3.0'), false);
  assert.equal(versionAtLeast('not-a-version', '3.3.0'), false);

  const parsed = parseRuntimeSourceInfo(runtimeSource('3.3.0'));
  assert.deepEqual(parsed, {
    version: '3.3.0',
    hasConsentMode: true,
    hasProviderBridge: true,
  });

  const descriptor = parseLoaderRuntimeDescriptor({
    body: loaderSource('3.3.0'),
    loaderUrl: 'https://crm.clinicaclick.com/assets/loader.js',
    tag: '<script src="https://crm.clinicaclick.com/assets/loader.js">',
  });
  assert.equal(descriptor.runtimeUrl, 'https://crm.clinicaclick.com/assets/intake.js?v=3.3.0');

  {
    const calls = [];
    const result = await inspectSnippetRuntime({
      tags: ['<script src="https://crm.clinicaclick.com/assets/loader.js" data-group-id="5">'],
      checkedUrl,
      isAllowedAssetUrl: allowed,
      fetchScript: makeFetcher({
        'https://crm.clinicaclick.com/assets/loader.js': loaderSource('99.0.0'),
        // La constante/query del loader miente: manda el cuerpo servido.
        'https://crm.clinicaclick.com/assets/intake.js': runtimeSource('3.2.1'),
      }, calls),
    });
    assert.equal(result.uses_loader, true);
    assert.equal(result.runtime_declared_version, '99.0.0');
    assert.equal(result.runtime_version, '3.2.1');
    assert.equal(result.runtime_compatible, false);
    assert.equal(result.consent_mode_detected, false);
    assert.equal(calls.length, 2);
  }

  {
    const calls = [];
    const result = await inspectSnippetRuntime({
      tags: ['<script src="https://crm.clinicaclick.com/assets/loader.js" data-group-id="5">'],
      checkedUrl,
      isAllowedAssetUrl: allowed,
      fetchScript: makeFetcher({
        'https://crm.clinicaclick.com/assets/loader.js': loaderSource('3.3.0'),
        'https://crm.clinicaclick.com/assets/intake.js': runtimeSource('3.3.0'),
      }, calls),
    });
    assert.equal(result.runtime_version, '3.3.0');
    assert.equal(result.runtime_compatible, true);
    assert.equal(result.consent_mode_detected, true);
  }

  {
    const calls = [];
    const result = await inspectSnippetRuntime({
      tags: ['<script src="https://crm.clinicaclick.com/assets/intake.js?v=99.0.0" data-group-id="5">'],
      checkedUrl,
      isAllowedAssetUrl: allowed,
      fetchScript: makeFetcher({
        'https://crm.clinicaclick.com/assets/intake.js': runtimeSource('3.2.1'),
      }, calls),
    });
    assert.equal(result.runtime_declared_version, '99.0.0');
    assert.equal(result.runtime_version, '3.2.1');
    assert.equal(result.runtime_compatible, false);
  }

  {
    const calls = [];
    const result = await inspectSnippetRuntime({
      tags: [
        '<script src="https://crm.clinicaclick.com/assets/loader.js" data-runtime-url="http://169.254.169.254/latest/meta-data">',
      ],
      checkedUrl,
      isAllowedAssetUrl: allowed,
      fetchScript: makeFetcher({
        'https://crm.clinicaclick.com/assets/loader.js': loaderSource('3.3.0'),
      }, calls),
    });
    assert.equal(result.runtime_compatible, false);
    assert.deepEqual(calls, ['https://crm.clinicaclick.com/assets/loader.js']);
  }

  console.log('intake_snippet_runtime.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
