<?php

require __DIR__ . '/bootstrap.php';

$tests = array();

$tests['canonical JSON matches Node object ordering and number rules'] = static function () {
    $value = array('z' => 1.0, 'zero' => -0.0, 'a' => array('b' => 2, 'a' => array(3, 1)));
    ccw_test_assert(CCW_JSON::canonical($value) === '{"a":{"a":[3,1],"b":2},"z":1,"zero":0}', 'canonical JSON mismatch');
};

$tests['configuration rejects unsafe API, token and installation id'] = static function () {
    ccw_test_throws('ccw_api_base_invalid', static function () {
        CCW_Config::validate_api_base('http://crm.example.test');
    });
    ccw_test_throws('ccw_token_invalid', static function () {
        CCW_Config::validate_token('too short');
    });
    ccw_test_throws('ccw_installation_id_invalid', static function () {
        CCW_Config::validate_installation_id('../../etc/passwd');
    });
};

$tests['managed runtime fails closed when the default cache is below document root'] = static function () {
    $public_root = __DIR__ . '/tmp/nginx-public';
    $default_cache = $public_root . '/wp-content/clinicaclick-web-cache/site';
    $unsafe_context = array(
        'managed' => true,
        'server_software' => 'nginx/1.26.1',
        'uses_default' => true,
        'document_root' => $public_root,
    );
    $diagnostic = CCW_Config::cache_storage_diagnostic($default_cache, $unsafe_context);
    ccw_test_assert(empty($diagnostic['safe']), 'managed runtime accepted the default public cache');
    ccw_test_assert(
        ($diagnostic['code'] ?? '') === 'ccw_managed_cache_directory_public',
        'unsafe cache diagnostic lost its stable error code'
    );
    ccw_test_assert(
        strpos((string) ($diagnostic['message'] ?? ''), 'CLINICACLICK_WEB_CACHE_DIR') !== false,
        'unsafe cache diagnostic does not explain the repair'
    );

    $blocked = new CCW_Cache($default_cache, $unsafe_context);
    ccw_test_throws('ccw_managed_cache_directory_public', static function () use ($blocked) {
        $blocked->initialize();
    });
    ccw_test_throws('ccw_managed_cache_directory_public', static function () use ($blocked) {
        $blocked->pointer();
    });
    ccw_test_throws('ccw_managed_cache_directory_public', static function () use ($blocked) {
        $blocked->resolve_pointer(array('status' => 'active'), 'index.html');
    });
    ccw_test_assert(!is_dir($default_cache), 'fail-closed guard wrote into the unsafe cache');

    $apache_context = array_replace($unsafe_context, array('server_software' => 'Apache/2.4.62'));
    ccw_test_assert(
        empty(CCW_Config::cache_storage_diagnostic($default_cache, $apache_context)['safe']),
        'managed Apache bypassed the portable private-cache requirement'
    );
    $cli_context = array_replace($unsafe_context, array('server_software' => ''));
    ccw_test_assert(
        empty(CCW_Config::cache_storage_diagnostic($default_cache, $cli_context)['safe']),
        'WP-CLI bypassed the managed private-cache requirement'
    );
    $explicit_public_context = array_replace($unsafe_context, array('uses_default' => false));
    ccw_test_assert(
        empty(CCW_Config::cache_storage_diagnostic($default_cache, $explicit_public_context)['safe']),
        'an explicit managed cache constant inside document root bypassed the guard'
    );

    $private_cache = __DIR__ . '/tmp/nginx-private/clinicaclick-web-cache/site';
    $private_context = array_replace($unsafe_context, array(
        'uses_default' => false,
        'document_root' => $public_root,
    ));
    $private = new CCW_Cache($private_cache, $private_context);
    $private->initialize();
    ccw_test_assert(is_dir($private_cache . '/releases'), 'private Nginx cache was blocked');

    $generic = CCW_Config::cache_storage_diagnostic($default_cache, array_replace($unsafe_context, array(
        'managed' => false,
    )));
    ccw_test_assert(!empty($generic['safe']), 'generic unmanaged install was broken by the managed guard');
};

$tests['artifact bearer is sent only to the exact API origin'] = static function () {
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $internal_json = 'https://api.example.test/api/marketing/artifact/manifest';
    $external_json = 'https://artifacts.example.test/artifact/manifest';
    $internal_file = 'https://api.example.test/api/marketing/artifact/file';
    $external_file = 'https://artifacts.example.test/artifact/file';
    foreach (array($internal_json, $external_json) as $url) {
        $GLOBALS['ccw_test_http'][$url] = array('code' => 200, 'body' => '{"ok":true}');
    }
    foreach (array($internal_file, $external_file) as $url) {
        $GLOBALS['ccw_test_http'][$url] = array('code' => 200, 'body' => 'safe');
    }
    $http = new CCW_HTTP();
    $http->get_json($internal_json, 'internal');
    $http->get_json($external_json, 'external');
    $first = tempnam(sys_get_temp_dir(), 'ccw-internal-');
    $second = tempnam(sys_get_temp_dir(), 'ccw-external-');
    $http->download_file($internal_file, $first, 4);
    $http->download_file($external_file, $second, 4);
    @unlink($first);
    @unlink($second);

    foreach ($GLOBALS['ccw_test_gets'] as $request) {
        $same_origin = strpos($request['url'], 'https://api.example.test/') === 0;
        $has_bearer = isset($request['args']['headers']['Authorization']);
        ccw_test_assert($same_origin === $has_bearer, 'installation bearer crossed the API origin boundary');
        if ($same_origin) {
            ccw_test_assert(
                ($request['args']['headers']['X-Clinicaclick-Plugin-Version'] ?? '') === CCW_VERSION,
                'authenticated artifact request omitted plugin version'
            );
        }
    }
};

/** @return array{descriptor:array<string,mixed>,secret:string} */
function ccw_test_keypair()
{
    $keypair = sodium_crypto_sign_keypair();
    $public = sodium_crypto_sign_publickey($keypair);
    $secret = sodium_crypto_sign_secretkey($keypair);
    $der = hex2bin(CCW_Trust_Store::SPKI_PREFIX_HEX) . $public;
    return array(
        'descriptor' => array(
            'schema_version' => 1,
            'algorithm' => 'Ed25519',
            'key_id' => 'ed25519-' . substr(hash('sha256', $der), 0, 16),
            'public_key_base64' => base64_encode($public),
        ),
        'secret' => $secret,
    );
}

/** @return array<string,mixed> */
function ccw_test_sign($payload, array $key)
{
    $canonical = CCW_JSON::canonical($payload);
    return array(
        'signature_version' => 1,
        'algorithm' => 'Ed25519',
        'key_id' => $key['descriptor']['key_id'],
        'manifest_sha256' => hash('sha256', $canonical),
        'signature' => base64_encode(sodium_crypto_sign_detached($canonical, $key['secret'])),
    );
}

$tests['trust store verifies signatures and blocks untrusted self-bootstrap'] = static function () {
    $GLOBALS['ccw_test_options'] = array();
    $key = ccw_test_keypair();
    $payload = array('schema_version' => 1, 'value' => 'signed');
    ccw_test_throws('ccw_trust_not_configured', static function () use ($key) {
        CCW_Trust_Store::trust_remote_descriptor($key['descriptor'], array());
    });
    CCW_Trust_Store::import_configured_descriptor($key['descriptor']);
    ccw_test_assert(CCW_Trust_Store::verify_signed_payload($payload, ccw_test_sign($payload, $key)), 'valid signature rejected');
    $bad = ccw_test_sign($payload, $key);
    $bad['signature'] = base64_encode(str_repeat('x', SODIUM_CRYPTO_SIGN_BYTES));
    ccw_test_assert(!CCW_Trust_Store::verify_signed_payload($payload, $bad), 'bad signature accepted');
    $rotated = ccw_test_keypair();
    CCW_Trust_Store::trust_remote_descriptor($rotated['descriptor'], ccw_test_sign($rotated['descriptor'], $key));
    ccw_test_assert(isset(CCW_Trust_Store::all()[$rotated['descriptor']['key_id']]), 'signed key rotation was not persisted');
    ccw_test_assert(
        CCW_Trust_Store::active_key_id() === $key['descriptor']['key_id'],
        'descriptor trust prematurely promoted the signing key'
    );
    CCW_Trust_Store::promote_remote_descriptor($rotated['descriptor']['key_id']);
    ccw_test_assert(
        CCW_Trust_Store::active_key_id() === $rotated['descriptor']['key_id'],
        'successful transition did not promote the signing key'
    );
    ccw_test_throws('ccw_key_downgrade_blocked', static function () use ($key, $rotated) {
        CCW_Trust_Store::trust_remote_descriptor($key['descriptor'], ccw_test_sign($key['descriptor'], $rotated));
    });
    $unsigned = ccw_test_keypair();
    ccw_test_throws('ccw_key_rotation_signature_invalid', static function () use ($unsigned) {
        CCW_Trust_Store::trust_remote_descriptor($unsigned['descriptor'], array());
    });
    $wrong_signer = ccw_test_keypair();
    ccw_test_throws('ccw_key_rotation_signature_invalid', static function () use ($unsigned, $wrong_signer) {
        CCW_Trust_Store::trust_remote_descriptor(
            $unsigned['descriptor'],
            ccw_test_sign($unsigned['descriptor'], $wrong_signer)
        );
    });
    ccw_test_throws('ccw_private_key_forbidden', static function () use ($key) {
        CCW_Trust_Store::validate_descriptor($key['descriptor'] + array('private_key' => 'forbidden'));
    });
};

$tests['manifest rejects traversal, executable types and executable HTML'] = static function () {
    ccw_test_throws('ccw_artifact_path_invalid', static function () {
        CCW_Manifest::safe_path('../index.html');
    });
    ccw_test_throws('ccw_artifact_file_type_forbidden', static function () {
        CCW_Manifest::safe_path('assets/runtime.js');
    });
    $tmp = tempnam(sys_get_temp_dir(), 'ccw-html-');
    file_put_contents($tmp, '<!doctype html><button onclick="alert(1)">X</button>');
    ccw_test_throws('ccw_artifact_html_code_forbidden', static function () use ($tmp) {
        CCW_Manifest::inspect_file('index.html', $tmp, array(
            'size_bytes' => filesize($tmp),
            'sha256' => hash_file('sha256', $tmp),
        ));
    });
    unlink($tmp);
};

/** @return array<string,mixed> */
function ccw_test_artifact($marker)
{
    $project_id = '11111111-1111-4111-8111-111111111111';
    $revision_id = '22222222-2222-4222-8222-222222222222';
    $page_id = '33333333-3333-4333-8333-333333333333';
    $info_page_id = '33333333-3333-4333-8333-333333333334';
    $form_id = 'form-' . $marker;
    $csp = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' https://media.clinicaclick.com https://api.example.test data:; style-src 'self' 'unsafe-inline'; script-src 'sha256-example' https://api.example.test; connect-src 'self' https://api.example.test";
    $loader = static function ($page) use ($project_id, $revision_id) {
        return '<script src="https://api.example.test/assets/loader.js" async data-api-url="https://api.example.test" data-event-bridge-url="/_clinicaclick/events" data-web-project-id="' . $project_id . '" data-web-revision-id="' . $revision_id . '" data-web-page-id="' . $page . '" data-clinic-id="56" data-consent-mode-enabled="true" data-consent-provider="external_cmp"></script>';
    };
    $html = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' . htmlspecialchars($csp, ENT_QUOTES | ENT_HTML5, 'UTF-8') . '"><script type="application/ld+json">{"@context":"https://schema.org"}</script>' . $loader($page_id) . '<link rel="stylesheet" href="https://cliente.example.test/cita/assets/styles.' . $marker . '.css"></head><body><h1>' . $marker . '</h1><form id="cc-' . $form_id . '" class="cc-form" action="/_clinicaclick/intake" method="post" accept-charset="UTF-8" data-cc-native-intake="true"><input type="hidden" name="web_project_id" value="' . $project_id . '"><input type="hidden" name="web_revision_id" value="' . $revision_id . '"><input type="hidden" name="web_page_id" value="' . $page_id . '"><input type="hidden" name="web_form_id" value="' . $form_id . '"><input type="text" name="_cc_company" value=""><input type="email" name="email"><input type="checkbox" name="privacy_consent" value="1" required><p id="cc-' . $form_id . '-success"></p><p id="cc-' . $form_id . '-error"></p></form></body></html>';
    $info_html = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' . htmlspecialchars($csp, ENT_QUOTES | ENT_HTML5, 'UTF-8') . '"><script type="application/ld+json">{"@context":"https://schema.org"}</script>' . $loader($info_page_id) . '<link rel="stylesheet" href="https://cliente.example.test/cita/assets/styles.' . $marker . '.css"></head><body><h1>Información ' . $marker . '</h1></body></html>';
    $css = '.cc-' . $marker . '{color:#181d35}';
    $robots = "User-agent: *\nAllow: /\n";
    $sitemap = '<?xml version="1.0"?><urlset></urlset>';
    $files = array(
        'assets/styles.' . $marker . '.css' => $css,
        'index.html' => $html,
        'informacion/index.html' => $info_html,
        'robots.txt' => $robots,
        'sitemap.xml' => $sitemap,
    );
    $types = array(
        'css' => 'text/css; charset=utf-8',
        'html' => 'text/html; charset=utf-8',
        'txt' => 'text/plain; charset=utf-8',
        'xml' => 'application/xml; charset=utf-8',
    );
    $metadata = array();
    foreach ($files as $path => $body) {
        $metadata[$path] = array(
            'sha256' => hash('sha256', $body),
            'content_type' => $types[pathinfo($path, PATHINFO_EXTENSION)],
            'size_bytes' => strlen($body),
        );
    }
    $hash = hash('sha256', 'artifact-' . $marker);
    $artifact_input_hash = hash('sha256', 'artifact-input-' . $marker);
    $runtime_config_hash = hash('sha256', CCW_JSON::canonical(array(
        'schema_version' => 1,
        'measurement' => array(
            'enabled' => true,
            'scope_type' => 'clinic',
            'scope_id' => 56,
            'api_url' => 'https://api.example.test',
            'loader_url' => 'https://api.example.test/assets/loader.js',
            'hmac_key' => str_repeat('h', 40),
            'consent_mode_enabled' => true,
            'consent_provider' => 'external_cmp',
            'chat_enabled' => false,
            'whatsapp_enabled' => false,
            'phone_enabled' => false,
        ),
    )));
    return array(
        'hash' => $hash,
        'manifest' => array(
            'schema_version' => 1,
            'renderer_version' => 'clinicaclick-web-renderer/1.0.0',
            'environment' => 'production',
            'artifact_hash' => $hash,
            'artifact_input_hash' => $artifact_input_hash,
            'project_id' => $project_id,
            'revision_id' => $revision_id,
            'runtime_config_hash' => $runtime_config_hash,
            'page_routes' => array(
                $page_id => array('page_path' => '/'),
                $info_page_id => array('page_path' => '/informacion/'),
            ),
            'intake_forms' => array(
                $form_id => array(
                    'page_path' => '/',
                    'page_id' => $page_id,
                    'success_anchor' => 'cc-' . $form_id . '-success',
                    'error_anchor' => 'cc-' . $form_id . '-error',
                    'fields' => array(
                        array('name' => 'email', 'type' => 'email', 'required' => false),
                        array('name' => 'privacy_consent', 'type' => 'checkbox', 'required' => true),
                    ),
                ),
            ),
            'files' => $metadata,
            'headers' => array(
                'content-security-policy' => $csp,
                'x-content-type-options' => 'nosniff',
                'x-frame-options' => 'DENY',
            ),
        ),
        'files' => $files,
        'identity' => array(
            'project_id' => $project_id,
            'revision_id' => $revision_id,
            'page_id' => $page_id,
            'info_page_id' => $info_page_id,
            'form_id' => $form_id,
            'artifact_input_hash' => $artifact_input_hash,
        ),
    );
}

/** @return array<string,mixed> */
function ccw_test_global_form_artifact($marker)
{
    $artifact = ccw_test_artifact($marker);
    $identity = $artifact['identity'];
    $form_id = $identity['form_id'];
    $page_id = $identity['page_id'];
    $info_page_id = $identity['info_page_id'];
    $flat = $artifact['manifest']['intake_forms'][$form_id];
    $artifact['manifest']['intake_forms'][$form_id] = array(
        'scope' => 'global',
        'page_contracts' => array(
            $page_id => $flat,
            $info_page_id => array_merge($flat, array(
                'page_path' => '/informacion/',
                'page_id' => $info_page_id,
            )),
        ),
    );
    $matches = array();
    if (!preg_match('/<form\b[^>]*>.*?<\/form\s*>/is', $artifact['files']['index.html'], $matches)) {
        throw new RuntimeException('Global form fixture could not find the canonical form.');
    }
    $info_form = str_replace(
        'name="web_page_id" value="' . $page_id . '"',
        'name="web_page_id" value="' . $info_page_id . '"',
        $matches[0]
    );
    $artifact['files']['informacion/index.html'] = str_replace(
        '</body>',
        $info_form . '</body>',
        $artifact['files']['informacion/index.html']
    );
    $artifact['manifest']['files']['informacion/index.html']['sha256'] = hash(
        'sha256',
        $artifact['files']['informacion/index.html']
    );
    $artifact['manifest']['files']['informacion/index.html']['size_bytes'] = strlen(
        $artifact['files']['informacion/index.html']
    );
    return $artifact;
}

$tests['manifest global firma el mismo formulario para cada ruta y conserva el contrato plano'] = static function () {
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    $runtime = array(
        'schema_version' => 1,
        'measurement' => array(
            'enabled' => true,
            'scope_type' => 'clinic',
            'scope_id' => 56,
            'api_url' => 'https://api.example.test',
            'loader_url' => 'https://api.example.test/assets/loader.js',
            'hmac_key' => str_repeat('h', 40),
            'consent_mode_enabled' => true,
            'consent_provider' => 'external_cmp',
            'chat_enabled' => false,
            'whatsapp_enabled' => false,
            'phone_enabled' => false,
        ),
    );
    $flat = ccw_test_artifact('flat-form');
    $validated_flat = CCW_Manifest::validate($flat['manifest'], $flat['hash'], $runtime);
    $flat_id = $flat['identity']['form_id'];
    ccw_test_assert(isset($validated_flat['intake_forms'][$flat_id]['page_id']), 'flat form compatibility was lost');

    $global = ccw_test_global_form_artifact('global-form');
    $validated = CCW_Manifest::validate($global['manifest'], $global['hash'], $runtime);
    $form_id = $global['identity']['form_id'];
    ccw_test_assert(($validated['intake_forms'][$form_id]['scope'] ?? '') === 'global', 'global form scope was not accepted');
    ccw_test_assert(
        count($validated['intake_forms'][$form_id]['page_contracts'] ?? array()) === 2,
        'global form page contracts were not preserved'
    );
    foreach (array('index.html', 'informacion/index.html') as $path) {
        $temporary = tempnam(sys_get_temp_dir(), 'ccw-global-form-');
        file_put_contents($temporary, $global['files'][$path]);
        CCW_Manifest::inspect_file($path, $temporary, $validated['files'][$path], $runtime, $validated);
        unlink($temporary);
    }

    $missing = ccw_test_global_form_artifact('global-form-missing');
    unset($missing['manifest']['intake_forms'][$missing['identity']['form_id']]['page_contracts'][$missing['identity']['info_page_id']]);
    ccw_test_throws('ccw_manifest_intake_page_route_mismatch', static function () use ($missing, $runtime) {
        CCW_Manifest::validate($missing['manifest'], $missing['hash'], $runtime);
    });
};

$tests['manifest requires an exact signed route for every HTML page and form'] = static function () {
    $missing = ccw_test_artifact('route-missing');
    unset($missing['manifest']['page_routes'][$missing['identity']['info_page_id']]);
    ccw_test_throws('ccw_manifest_page_file_mismatch', static function () use ($missing) {
        CCW_Manifest::validate($missing['manifest'], $missing['hash']);
    });

    $extra_key = ccw_test_artifact('route-extra');
    $extra_key['manifest']['page_routes'][$extra_key['identity']['page_id']]['browser_scope'] = 'forbidden';
    ccw_test_throws('ccw_manifest_page_route_invalid', static function () use ($extra_key) {
        CCW_Manifest::validate($extra_key['manifest'], $extra_key['hash']);
    });

    $form_mismatch = ccw_test_artifact('route-form');
    $form_id = $form_mismatch['identity']['form_id'];
    $form_mismatch['manifest']['intake_forms'][$form_id]['page_id'] = $form_mismatch['identity']['info_page_id'];
    ccw_test_throws('ccw_manifest_intake_page_route_mismatch', static function () use ($form_mismatch) {
        CCW_Manifest::validate($form_mismatch['manifest'], $form_mismatch['hash']);
    });
};

function ccw_test_install_remote(
    array $artifact,
    array $key,
    $sequence,
    $etag = '"v1"',
    array $descriptor_envelope = array()
)
{
    $installation = CCW_Config::installation_id();
    $origin = 'https://artifacts.example.test/' . $artifact['hash'];
    $runtime = array(
        'schema_version' => 1,
        'installation_id' => $installation,
        'sequence' => $sequence,
        'status' => 'active',
        'route_prefix' => '/cita',
        'desired_artifact_hash' => $artifact['hash'],
        'measurement' => array(
            'enabled' => true,
            'scope_type' => 'clinic',
            'scope_id' => 56,
            'loader_path' => '/assets/loader.js',
            'hmac_key' => str_repeat('h', 40),
            'consent_mode_enabled' => true,
            'consent_provider' => 'external_cmp',
        ),
    );
    $urls = array();
    foreach ($artifact['files'] as $path => $body) {
        $urls[$path] = $origin . '/' . $path;
        $GLOBALS['ccw_test_http'][$urls[$path]] = array('code' => 200, 'body' => $body);
    }
    $manifest_url = $origin . '/manifest.json';
    $envelope_url = $origin . '/manifest.sig.json';
    $GLOBALS['ccw_test_http'][$manifest_url] = array('code' => 200, 'body' => json_encode($artifact['manifest']));
    $GLOBALS['ccw_test_http'][$envelope_url] = array('code' => 200, 'body' => json_encode(ccw_test_sign($artifact['manifest'], $key)));
    $desired = array(
        'schema_version' => 1,
        'request_id' => 'req-' . $sequence,
        'installation_id' => $installation,
        'desired_state' => array(
            'status' => 'published',
            'artifact_hash' => $artifact['hash'],
            'manifest_url' => $manifest_url,
            'envelope_url' => $envelope_url,
            'files' => $urls,
            'signing_key_descriptor' => $key['descriptor'],
            'signing_key_descriptor_envelope' => $descriptor_envelope,
            'runtime_configuration' => $runtime,
            'runtime_configuration_envelope' => ccw_test_sign($runtime, $key),
        ),
    );
    $api = CCW_Config::api_base() . '/api/marketing/web-installations/' . rawurlencode($installation) . '/desired-state';
    $GLOBALS['ccw_test_http'][$api] = array('code' => 200, 'headers' => array('etag' => $etag), 'body' => json_encode($desired));
    return array('api' => $api, 'manifest_url' => $manifest_url, 'envelope_url' => $envelope_url, 'desired' => $desired);
}

/** @param array<string,array<string,mixed>> $routes */
function ccw_test_install_remote_v2(
    array $routes,
    array $key,
    $sequence,
    $etag = '"multi"',
    array $descriptor_envelope = array()
)
{
    $installation = CCW_Config::installation_id();
    $measurement = array(
        'enabled' => true,
        'scope_type' => 'clinic',
        'scope_id' => 56,
        'loader_path' => '/assets/loader.js',
        'hmac_key' => str_repeat('h', 40),
        'consent_mode_enabled' => true,
        'consent_provider' => 'external_cmp',
        'chat_enabled' => false,
        'whatsapp_enabled' => false,
        'phone_enabled' => false,
    );
    $registry_routes = array();
    $artifacts = array();
    foreach ($routes as $publication_id => $route) {
        $status = (string) ($route['status'] ?? 'pending');
        $artifact = $route['artifact'] ?? null;
        $hash = $status === 'active' && is_array($artifact) ? $artifact['hash'] : null;
        $registry_routes[$publication_id] = array(
            'publication_id' => $publication_id,
            'route_prefix' => (string) $route['route_prefix'],
            'status' => $status,
            'desired_artifact_hash' => $hash,
        );
        if ($hash === null || isset($artifacts[$hash])) continue;
        $origin = 'https://artifacts.example.test/' . $hash;
        $urls = array();
        foreach ($artifact['files'] as $path => $body) {
            $urls[$path] = $origin . '/' . $path;
            $GLOBALS['ccw_test_http'][$urls[$path]] = array('code' => 200, 'body' => $body);
        }
        $manifest_url = $origin . '/manifest.json';
        $envelope_url = $origin . '/manifest.sig.json';
        $GLOBALS['ccw_test_http'][$manifest_url] = array('code' => 200, 'body' => json_encode($artifact['manifest']));
        $GLOBALS['ccw_test_http'][$envelope_url] = array('code' => 200, 'body' => json_encode(ccw_test_sign($artifact['manifest'], $key)));
        $artifacts[$hash] = array(
            'artifact_hash' => $hash,
            'manifest_url' => $manifest_url,
            'envelope_url' => $envelope_url,
            'files' => $urls,
        );
    }
    ksort($registry_routes, SORT_STRING);
    ksort($artifacts, SORT_STRING);
    $registry = array(
        'schema_version' => 2,
        'installation_id' => $installation,
        'sequence' => (int) $sequence,
        'measurement' => $measurement,
        'routes' => $registry_routes,
    );
    $desired = array(
        'schema_version' => 2,
        'request_id' => 'req-multi-' . $sequence,
        'installation_id' => $installation,
        'desired_state' => array(
            'status' => 'multi',
            'signing_key_descriptor' => $key['descriptor'],
            'signing_key_descriptor_envelope' => $descriptor_envelope,
            'registry_configuration' => $registry,
            'registry_configuration_envelope' => ccw_test_sign($registry, $key),
            'artifacts' => $artifacts,
        ),
    );
    $api = CCW_Config::api_base() . '/api/marketing/web-installations/' . rawurlencode($installation) . '/desired-state';
    $GLOBALS['ccw_test_http'][$api] = array('code' => 200, 'headers' => array('etag' => $etag), 'body' => json_encode($desired));
    return array('api' => $api, 'desired' => $desired, 'registry' => $registry);
}

$tests['online Ed25519 rotation cross-signs, ACKs only success and blocks downgrade replay'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $old = ccw_test_keypair();
    $current = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($old['descriptor']);

    $publication_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $artifact = ccw_test_artifact('key-rotation-v2');
    $remote = ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $artifact,
        ),
    ), $current, 1, '"rotation-current"', ccw_test_sign($current['descriptor'], $old));

    $manifest_envelope_url = $remote['desired']['desired_state']['artifacts'][$artifact['hash']]['envelope_url'];
    $manifest_envelope = json_decode((string) $GLOBALS['ccw_test_http'][$manifest_envelope_url]['body'], true);
    ccw_test_assert(
        ($manifest_envelope['key_id'] ?? '') === $current['descriptor']['key_id'],
        'rotated artifact manifest was not signed by the current key'
    );

    $report_url = CCW_Config::api_base() . '/api/marketing/web-installations/'
        . rawurlencode(CCW_Config::installation_id()) . '/reports';
    $sync_results = 0;
    $GLOBALS['ccw_test_http'][$report_url] = static function ($url, $args) use (&$sync_results) {
        $payload = json_decode((string) ($args['body'] ?? ''), true);
        if (($payload['event'] ?? '') === 'sync_result') {
            $sync_results++;
            return array('code' => $sync_results === 1 ? 500 : 202, 'body' => '');
        }
        return array('code' => 202, 'body' => '');
    };
    $sync = new CCW_Sync();
    $first_result = $sync->run(true);
    ccw_test_assert(
        $first_result['result'] === 'multi_report_pending',
        'lost rotation ACK was treated as acknowledged'
    );
    ccw_test_assert(
        CCW_Trust_Store::active_key_id() === $current['descriptor']['key_id'],
        'plugin did not promote the current key after a complete sync'
    );
    $result = $sync->run(true);
    ccw_test_assert($result['result'] === 'multi_synced', 'rotated v2 ACK was not retried');
    ccw_test_assert($sync_results === 2, 'rotation did not retry the lost sync_result');
    $last_post = end($GLOBALS['ccw_test_posts']);
    $report = json_decode((string) ($last_post['args']['body'] ?? ''), true);
    ccw_test_assert(($report['event'] ?? '') === 'sync_result', 'rotation did not emit sync_result');
    ccw_test_assert(
        ($report['signing_key_id'] ?? '') === $current['descriptor']['key_id'],
        'rotation ACK did not identify the accepted current key'
    );
    ccw_test_assert(
        (int) ($report['configuration_sequence'] ?? 0) === 1
            && (int) ($report['registry_sequence'] ?? 0) === 1,
        'rotation ACK was not bound to the signed registry sequence'
    );

    // Keeping retired descriptors for immutable local history must not let a
    // retired private key authorize a new control document while the response
    // still advertises the current descriptor.
    $wrong_registry_signer = ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $artifact,
        ),
    ), $current, 2, '"rotation-wrong-registry-signer"');
    $wrong_registry_signer['desired']['desired_state']['registry_configuration_envelope'] = ccw_test_sign(
        $wrong_registry_signer['registry'],
        $old
    );
    $GLOBALS['ccw_test_http'][$wrong_registry_signer['api']]['body'] = json_encode(
        $wrong_registry_signer['desired']
    );
    ccw_test_throws('ccw_registry_signature_invalid', static function () {
        (new CCW_Sync())->run(true);
    });

    // Artifact envelopes are bound to the same accepted descriptor. A route
    // failure is reported rather than replacing the last known good release.
    $next_artifact = ccw_test_artifact('key-rotation-wrong-manifest-signer');
    $wrong_manifest_signer = ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $next_artifact,
        ),
    ), $current, 2, '"rotation-wrong-manifest-signer"');
    $manifest_envelope_url = $wrong_manifest_signer['desired']['desired_state']
        ['artifacts'][$next_artifact['hash']]['envelope_url'];
    $GLOBALS['ccw_test_http'][$manifest_envelope_url]['body'] = json_encode(
        ccw_test_sign($next_artifact['manifest'], $old)
    );
    $manifest_result = (new CCW_Sync())->run(true);
    ccw_test_assert(
        $manifest_result['result'] === 'multi_partial_failed'
            && ($manifest_result['routes'][$publication_id]['error_code'] ?? '') === 'ccw_manifest_signature_invalid',
        'retired key authorized a newly downloaded artifact manifest'
    );
    ccw_test_assert(
        CCW_Trust_Store::active_key_id() === $current['descriptor']['key_id'],
        'wrong artifact signer changed the active signing key'
    );

    $replay = ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $artifact,
        ),
    ), $old, 2, '"rotation-downgrade"', ccw_test_sign($old['descriptor'], $current));
    $GLOBALS['ccw_test_http'][$replay['api']]['body'] = json_encode($replay['desired']);
    ccw_test_throws('ccw_key_downgrade_blocked', static function () {
        (new CCW_Sync())->run(true);
    });
    ccw_test_assert(
        CCW_Trust_Store::active_key_id() === $current['descriptor']['key_id'],
        'downgrade replay changed the active signing key'
    );
};

$tests['legacy v1 runtime can cross-sign the key but cannot self-bootstrap'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $old = ccw_test_keypair();
    $current = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($old['descriptor']);
    $artifact = ccw_test_artifact('key-rotation-v1');
    ccw_test_install_remote(
        $artifact,
        $current,
        1,
        '"rotation-v1"',
        ccw_test_sign($current['descriptor'], $old)
    );
    $result = (new CCW_Sync())->run(true);
    ccw_test_assert($result['result'] === 'activated', 'rotated v1 desired-state did not complete');
    ccw_test_assert(
        CCW_Trust_Store::active_key_id() === $current['descriptor']['key_id'],
        'v1 runtime did not activate the cross-signed key'
    );
    $last_post = end($GLOBALS['ccw_test_posts']);
    $report = json_decode((string) ($last_post['args']['body'] ?? ''), true);
    ccw_test_assert(
        ($report['signing_key_id'] ?? '') === $current['descriptor']['key_id']
            && (int) ($report['configuration_sequence'] ?? 0) === 1,
        'v1 rotation report omitted its accepted key or sequence'
    );

    $wrong_runtime_signer = ccw_test_install_remote(
        $artifact,
        $current,
        2,
        '"rotation-v1-wrong-runtime-signer"'
    );
    $runtime = $wrong_runtime_signer['desired']['desired_state']['runtime_configuration'];
    $wrong_runtime_signer['desired']['desired_state']['runtime_configuration_envelope'] = ccw_test_sign(
        $runtime,
        $old
    );
    $GLOBALS['ccw_test_http'][$wrong_runtime_signer['api']]['body'] = json_encode(
        $wrong_runtime_signer['desired']
    );
    ccw_test_throws('ccw_runtime_signature_invalid', static function () {
        (new CCW_Sync())->run(true);
    });
};

/** @return array<string,mixed> */
function ccw_test_setup_intake($marker = 'intake', $global_form = false)
{
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $key = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($key['descriptor']);
    $artifact = $global_form ? ccw_test_global_form_artifact($marker) : ccw_test_artifact($marker);
    ccw_test_install_remote($artifact, $key, 1, '"intake"');
    (new CCW_Sync())->run(true);
    $GLOBALS['ccw_test_posts'] = array();
    $identity = $artifact['identity'];
    $fields = array(
        'first_name' => 'Ana',
        'last_name' => 'García',
        'email' => 'ana@example.test',
        'phone' => '+34 612 345 678',
        'message' => 'Quiero pedir una primera cita.',
        'preferred_contact' => 'telefono',
        'privacy_consent' => '1',
        '_cc_ad_user_data' => 'granted',
        '_cc_ad_personalization' => 'denied',
        '_cc_company' => '',
        'web_project_id' => $identity['project_id'],
        'web_revision_id' => $identity['revision_id'],
        'web_page_id' => $identity['page_id'],
        'web_form_id' => $identity['form_id'],
    );
    return array(
        'key' => $key,
        'artifact' => $artifact,
        'bridge' => new CCW_Intake_Bridge(new CCW_Cache()),
        'fields' => $fields,
        'server' => array(
            'REQUEST_METHOD' => 'POST',
            'CONTENT_TYPE' => 'application/x-www-form-urlencoded; charset=UTF-8',
            'HTTP_ORIGIN' => 'https://cliente.example.test',
            'HTTP_REFERER' => 'https://cliente.example.test/cita/?gclid=click_123&utm_campaign=implantes&ignored=secret',
            'HTTP_USER_AGENT' => 'Browser Test/1.0',
            'REMOTE_ADDR' => '203.0.113.8',
        ),
        'upstream' => 'https://api.example.test/api/intake/leads',
        'secret' => str_repeat('h', 40),
    );
}

/** @param array<string,mixed> $server @param array<string,string> $fields */
function ccw_test_bridge_process(CCW_Intake_Bridge $bridge, array $server, array $fields, $now = 1784280000)
{
    $raw = http_build_query($fields, '', '&', PHP_QUERY_RFC3986);
    $server['CONTENT_LENGTH'] = (string) strlen($raw);
    return $bridge->process($server, $raw, $now);
}

/** @param array<string,mixed> $server @param array<string,mixed> $wrapper */
function ccw_test_event_process(CCW_Intake_Bridge $bridge, array $server, array $wrapper, $now = 1784280000)
{
    $raw = json_encode($wrapper, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $server['CONTENT_LENGTH'] = (string) strlen((string) $raw);
    return $bridge->process_event($server, $raw, $now);
}

$tests['full sync verifies, atomically promotes, keeps LKG and fails closed'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $key = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($key['descriptor']);

    $first = ccw_test_artifact('one');
    ccw_test_install_remote($first, $key, 1, '"v1"');
    $sync = new CCW_Sync();
    $result = $sync->run(true);
    ccw_test_assert($result['result'] === 'activated', 'first artifact not activated');
    $cache = new CCW_Cache();
    $pointer = $cache->pointer();
    ccw_test_assert($pointer['active_hash'] === $first['hash'], 'active hash mismatch');
    ccw_test_assert($pointer['last_known_good_hash'] === $first['hash'], 'initial LKG mismatch');
    $resolved = $cache->resolve('index.html');
    ccw_test_assert($resolved !== null && strpos(file_get_contents($resolved['path']), '<h1>one</h1>') !== false, 'cached HTML missing');

    $second = ccw_test_artifact('two');
    $remote = ccw_test_install_remote($second, $key, 2, '"v2"');
    $sync->run(true);
    $pointer = $cache->pointer();
    ccw_test_assert($pointer['active_hash'] === $second['hash'], 'second artifact not active');
    ccw_test_assert($pointer['last_known_good_hash'] === $first['hash'], 'first artifact not retained as LKG');
    ccw_test_assert(($pointer['runtime_configuration']['desired_artifact_hash'] ?? '') === $second['hash'], 'active runtime was not paired with artifact');
    ccw_test_assert(($pointer['last_known_good_runtime_configuration']['desired_artifact_hash'] ?? '') === $first['hash'], 'LKG runtime was not paired with artifact');

    $drift = ccw_test_install_remote($second, $key, 3, '"runtime-drift"');
    // Mutate only the signed runtime while deliberately reusing the immutable
    // artifact that was compiled with the previous HMAC.
    $drift['desired']['desired_state']['runtime_configuration']['measurement']['hmac_key'] = str_repeat('x', 40);
    $drift['desired']['desired_state']['runtime_configuration_envelope'] = ccw_test_sign(
        $drift['desired']['desired_state']['runtime_configuration'],
        $key
    );
    $GLOBALS['ccw_test_http'][$drift['api']]['body'] = json_encode($drift['desired']);
    ccw_test_throws('ccw_runtime_artifact_configuration_mismatch', static function () use ($sync) {
        $sync->run(true);
    });
    ccw_test_assert($cache->pointer()['active_hash'] === $second['hash'], 'runtime drift changed the active artifact');

    $third = ccw_test_artifact('three');
    $remote = ccw_test_install_remote($third, $key, 4, '"v3"');
    $bad_envelope = ccw_test_sign($third['manifest'], $key);
    $bad_envelope['signature'] = base64_encode(str_repeat('x', SODIUM_CRYPTO_SIGN_BYTES));
    $GLOBALS['ccw_test_http'][$remote['envelope_url']]['body'] = json_encode($bad_envelope);
    ccw_test_throws('ccw_manifest_signature_invalid', static function () use ($sync) {
        $sync->run(true);
    });
    ccw_test_assert($cache->pointer()['active_hash'] === $second['hash'], 'bad signature changed active hash');

    ccw_test_install_remote($first, $key, 1, '"replay"');
    ccw_test_throws('ccw_runtime_replay_blocked', static function () use ($sync) {
        $sync->run(true);
    });
    ccw_test_assert($cache->pointer()['active_hash'] === $second['hash'], 'replayed runtime changed active hash');

    $rolled = $cache->rollback_local();
    ccw_test_assert($rolled['active_hash'] === $first['hash'] && $rolled['manual_hold'] === true, 'local rollback failed');
    ccw_test_assert(($rolled['runtime_configuration']['desired_artifact_hash'] ?? '') === $first['hash'], 'rollback did not restore matching runtime');
    $rolled_file = $cache->resolve('index.html');
    ccw_test_assert($rolled_file !== null && strpos(file_get_contents($rolled_file['path']), '<h1>one</h1>') !== false, 'rollback did not restore the previous manifest');
    $held = $sync->run(false);
    ccw_test_assert($held['result'] === 'manual_hold' && $cache->pointer()['active_hash'] === $first['hash'], 'automatic sync ignored manual hold');

    ccw_test_assert(count($GLOBALS['ccw_test_posts']) >= 3, 'sync reports were not posted');
    foreach ($GLOBALS['ccw_test_posts'] as $post) {
        ccw_test_assert(strpos((string) $post['args']['body'], str_repeat('t', 48)) === false, 'token leaked into report body');
        ccw_test_assert(strpos((string) $post['args']['body'], str_repeat('h', 40)) === false, 'browser HMAC leaked into report body');
    }
    foreach ($GLOBALS['ccw_test_gets'] as $get) {
        $has_authorization = isset($get['args']['headers']['Authorization']);
        if (strpos($get['url'], 'https://api.example.test/') === 0) {
            ccw_test_assert($has_authorization, 'control request missed Authorization');
        } else {
            ccw_test_assert(!$has_authorization, 'Authorization leaked to artifact origin');
        }
    }
};

$tests['route registry adopts active pilot unchanged and resolves the longest signed prefix'] = static function () {
    ccw_test_setup_intake('route-registry');
    $cache = new CCW_Cache();
    $active_path = $cache->root() . '/active.json';
    $active_before = (string) file_get_contents($active_path);
    $legacy_pointer = $cache->pointer();
    $pilot_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $child_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    $adopted = $cache->adopt_pilot_route(
        $pilot_id,
        '/cita/',
        $legacy_pointer['active_hash'],
        $legacy_pointer['runtime_configuration']
    );
    ccw_test_assert(is_array($adopted), 'legacy pilot was not adopted into routes.json');
    ccw_test_assert($adopted['active_hash'] === $legacy_pointer['active_hash'], 'pilot adoption changed the active hash');
    ccw_test_assert((string) file_get_contents($active_path) === $active_before, 'pilot adoption rewrote active.json');

    $cache->register_pending_route($child_id, '/cita/implantes/', array(
        'schema_version' => 2,
        'installation_id' => CCW_Config::installation_id(),
        'sequence' => 2,
        'status' => 'pending',
        'route_prefix' => '/cita/implantes/',
        'desired_artifact_hash' => null,
        'measurement' => array('enabled' => false),
    ));
    $registry = $cache->route_registry();
    ccw_test_assert(is_file($cache->root() . '/routes.json'), 'route registry was not persisted');
    ccw_test_assert(count($registry['routes']) === 2, 'route registry did not retain pilot and child');

    $child = $cache->match_route('/cita/implantes/gracias/');
    ccw_test_assert(($child['publication_id'] ?? '') === $child_id, 'child route lost longest-prefix precedence');
    ccw_test_assert(($child['relative_path'] ?? '') === 'gracias/', 'child relative path is incorrect');
    $pilot = $cache->match_route('/cita/informacion/');
    ccw_test_assert(($pilot['publication_id'] ?? '') === $pilot_id, 'pilot fallback route is incorrect');
    ccw_test_assert(($pilot['relative_path'] ?? '') === 'informacion/', 'pilot relative path is incorrect');
    ccw_test_assert((string) file_get_contents($active_path) === $active_before, 'child registration rewrote active.json');
};

$tests['v2 pilot rollback keeps route runtime coherent for intake and event bridges'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $key = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($key['descriptor']);

    $publication_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $first = ccw_test_artifact('pilot-rollback-one');
    $second = ccw_test_artifact('pilot-rollback-two');
    $sync = new CCW_Sync();
    ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $first,
        ),
    ), $key, 1, '"pilot-rollback-1"');
    $sync->run(true);
    ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $second,
        ),
    ), $key, 2, '"pilot-rollback-2"');
    $sync->run(true);

    $cache = new CCW_Cache();
    $before = $cache->route_pointer($publication_id, '/cita/');
    ccw_test_assert($before['active_hash'] === $second['hash'], 'second pilot artifact was not active');
    ccw_test_assert(
        ($before['runtime_configuration']['desired_artifact_hash'] ?? '') === $second['hash'],
        'second pilot runtime was not paired before rollback'
    );

    $rolled = $cache->rollback_local();
    $registry = $cache->route_registry();
    $matched = $cache->match_route('/cita/');
    ccw_test_assert($rolled['active_hash'] === $first['hash'], 'pilot rollback did not restore first artifact');
    ccw_test_assert(
        ($registry['routes'][$publication_id]['runtime_configuration']['desired_artifact_hash'] ?? '') === $first['hash'],
        'routes.json retained the target runtime after pilot rollback'
    );
    ccw_test_assert(
        ($matched['pointer']['runtime_configuration']['desired_artifact_hash'] ?? '') === $first['hash'],
        'route lookup combined the rolled-back artifact with another runtime'
    );

    $captured_lead = null;
    $lead_url = 'https://api.example.test/api/intake/leads';
    $GLOBALS['ccw_test_http'][$lead_url] = static function ($url, $args) use (&$captured_lead) {
        $captured_lead = array('url' => $url, 'args' => $args);
        return array('code' => 201, 'body' => '{"id":701}');
    };
    $identity = $first['identity'];
    $fields = array(
        'email' => 'rollback@example.test',
        'privacy_consent' => '1',
        '_cc_company' => '',
        'web_project_id' => $identity['project_id'],
        'web_revision_id' => $identity['revision_id'],
        'web_page_id' => $identity['page_id'],
        'web_form_id' => $identity['form_id'],
    );
    $server = array(
        'REQUEST_METHOD' => 'POST',
        'CONTENT_TYPE' => 'application/x-www-form-urlencoded; charset=UTF-8',
        'HTTP_ORIGIN' => 'https://cliente.example.test',
        'HTTP_REFERER' => 'https://cliente.example.test/cita/?gclid=rollback_click',
        'HTTP_USER_AGENT' => 'Rollback Test/1.0',
        'REMOTE_ADDR' => '203.0.113.44',
    );
    $bridge = new CCW_Intake_Bridge($cache);
    $lead_result = ccw_test_bridge_process($bridge, $server, $fields, 1784290000);
    $lead_payload = json_decode((string) ($captured_lead['args']['body'] ?? ''), true);
    ccw_test_assert(
        is_array($captured_lead) && empty($lead_result['honeypot'])
        && preg_match('/^ccw_[a-f0-9]{64}$/', (string) ($lead_result['event_id'] ?? '')) === 1,
        'rolled-back intake was not accepted'
    );
    ccw_test_assert(
        ($lead_payload['web_artifact_input_hash'] ?? '') === $first['identity']['artifact_input_hash'],
        'rolled-back intake used the target artifact identity'
    );

    $captured_event = null;
    $event_url = 'https://api.example.test/_clinicaclick/events';
    $GLOBALS['ccw_test_http'][$event_url] = static function ($url, $args) use (&$captured_event) {
        $captured_event = array('url' => $url, 'args' => $args);
        return array('code' => 200, 'body' => '{"success":true,"id":702}');
    };
    $event_server = $server;
    $event_server['CONTENT_TYPE'] = 'application/json';
    $event_wrapper = array(
        'schema_version' => 1,
        'endpoint' => 'events',
        'payload' => array('event_name' => 'ViewContent'),
        'web_project_id' => $identity['project_id'],
        'web_revision_id' => $identity['revision_id'],
        'web_page_id' => $identity['page_id'],
    );
    $event_result = ccw_test_event_process($bridge, $event_server, $event_wrapper, 1784290100);
    $event_payload = json_decode((string) ($captured_event['args']['body'] ?? ''), true);
    ccw_test_assert(($event_result['body']['id'] ?? null) === 702, 'rolled-back event was not accepted');
    ccw_test_assert(
        ($event_payload['web_artifact_input_hash'] ?? '') === $first['identity']['artifact_input_hash'],
        'rolled-back event used the target artifact identity'
    );
};

$tests['v2 retries a lost sync_result and rebuilds a deleted local registry without ETag'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $key = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($key['descriptor']);
    $publication_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $remote = ccw_test_install_remote_v2(array(
        $publication_id => array('route_prefix' => '/cita/', 'status' => 'pending'),
    ), $key, 1, '"multi-pending"');
    $report_url = CCW_Config::api_base() . '/api/marketing/web-installations/'
        . rawurlencode(CCW_Config::installation_id()) . '/reports';
    $sync_results = 0;
    $GLOBALS['ccw_test_http'][$report_url] = static function ($url, $args) use (&$sync_results) {
        $payload = json_decode((string) ($args['body'] ?? ''), true);
        if (($payload['event'] ?? '') === 'sync_result') {
            $sync_results++;
            return array('code' => $sync_results === 1 ? 500 : 202, 'body' => '');
        }
        return array('code' => 202, 'body' => '');
    };

    $sync = new CCW_Sync();
    $first = $sync->run(true);
    ccw_test_assert($first['result'] === 'multi_report_pending' && $first['ok'] === false, 'lost report was treated as acknowledged');
    ccw_test_assert((CCW_Config::sync_state()['etag'] ?? 'not-empty') === '', 'ETag survived an unacknowledged report');

    $GLOBALS['ccw_test_gets'] = array();
    $second = $sync->run(false);
    ccw_test_assert($second['result'] === 'multi_synced', 'the lost report was not retried');
    $desired_get = $GLOBALS['ccw_test_gets'][0] ?? array();
    ccw_test_assert(!isset($desired_get['args']['headers']['If-None-Match']), 'retry incorrectly sent the unacknowledged ETag');
    ccw_test_assert($sync_results === 2, 'sync_result was not emitted again');

    $cache = new CCW_Cache();
    @unlink($cache->root() . '/routes.json');
    $GLOBALS['ccw_test_gets'] = array();
    $rebuilt = $sync->run(false);
    ccw_test_assert($rebuilt['result'] === 'multi_synced', 'deleted registry was not rebuilt');
    ccw_test_assert(isset($cache->route_registry()['routes'][$publication_id]), 'rebuilt registry lost its route');
    $recovery_get = $GLOBALS['ccw_test_gets'][0] ?? array();
    ccw_test_assert(!isset($recovery_get['args']['headers']['If-None-Match']), 'missing registry trusted an ETag');
};

$tests['v2 applies and reports an empty signed registry after the final retired tombstone'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    $GLOBALS['ccw_test_gets'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $key = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($key['descriptor']);
    $publication_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ccw_test_install_remote_v2(array(
        $publication_id => array('route_prefix' => '/cita/', 'status' => 'retired'),
    ), $key, 1, '"retired-route"');
    $sync = new CCW_Sync();
    $sync->run(true);
    ccw_test_assert(
        ((new CCW_Cache())->route_pointer($publication_id, '/cita/')['status'] ?? '') === 'retired',
        'retirement was not applied before tombstone release'
    );

    $empty = ccw_test_install_remote_v2(array(), $key, 2, '"empty-registry"');
    $GLOBALS['ccw_test_posts'] = array();
    $result = $sync->run(true);
    $cache = new CCW_Cache();
    ccw_test_assert($result['result'] === 'multi_synced', 'empty signed registry was rejected');
    ccw_test_assert($cache->route_registry()['routes'] === array(), 'retired local tombstone was not pruned');
    $last_post = end($GLOBALS['ccw_test_posts']);
    $report = json_decode((string) ($last_post['args']['body'] ?? ''), true);
    ccw_test_assert(($report['routes'] ?? null) === array(), 'empty desired registry rehydrated local routes in sync_result');

    $GLOBALS['ccw_test_http'][$empty['api']] = static function ($url, $args) use ($empty) {
        return ($args['headers']['If-None-Match'] ?? '') === '"empty-registry"'
            ? array('code' => 304, 'body' => '')
            : array('code' => 200, 'headers' => array('etag' => '"empty-registry"'), 'body' => json_encode($empty['desired']));
    };
    $not_modified = $sync->run(false);
    ccw_test_assert($not_modified['result'] === 'not_modified', 'coherent empty registry did not revalidate with ETag');
};

$tests['v2 rejects an oversized transport plan before downloading artifact files'] = static function () {
    $setup = ccw_test_setup_intake('budget-base');
    $cache = new CCW_Cache();
    $active_before = $cache->pointer()['active_hash'];
    $publication_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $remote = ccw_test_install_remote_v2(array(
        $publication_id => array(
            'route_prefix' => '/cita/',
            'status' => 'active',
            'artifact' => $setup['artifact'],
        ),
    ), $setup['key'], 2, '"budget-overflow"');
    $hash = $setup['artifact']['hash'];
    for ($index = count($remote['desired']['desired_state']['artifacts'][$hash]['files']); $index <= 400; $index++) {
        $path = 'assets/budget-' . $index . '.css';
        $remote['desired']['desired_state']['artifacts'][$hash]['files'][$path]
            = 'https://artifacts.example.test/' . $hash . '/' . $path;
    }
    $GLOBALS['ccw_test_http'][$remote['api']] = array(
        'code' => 200,
        'headers' => array('etag' => '"budget-overflow"'),
        'body' => json_encode($remote['desired']),
    );
    $GLOBALS['ccw_test_gets'] = array();
    ccw_test_throws('ccw_transport_budget_exceeded', static function () {
        (new CCW_Sync())->run(true);
    });
    ccw_test_assert($cache->pointer()['active_hash'] === $active_before, 'transport overflow changed the active landing');
    $artifact_requests = array_filter($GLOBALS['ccw_test_gets'], static function ($request) use ($hash) {
        return strpos((string) ($request['url'] ?? ''), 'https://artifacts.example.test/' . $hash . '/') === 0;
    });
    ccw_test_assert($artifact_requests === array(), 'transport overflow downloaded artifact files before rejection');
};

$tests['configuration options are fail-closed across installation reprovisioning'] = static function () {
    $GLOBALS['ccw_test_options'] = array();
    $installation_a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $installation_b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    update_option(CCW_Config::OPTION_INSTALLATION_ID, $installation_b);
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    update_option(CCW_Config::OPTION_RUNTIME, array(
        'schema_version' => 1,
        'installation_id' => $installation_a,
        'sequence' => 99,
        'measurement' => array('enabled' => true, 'scope_type' => 'clinic', 'scope_id' => 999),
    ));
    update_option(CCW_Config::OPTION_SYNC, array(
        'installation_id' => $installation_a,
        'api_base_hash' => hash('sha256', 'https://api.example.test'),
        'etag' => '"tenant-a"',
        'v2_capability_handshake_at' => gmdate('c'),
        'v2_capability_handshake_installation_id' => $installation_a,
    ));
    ccw_test_assert(CCW_Config::runtime_configuration() === array(), 'tenant A runtime survived tenant B reprovisioning');
    ccw_test_assert(CCW_Config::sync_state() === array(), 'tenant A ETag/handshake survived tenant B reprovisioning');
    ob_start();
    (new CCW_Router(new CCW_Cache()))->measurement_tag();
    $markup = (string) ob_get_clean();
    ccw_test_assert($markup === '', 'tenant A measurement rendered under tenant B');

    $GLOBALS['ccw_test_options'] = array();
    CCW_Config::save_admin_configuration(array(
        'installation_id' => $installation_a,
        'api_base' => 'https://api-a.example.test',
        'token' => str_repeat('a', 48),
    ));
    CCW_Config::set_runtime_configuration(array(
        'schema_version' => 1,
        'installation_id' => $installation_a,
        'sequence' => 1,
        'measurement' => array('enabled' => true, 'scope_type' => 'clinic', 'scope_id' => 66),
    ));
    CCW_Config::set_sync_state(array('etag' => '"api-a"'));
    update_option(CCW_Config::OPTION_API_BASE, 'https://api-b.example.test');
    ccw_test_assert(CCW_Config::runtime_configuration() === array(), 'runtime survived a same-id API identity change');
    ccw_test_assert(CCW_Config::sync_state() === array(), 'sync state survived a same-id API identity change');

    update_option(CCW_Config::OPTION_API_BASE, 'https://api-a.example.test');
    CCW_Config::set_runtime_configuration(array(
        'schema_version' => 1,
        'installation_id' => $installation_a,
        'sequence' => 2,
        'measurement' => array('enabled' => true, 'scope_type' => 'clinic', 'scope_id' => 66),
    ));
    CCW_Config::set_sync_state(array('etag' => '"api-a-2"'));
    CCW_Config::save_admin_configuration(array(
        'installation_id' => $installation_a,
        'api_base' => 'https://api-b.example.test',
        'token' => '',
    ));
    ccw_test_assert(get_option(CCW_Config::OPTION_RUNTIME, array()) === array(), 'save did not clear runtime on API reprovisioning');
    ccw_test_assert(get_option(CCW_Config::OPTION_SYNC, array()) === array(), 'save did not clear sync state on API reprovisioning');
};

$tests['alpha.8 adopts only the exact alpha.7 raw runtime identity'] = static function () {
    $GLOBALS['ccw_test_options'] = array();
    $installation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $api = 'https://api.example.test';
    update_option(CCW_Config::OPTION_INSTALLATION_ID, $installation);
    update_option(CCW_Config::OPTION_API_BASE, $api);
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $raw = array(
        'schema_version' => 1,
        'installation_id' => $installation,
        'sequence' => 7,
        'measurement' => array(
            'enabled' => true,
            'scope_type' => 'clinic',
            'scope_id' => 66,
            'api_url' => $api,
        ),
    );
    update_option(CCW_Config::OPTION_RUNTIME, $raw);
    ccw_test_assert(CCW_Config::runtime_configuration() === $raw, 'valid alpha.7 runtime was not adopted');
    ccw_test_assert(get_option(CCW_Config::OPTION_RUNTIME) === array(
        'installation_id' => $installation,
        'api_base_hash' => hash('sha256', $api),
        'value' => $raw,
    ), 'alpha.7 runtime was not wrapped after adoption');
    $GLOBALS['ccw_test_gets'] = array();
    ob_start();
    (new CCW_Router(new CCW_Cache()))->measurement_tag();
    $markup = (string) ob_get_clean();
    ccw_test_assert(strpos($markup, $api . '/assets/loader.js') !== false, 'offline upgrade disabled the existing measurement tag');
    ccw_test_assert($GLOBALS['ccw_test_gets'] === array(), 'runtime adoption unexpectedly contacted the API');

    update_option(CCW_Config::OPTION_RUNTIME, array_replace($raw, array(
        'installation_id' => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )));
    ccw_test_assert(CCW_Config::runtime_configuration() === array(), 'foreign tenant raw runtime was adopted');

    update_option(CCW_Config::OPTION_RUNTIME, array_replace($raw, array(
        'measurement' => array_replace($raw['measurement'], array('api_url' => 'https://other.example.test')),
    )));
    ccw_test_assert(CCW_Config::runtime_configuration() === array(), 'foreign API raw runtime was adopted');
};

$tests['capability upgrade resets a corrupt registry without breaking wp-admin'] = static function () {
    ccw_test_remove_tree(__DIR__ . '/tmp');
    $GLOBALS['ccw_test_options'] = array();
    $GLOBALS['ccw_test_http'] = array();
    $GLOBALS['ccw_test_posts'] = array();
    update_option(CCW_Config::OPTION_INSTALLATION_ID, 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44');
    update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
    update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
    $cache = new CCW_Cache();
    $cache->initialize();
    file_put_contents($cache->root() . '/routes.json', '{not-json');
    $reported = CCW_Plugin::report_capabilities($cache);
    ccw_test_assert($reported === true, 'corrupt registry prevented the capability heartbeat');
    ccw_test_assert($cache->route_registry()['routes'] === array(), 'corrupt registry was not reset safely');
    $last_post = end($GLOBALS['ccw_test_posts']);
    $payload = json_decode((string) ($last_post['args']['body'] ?? ''), true);
    ccw_test_assert(($payload['schema_version'] ?? null) === 2, 'capability report lost schema v2');
    ccw_test_assert(($payload['routes'] ?? null) === array(), 'capability report invented routes after recovery');
};

$tests['release GC preserves every active and LKG hash and removes only stale releases'] = static function () {
    $setup = ccw_test_setup_intake('gc-active');
    $cache = new CCW_Cache();
    $active = $cache->pointer()['active_hash'];
    $stale = str_repeat('f', 64);
    $stale_path = $cache->root() . '/releases/' . $stale;
    wp_mkdir_p($stale_path);
    file_put_contents($stale_path . '/stale.txt', 'stale');
    $removed = $cache->prune_releases();
    ccw_test_assert(in_array($stale, $removed, true), 'stale release was not collected');
    ccw_test_assert(is_dir($cache->root() . '/releases/' . $active), 'active release was collected');
    ccw_test_assert(!is_dir($stale_path), 'stale release directory remains');
};

$tests['retired state returns no active file but retains release'] = static function () {
    $key = array_values(CCW_Trust_Store::all())[0];
    // A fresh signing key is used and anchored out-of-band for this isolated test.
    $signing = ccw_test_keypair();
    CCW_Trust_Store::import_configured_descriptor($signing['descriptor']);
    $installation = CCW_Config::installation_id();
    $runtime = array(
        'schema_version' => 1,
        'installation_id' => $installation,
        'sequence' => 4,
        'status' => 'retired',
        'route_prefix' => '/cita',
        'desired_artifact_hash' => null,
        'measurement' => array('enabled' => false),
    );
    $desired = array(
        'schema_version' => 1,
        'request_id' => 'req-retired',
        'installation_id' => $installation,
        'desired_state' => array(
            'status' => 'retired',
            'signing_key_descriptor' => $signing['descriptor'],
            'signing_key_descriptor_envelope' => array(),
            'runtime_configuration' => $runtime,
            'runtime_configuration_envelope' => ccw_test_sign($runtime, $signing),
        ),
    );
    $api = CCW_Config::api_base() . '/api/marketing/web-installations/' . rawurlencode($installation) . '/desired-state';
    $GLOBALS['ccw_test_http'][$api] = array('code' => 200, 'body' => json_encode($desired));
    (new CCW_Sync())->run(true);
    $cache = new CCW_Cache();
    ccw_test_assert($cache->pointer()['status'] === 'retired', 'retired pointer not persisted');
    ccw_test_assert($cache->resolve('index.html') === null, 'retired content still served');
    ccw_test_assert(is_dir($cache->root() . '/releases'), 'retirement deleted cached releases');
};

$tests['router maps only root, one slug and signed assets'] = static function () {
    $router = new CCW_Router(new CCW_Cache());
    ccw_test_assert($router->route_to_file('index.html') === 'index.html', 'root route mismatch');
    ccw_test_assert($router->route_to_file('implantes') === 'implantes/index.html', 'slug route mismatch');
    ccw_test_assert($router->route_to_file('assets/styles.abc.css') === 'assets/styles.abc.css', 'asset route mismatch');
    ccw_test_throws('ccw_artifact_path_invalid', static function () use ($router) {
        $router->route_to_file('%2e%2e/%2e%2e/etc/passwd');
    });
};

$tests['public landing loader never exposes the server-side intake HMAC'] = static function () {
    $setup = ccw_test_setup_intake('public-loader');
    ob_start();
    (new CCW_Router(new CCW_Cache()))->measurement_tag();
    $tag = (string) ob_get_clean();
    $bootstrap_position = strpos($tag, 'data-clinicaclick-consent-bootstrap="3.4.7"');
    $loader_position = strpos($tag, 'src="https://api.example.test/assets/loader.js"');
    ccw_test_assert($bootstrap_position !== false, 'early consent bootstrap was not rendered');
    ccw_test_assert($loader_position !== false && $bootstrap_position < $loader_position, 'consent bootstrap did not precede the async loader');
    ccw_test_assert(strpos($tag, 'assets/loader.js') !== false, 'public measurement loader was not rendered');
    ccw_test_assert(strpos($tag, 'data-clinic-id="56"') !== false, 'public loader scope is missing');
    ccw_test_assert(strpos($tag, 'data-event-bridge-url="/_clinicaclick/events"') !== false, 'same-origin event relay is missing');
    foreach (array('ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization', 'personalization_storage') as $denied) {
        ccw_test_assert(strpos($tag, $denied . ":'denied'") !== false, $denied . ' is not denied by default');
    }
    foreach (array('functionality_storage', 'security_storage') as $granted) {
        ccw_test_assert(strpos($tag, $granted . ":'granted'") !== false, $granted . ' is not granted by default');
    }
    ccw_test_assert(strpos($tag, 'initial.wait_for_update=1500') !== false, 'Consent Mode wait_for_update is missing');
    ccw_test_assert(strpos($tag, "w.gtag('set','ads_data_redaction',true)") !== false, 'ads_data_redaction is missing');
    ccw_test_assert(strpos($tag, 'previousGoogleConsentCaptured') !== false, 'existing Google consent is not preserved');
    ccw_test_assert(strpos($tag, 'data-consent-provider="external_cmp"') !== false, 'external CMP provider is missing');
    ccw_test_assert(strpos($tag, 'cc-consent-bootstrap-owned') === false, 'external CMP bootstrap takes ownership of Complianz');
    ccw_test_assert(strpos($tag, 'data-hmac-key') === false, 'public loader exposes an HMAC attribute');
    ccw_test_assert(strpos($tag, $setup['secret']) === false, 'public loader exposes IntakeConfig HMAC material');
    ccw_test_assert(strpos(json_encode($setup['artifact']), $setup['secret']) === false, 'artifact bundle or manifest contains IntakeConfig HMAC material');
};

$tests['legacy plugin remains the only global measurement owner during migration'] = static function () {
    ccw_test_setup_intake('legacy-coexistence');
    update_option('active_plugins', array('clinicaclick/clinicaclick.php', 'clinicaclick-web/clinicaclick.php'));
    $router = new CCW_Router(new CCW_Cache());

    ob_start();
    $router->measurement_tag();
    $suppressed = (string) ob_get_clean();
    ccw_test_assert($suppressed === '', 'new global loader was rendered while the legacy plugin was active');

    update_option('active_plugins', array('clinicaclick-web/clinicaclick.php'));
    ob_start();
    $router->measurement_tag();
    $active = (string) ob_get_clean();
    ccw_test_assert(strpos($active, 'assets/loader.js') !== false, 'new global loader did not take ownership after the legacy plugin was disabled');
};

$tests['Clinicaclick consent ownership is temporary and fails open for the CMP UI'] = static function () {
    $setup = ccw_test_setup_intake('clinicaclick-consent-owner');
    $runtime = CCW_Config::runtime_configuration();
    $runtime['measurement']['consent_provider'] = 'clinicaclick';
    CCW_Config::set_runtime_configuration($runtime);
    ob_start();
    (new CCW_Router(new CCW_Cache()))->measurement_tag();
    $tag = (string) ob_get_clean();
    $bootstrap_position = strpos($tag, 'data-clinicaclick-consent-bootstrap="3.4.7"');
    $loader_position = strpos($tag, 'src="https://api.example.test/assets/loader.js"');
    ccw_test_assert($bootstrap_position !== false && $loader_position !== false && $bootstrap_position < $loader_position, 'owned bootstrap order is invalid');
    ccw_test_assert(strpos($tag, 'data-consent-provider="clinicaclick"') !== false, 'Clinicaclick provider is missing');
    ccw_test_assert(strpos($tag, "classList.add('cc-consent-bootstrap-owned')") !== false, 'temporary ownership marker is missing');
    ccw_test_assert(strpos($tag, 'setTimeout(function(){bootstrap.releaseOwnership();},8000)') !== false, 'ownership fail-open timer is missing');
    ccw_test_assert(strpos($tag, "classList.remove('cc-consent-bootstrap-owned')") !== false, 'ownership release does not restore the external banner');
    ccw_test_assert(strpos($tag, 'data-hmac-key') === false, 'owned bootstrap exposes an HMAC attribute');
    ccw_test_assert(strpos($tag, $setup['secret']) === false, 'owned bootstrap exposes IntakeConfig HMAC material');
};

$tests['consent bootstrap requires both measurement and Consent Mode enabled'] = static function () {
    ccw_test_setup_intake('consent-disabled');
    $runtime = CCW_Config::runtime_configuration();
    $runtime['measurement']['consent_mode_enabled'] = false;
    CCW_Config::set_runtime_configuration($runtime);
    ob_start();
    (new CCW_Router(new CCW_Cache()))->measurement_tag();
    $tag = (string) ob_get_clean();
    ccw_test_assert(strpos($tag, 'assets/loader.js') !== false, 'measurement loader disappeared with Consent Mode disabled');
    ccw_test_assert(strpos($tag, 'data-consent-mode-enabled="false"') !== false, 'disabled Consent Mode flag is missing');
    ccw_test_assert(strpos($tag, 'data-clinicaclick-consent-bootstrap') === false, 'bootstrap rendered while Consent Mode was disabled');

    $runtime['measurement']['enabled'] = false;
    $runtime['measurement']['consent_mode_enabled'] = true;
    CCW_Config::set_runtime_configuration($runtime);
    ob_start();
    (new CCW_Router(new CCW_Cache()))->measurement_tag();
    $disabled = (string) ob_get_clean();
    ccw_test_assert($disabled === '', 'measurement or consent markup rendered while measurement was disabled');
};

$tests['signed landing event relay preserves identity for the control plane without forwarding HMAC'] = static function () {
    $setup = ccw_test_setup_intake('event-relay');
    $captured = array();
    $control_plane = 'https://api.example.test/_clinicaclick/events';
    $GLOBALS['ccw_test_http'][$control_plane] = static function ($requested_url, $args) use (&$captured) {
        $decoded = json_decode((string) ($args['body'] ?? ''), true);
        $captured[(string) ($decoded['endpoint'] ?? '')] = array('url' => $requested_url, 'args' => $args);
        return array('code' => 200, 'body' => '{"success":true,"id":601}');
    };
    $identity = array(
        'web_project_id' => $setup['fields']['web_project_id'],
        'web_revision_id' => $setup['fields']['web_revision_id'],
        'web_page_id' => $setup['fields']['web_page_id'],
    );
    $cases = array(
        'leads' => array(
            'clinic_id' => 999,
            'group_id' => 888,
            'source_detail' => 'chat',
            'lead_data' => array('telefono' => '+34612345678'),
        ),
        'events' => array(
            'clinic_id' => 999,
            'event_name' => 'CallInitiated',
            'event_data' => array('clicked_tel' => '+34612345678'),
        ),
        'whatsapp-origin' => array(
            'clinic_id' => 999,
            'ref' => 'abcdef1234567890',
        ),
    );
    foreach ($cases as $endpoint => $payload) {
        $wrapper = array_merge(array(
            'schema_version' => 1,
            'endpoint' => $endpoint,
            'payload' => $payload,
        ), $identity);
        $server = $setup['server'];
        $server['CONTENT_TYPE'] = 'application/json';
        $result = ccw_test_event_process($setup['bridge'], $server, $wrapper, 1784281000 + count($captured));
        ccw_test_assert(($result['body']['success'] ?? false) === true, 'relay did not return the accepted upstream result');
        $forwarded = $captured[$endpoint];
        $body = (string) $forwarded['args']['body'];
        $headers = $forwarded['args']['headers'];
        $decoded = json_decode($body, true);
        ccw_test_assert($forwarded['url'] === $control_plane, 'landing event bypassed the control-plane bridge');
        ccw_test_assert(($decoded['schema_version'] ?? null) === 1 && ($decoded['endpoint'] ?? '') === $endpoint, 'wrapper contract was not preserved');
        ccw_test_assert(($decoded['web_project_id'] ?? '') === $identity['web_project_id'], 'project identity was removed before control-plane validation');
        ccw_test_assert(($decoded['web_revision_id'] ?? '') === $identity['web_revision_id'], 'revision identity was removed before control-plane validation');
        ccw_test_assert(($decoded['web_page_id'] ?? '') === $identity['web_page_id'], 'page identity was removed before control-plane validation');
        ccw_test_assert(
            ($decoded['web_artifact_input_hash'] ?? '') === $setup['artifact']['identity']['artifact_input_hash'],
            'legacy loader event did not receive its server-resolved artifact identity'
        );
        ccw_test_assert(($decoded['payload']['clinic_id'] ?? null) === 999, 'WordPress unexpectedly replaced control-plane canonicalization');
        ccw_test_assert(preg_match('/^ccw_evt_[a-f0-9]{64}$/', (string) ($decoded['payload']['event_id'] ?? '')) === 1, 'server event id was not added to the wrapper');
        ccw_test_assert(($headers['Origin'] ?? '') === $server['HTTP_ORIGIN'], 'original Origin was not relayed');
        ccw_test_assert(($headers['Referer'] ?? '') === $server['HTTP_REFERER'], 'original Referer was not relayed');
        ccw_test_assert(!isset($headers['X-CC-Signature']), 'landing relay sent a browser-facing HMAC signature');
        ccw_test_assert(!isset($headers['Authorization']), 'installation bearer leaked into landing event forwarding');
        ccw_test_assert(strpos($body, $setup['secret']) === false, 'server-side HMAC leaked into the wrapper');
    }
};

$tests['ordinary WordPress event relay keeps the direct server-side HMAC contract'] = static function () {
    $setup = ccw_test_setup_intake('ordinary-event-relay');
    $captured = array();
    foreach (array('leads', 'events', 'whatsapp-origin') as $endpoint) {
        $url = 'https://api.example.test/api/intake/' . $endpoint;
        $GLOBALS['ccw_test_http'][$url] = static function ($requested_url, $args) use (&$captured, $endpoint) {
            $captured[$endpoint] = array('url' => $requested_url, 'args' => $args);
            return array('code' => 200, 'body' => '{"success":true,"id":602}');
        };
    }
    $cases = array(
        'leads' => array('clinic_id' => 999, 'group_id' => 888, 'lead_data' => array('telefono' => '+34612345678')),
        'events' => array('clinic_id' => 999, 'event_name' => 'CallInitiated'),
        'whatsapp-origin' => array('clinic_id' => 999, 'ref' => 'abcdef1234567890'),
    );
    foreach ($cases as $endpoint => $payload) {
        $wrapper = array('schema_version' => 1, 'endpoint' => $endpoint, 'payload' => $payload);
        $server = $setup['server'];
        $server['CONTENT_TYPE'] = 'application/json';
        $server['HTTP_REFERER'] = 'https://cliente.example.test/contacto/?utm_source=google';
        $result = ccw_test_event_process($setup['bridge'], $server, $wrapper, 1784281200 + count($captured));
        ccw_test_assert(($result['body']['success'] ?? false) === true, 'ordinary WordPress relay was rejected');
        $forwarded = $captured[$endpoint];
        $body = (string) $forwarded['args']['body'];
        $headers = $forwarded['args']['headers'];
        $decoded = json_decode($body, true);
        ccw_test_assert($forwarded['url'] === 'https://api.example.test/api/intake/' . $endpoint, 'ordinary page did not use the direct intake endpoint');
        ccw_test_assert(($decoded['clinic_id'] ?? null) === 56 && !isset($decoded['group_id']), 'ordinary relay did not enforce its signed clinic scope');
        ccw_test_assert(($decoded['domain'] ?? '') === 'cliente.example.test', 'ordinary relay did not canonicalize its domain');
        ccw_test_assert(($decoded['page_url'] ?? '') === $server['HTTP_REFERER'], 'ordinary relay did not canonicalize its page URL');
        ccw_test_assert(hash_equals(hash_hmac('sha256', $body, $setup['secret']), $headers['X-CC-Signature']), 'ordinary event relay HMAC mismatch');
        ccw_test_assert(strpos($body, $setup['secret']) === false, 'server-side HMAC leaked into the ordinary payload');
    }
};

$tests['landing event relay rejects cross-origin incomplete forged and browser-signed wrappers locally'] = static function () {
    $setup = ccw_test_setup_intake('event-relay-adversarial');
    $identity = array(
        'web_project_id' => $setup['fields']['web_project_id'],
        'web_revision_id' => $setup['fields']['web_revision_id'],
        'web_page_id' => $setup['fields']['web_page_id'],
    );
    $wrapper = array_merge(array(
        'schema_version' => 1,
        'endpoint' => 'events',
        'payload' => array('event_name' => 'ViewContent'),
    ), $identity);
    $bad_server = $setup['server'];
    $bad_server['CONTENT_TYPE'] = 'application/json';
    $bad_server['HTTP_ORIGIN'] = 'https://evil.example.test';
    ccw_test_throws('ccw_event_bridge_origin_invalid', static function () use ($setup, $bad_server, $wrapper) {
        ccw_test_event_process($setup['bridge'], $bad_server, $wrapper, 1784281300);
    });

    $incomplete = $wrapper;
    unset($incomplete['web_page_id']);
    $server = $setup['server'];
    $server['CONTENT_TYPE'] = 'application/json';
    ccw_test_throws('ccw_event_bridge_identity_incomplete', static function () use ($setup, $server, $incomplete) {
        ccw_test_event_process($setup['bridge'], $server, $incomplete, 1784281301);
    });

    foreach (array('', '   ', null) as $empty_value) {
        $empty = $wrapper;
        $empty['web_page_id'] = $empty_value;
        ccw_test_throws('ccw_event_bridge_identity_incomplete', static function () use ($setup, $server, $empty) {
            ccw_test_event_process($setup['bridge'], $server, $empty, 1784281301);
        });
    }
    $all_empty = $wrapper;
    $all_empty['web_project_id'] = '';
    $all_empty['web_revision_id'] = '';
    $all_empty['web_page_id'] = '';
    ccw_test_throws('ccw_event_bridge_identity_incomplete', static function () use ($setup, $server, $all_empty) {
        ccw_test_event_process($setup['bridge'], $server, $all_empty, 1784281301);
    });

    $forged = $wrapper;
    $forged['web_project_id'] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ccw_test_throws('ccw_event_bridge_identity_mismatch', static function () use ($setup, $server, $forged) {
        ccw_test_event_process($setup['bridge'], $server, $forged, 1784281302);
    });

    $browser_signed = $wrapper;
    $browser_signed['signature'] = str_repeat('a', 64);
    ccw_test_throws('ccw_event_bridge_contract_invalid', static function () use ($setup, $server, $browser_signed) {
        ccw_test_event_process($setup['bridge'], $server, $browser_signed, 1784281303);
    });
    ccw_test_assert($GLOBALS['ccw_test_posts'] === array(), 'a locally rejected landing event reached the control plane');
};

$tests['signed landing bridge forwards a minimal HMAC request and redirects without PII'] = static function () {
    $setup = ccw_test_setup_intake('bridge');
    $captured = null;
    $GLOBALS['ccw_test_http'][$setup['upstream']] = static function ($url, $args) use (&$captured) {
        $captured = array('url' => $url, 'args' => $args);
        return array('code' => 201, 'body' => '{"id":321}');
    };
    $result = ccw_test_bridge_process($setup['bridge'], $setup['server'], $setup['fields']);
    ccw_test_assert($result['honeypot'] === false, 'real submission was treated as honeypot');
    ccw_test_assert(
        $result['location'] === 'https://cliente.example.test/cita/?gclid=click_123&utm_campaign=implantes#cc-form-bridge-success',
        'success redirect did not use the signed page/anchor or did not reduce the query'
    );
    ccw_test_assert(strpos($result['location'], 'ana%40') === false && strpos($result['location'], '612') === false, 'PII leaked into redirect');
    ccw_test_assert($captured !== null && $captured['url'] === $setup['upstream'], 'request was not sent to the fixed intake endpoint');
    $headers = $captured['args']['headers'];
    $body = (string) $captured['args']['body'];
    ccw_test_assert(!isset($headers['Authorization']), 'installation bearer leaked into public intake forwarding');
    ccw_test_assert(hash_equals(hash_hmac('sha256', $body, $setup['secret']), $headers['X-CC-Signature']), 'upstream body signature mismatch');
    ccw_test_assert($headers['X-CC-Event-Id'] === $result['event_id'], 'event id header mismatch');
    $payload = json_decode($body, true);
    ccw_test_assert(is_array($payload), 'forwarded JSON is invalid');
    ccw_test_assert(($payload['clinic_id'] ?? null) === 56 && !isset($payload['group_id']), 'visitor controlled or missing runtime scope');
    ccw_test_assert(($payload['external_source'] ?? '') === 'clinicaclick_web_landing', 'trusted landing source missing');
    ccw_test_assert(($payload['source'] ?? '') === 'google_ads' && ($payload['channel'] ?? '') === 'paid', 'click attribution was not mapped');
    ccw_test_assert(($payload['gclid'] ?? '') === 'click_123' && !isset($payload['ignored']), 'query attribution was not allowlisted');
    ccw_test_assert(($payload['consent']['contact'] ?? '') === 'granted', 'explicit form consent was not recorded');
    ccw_test_assert(($payload['consent']['ad_user_data'] ?? '') === 'granted', 'ad_user_data choice was not forwarded');
    ccw_test_assert(($payload['consent']['ad_personalization'] ?? '') === 'denied', 'ad_personalization choice was not forwarded');
    ccw_test_assert(($payload['lead_data']['telefono'] ?? '') === '+34612345678', 'phone was not normalized');
    ccw_test_assert(($payload['web_form_id'] ?? '') === 'form-bridge', 'signed form identity missing');
    ccw_test_assert(
        ($payload['web_artifact_input_hash'] ?? '') === $setup['artifact']['identity']['artifact_input_hash'],
        'legacy alpha.7 form did not receive its server-resolved artifact identity'
    );

    $without_ads = $setup['fields'];
    unset($without_ads['_cc_ad_user_data'], $without_ads['_cc_ad_personalization']);
    ccw_test_bridge_process($setup['bridge'], $setup['server'], $without_ads, 1784280301);
    $second_payload = json_decode((string) $captured['args']['body'], true);
    ccw_test_assert(!array_key_exists('ad_user_data', $second_payload['consent']), 'missing ad_user_data was invented');
    ccw_test_assert(!array_key_exists('ad_personalization', $second_payload['consent']), 'missing ad_personalization was invented');
};

$tests['global intake bridge selects the signed contract of the current page'] = static function () {
    $setup = ccw_test_setup_intake('global-bridge', true);
    $captured = null;
    $GLOBALS['ccw_test_http'][$setup['upstream']] = static function ($url, $args) use (&$captured) {
        $captured = json_decode((string) ($args['body'] ?? ''), true);
        return array('code' => 201, 'body' => '{"id":327}');
    };
    $fields = $setup['fields'];
    $fields['web_page_id'] = $setup['artifact']['identity']['info_page_id'];
    $server = $setup['server'];
    $server['HTTP_REFERER'] = 'https://cliente.example.test/cita/informacion/?gclid=global_click';

    $result = ccw_test_bridge_process($setup['bridge'], $server, $fields);

    ccw_test_assert(is_array($captured), 'global form submission was not forwarded');
    ccw_test_assert(
        ($captured['web_page_id'] ?? '') === $setup['artifact']['identity']['info_page_id'],
        'global form did not preserve its current signed page'
    );
    ccw_test_assert(
        $result['location'] === 'https://cliente.example.test/cita/informacion/?gclid=global_click#cc-form-global-bridge-success',
        'global form redirect did not use the current page contract'
    );
};

$tests['landing bridge preserves strict first-page attribution across signed routes'] = static function () {
    $setup = ccw_test_setup_intake('cross-page');
    $captured = null;
    $GLOBALS['ccw_test_http'][$setup['upstream']] = static function ($url, $args) use (&$captured) {
        $captured = json_decode((string) $args['body'], true);
        return array('code' => 201, 'body' => '{"id":323}');
    };
    $fields = $setup['fields'];
    $fields['_cc_attr_landing_path'] = '/cita/informacion/';
    $fields['_cc_attr_gclid'] = 'stored-click';
    $fields['_cc_attr_utm_source'] = 'google';
    $fields['_cc_attr_utm_medium'] = 'cpc';
    $fields['_cc_attr_utm_campaign'] = 'implantes barcelona';
    $fields['_cc_attr_cc_gads_customer_id'] = '1851215478';
    $fields['_cc_attr_cc_gads_campaign_id'] = '21316904358';
    $server = $setup['server'];
    $server['HTTP_REFERER'] = 'https://cliente.example.test/cita/';
    $result = ccw_test_bridge_process($setup['bridge'], $server, $fields);
    ccw_test_assert(is_array($captured), 'cross-page payload was not forwarded');
    ccw_test_assert(($captured['gclid'] ?? '') === 'stored-click', 'stored click id was not preserved');
    ccw_test_assert(($captured['source'] ?? '') === 'google_ads', 'stored click id did not determine source');
    ccw_test_assert(
        ($captured['page_url'] ?? '') === 'https://cliente.example.test/cita/?gclid=stored-click&utm_source=google&utm_medium=cpc&utm_campaign=implantes%20barcelona&cc_gads_customer_id=1851215478&cc_gads_campaign_id=21316904358',
        'current page URL was not canonicalized with attribution'
    );
    ccw_test_assert(
        ($captured['landing_url'] ?? '') === 'https://cliente.example.test/cita/informacion/?gclid=stored-click&utm_source=google&utm_medium=cpc&utm_campaign=implantes%20barcelona&cc_gads_customer_id=1851215478&cc_gads_campaign_id=21316904358',
        'signed initial page was not preserved'
    );
    ccw_test_assert(($captured['google_ads_customer_id'] ?? '') === '1851215478', 'Google customer id was not canonicalized');
    ccw_test_assert(($captured['google_ads_campaign_id'] ?? '') === '21316904358', 'Google campaign id was not canonicalized');
    ccw_test_assert(!isset($captured['cc_gads_customer_id']) && !isset($captured['cc_gads_campaign_id']), 'browser query names leaked into canonical payload fields');
    ccw_test_assert(strpos($result['location'], '#cc-form-cross-page-success') !== false, 'cross-page redirect did not retain signed anchor');

    $current = ccw_test_setup_intake('query-wins');
    $GLOBALS['ccw_test_http'][$current['upstream']] = static function ($url, $args) use (&$captured) {
        $captured = json_decode((string) $args['body'], true);
        return array('code' => 201, 'body' => '{"id":324}');
    };
    $current_fields = $current['fields'];
    $current_fields['_cc_attr_gclid'] = 'stored-click';
    ccw_test_bridge_process($current['bridge'], $current['server'], $current_fields);
    ccw_test_assert(($captured['gclid'] ?? '') === 'click_123', 'current query did not override stored attribution');

    $duplicate = ccw_test_setup_intake('query-duplicate');
    $GLOBALS['ccw_test_http'][$duplicate['upstream']] = static function ($url, $args) use (&$captured) {
        $captured = json_decode((string) $args['body'], true);
        return array('code' => 201, 'body' => '{"id":326}');
    };
    $duplicate_fields = $duplicate['fields'];
    $duplicate_fields['_cc_attr_gclid'] = 'stored-click';
    $duplicate_server = $duplicate['server'];
    $duplicate_server['HTTP_REFERER'] = 'https://cliente.example.test/cita/?gclid=first&gclid=second';
    ccw_test_bridge_process($duplicate['bridge'], $duplicate_server, $duplicate_fields);
    ccw_test_assert(($captured['gclid'] ?? '') === 'stored-click', 'ambiguous query attribution should not override stored attribution');
};

$tests['landing bridge rejects manipulated stored attribution and unsigned landing paths'] = static function () {
    $setup = ccw_test_setup_intake('stored-adversarial');
    $GLOBALS['ccw_test_http'][$setup['upstream']] = array('code' => 201, 'body' => '{"id":325}');

    $bad_click = $setup['fields'];
    $bad_click['_cc_attr_gclid'] = 'not allowed';
    ccw_test_throws('ccw_intake_attribution_invalid', static function () use ($setup, $bad_click) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $bad_click);
    });

    $unsigned_path = $setup['fields'];
    $unsigned_path['_cc_attr_landing_path'] = '/cita/no-publicada/';
    ccw_test_throws('ccw_intake_landing_path_mismatch', static function () use ($setup, $unsigned_path) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $unsigned_path);
    });

    $traversal = $setup['fields'];
    $traversal['_cc_attr_landing_path'] = '/cita/%2e%2e/';
    ccw_test_throws('ccw_intake_landing_path_invalid', static function () use ($setup, $traversal) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $traversal);
    });
};

$tests['landing bridge fails closed on forged browser metadata, duplicate fields and bad consent'] = static function () {
    $setup = ccw_test_setup_intake('adversarial');
    $GLOBALS['ccw_test_http'][$setup['upstream']] = array('code' => 201, 'body' => '{"id":322}');

    $forged = $setup['fields'];
    $forged['web_project_id'] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ccw_test_throws('ccw_intake_signed_form_mismatch', static function () use ($setup, $forged) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $forged);
    });

    $forged_artifact = $setup['fields'];
    $forged_artifact['web_artifact_input_hash'] = str_repeat('f', 64);
    ccw_test_throws('ccw_intake_artifact_identity_mismatch', static function () use ($setup, $forged_artifact) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $forged_artifact);
    });

    $cross_origin = $setup['server'];
    $cross_origin['HTTP_REFERER'] = 'https://attacker.example/cita/';
    ccw_test_throws('ccw_intake_referer_invalid', static function () use ($setup, $cross_origin) {
        ccw_test_bridge_process($setup['bridge'], $cross_origin, $setup['fields']);
    });

    $wrong_path = $setup['server'];
    $wrong_path['HTTP_REFERER'] = 'https://cliente.example.test/cita/../../admin/';
    ccw_test_throws('ccw_intake_referer_path_invalid', static function () use ($setup, $wrong_path) {
        ccw_test_bridge_process($setup['bridge'], $wrong_path, $setup['fields']);
    });

    $no_consent = $setup['fields'];
    $no_consent['privacy_consent'] = 'true';
    ccw_test_throws('ccw_intake_privacy_consent_required', static function () use ($setup, $no_consent) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $no_consent);
    });

    $invalid_google_consent = $setup['fields'];
    $invalid_google_consent['_cc_ad_user_data'] = 'true';
    ccw_test_throws('ccw_intake_google_consent_invalid', static function () use ($setup, $invalid_google_consent) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $invalid_google_consent);
    });

    $raw = http_build_query($setup['fields'], '', '&', PHP_QUERY_RFC3986) . '&email=second%40example.test';
    $server = $setup['server'];
    $server['CONTENT_LENGTH'] = (string) strlen($raw);
    ccw_test_throws('ccw_intake_form_fields_invalid', static function () use ($setup, $server, $raw) {
        $setup['bridge']->process($server, $raw, 1784280000);
    });

    $too_many = http_build_query($setup['fields'], '', '&', PHP_QUERY_RFC3986) . str_repeat('&email=second%40example.test', 20);
    $server['CONTENT_LENGTH'] = (string) strlen($too_many);
    ccw_test_throws('ccw_intake_too_many_fields', static function () use ($setup, $server, $too_many) {
        $setup['bridge']->process($server, $too_many, 1784280000);
    });

    $minimal = array_intersect_key($setup['fields'], array_fill_keys(array(
        'email', 'privacy_consent', '_cc_company', 'web_project_id', 'web_revision_id', 'web_page_id', 'web_form_id'
    ), true));
    $minimal['api_url'] = 'https://attacker.example/intake';
    $raw = http_build_query($minimal, '', '&', PHP_QUERY_RFC3986);
    $server['CONTENT_LENGTH'] = (string) strlen($raw);
    ccw_test_throws('ccw_intake_form_fields_invalid', static function () use ($setup, $server, $raw) {
        $setup['bridge']->process($server, $raw, 1784280000);
    });
    ccw_test_assert($GLOBALS['ccw_test_posts'] === array(), 'a rejected browser request reached an upstream endpoint');
};

$tests['landing bridge honeypot is a fake success and upstream 202 is never accepted'] = static function () {
    $setup = ccw_test_setup_intake('honeypot');
    $fields = $setup['fields'];
    $fields['_cc_company'] = 'Cheap SEO';
    $result = ccw_test_bridge_process($setup['bridge'], $setup['server'], $fields);
    ccw_test_assert($result['honeypot'] === true && $result['event_id'] === 'honeypot', 'honeypot did not return a fake success');
    ccw_test_assert($GLOBALS['ccw_test_posts'] === array(), 'honeypot reached the backend');

    $GLOBALS['ccw_test_http'][$setup['upstream']] = array('code' => 202, 'body' => '{"message":"discarded"}');
    ccw_test_throws('ccw_intake_upstream_rejected', static function () use ($setup) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $setup['fields']);
    });
};

$tests['landing bridge rate limits hashed IP state before API saturation'] = static function () {
    $setup = ccw_test_setup_intake('ratelimit');
    $GLOBALS['ccw_test_http'][$setup['upstream']] = array('code' => 201, 'body' => '{"id":400}');
    for ($index = 0; $index < CCW_Intake_Bridge::IP_LIMIT; $index++) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $setup['fields'], 1784280000 + $index);
    }
    ccw_test_throws('ccw_intake_rate_limited', static function () use ($setup) {
        ccw_test_bridge_process($setup['bridge'], $setup['server'], $setup['fields'], 1784280010);
    });
    $state = (string) file_get_contents((new CCW_Cache())->root() . '/intake-rate-limit.json');
    ccw_test_assert(strpos($state, '203.0.113.8') === false, 'raw IP leaked into rate-limit state');
    ccw_test_assert(strpos($state, 'ana@example.test') === false, 'PII leaked into rate-limit state');
};

$tests['artifact inspector accepts only the exact signed external loader and matching CSP'] = static function () {
    $setup = ccw_test_setup_intake('loader');
    $pointer = (new CCW_Cache())->pointer();
    $runtime = $pointer['runtime_configuration'];
    $artifact = $setup['artifact'];
    $html = $artifact['files']['index.html'];
    preg_match('/<script\b[^>]*src="https:\/\/api\.example\.test\/assets\/loader\.js"[^>]*><\/script>/i', $html, $loader_match);
    $duplicate_loader = (string) ($loader_match[0] ?? '');

    $cases = array(
        'ccw_artifact_loader_attributes_invalid' => str_replace(' async data-api-url=', ' async defer data-api-url=', $html),
        'ccw_artifact_loader_configuration_mismatch' => str_replace('data-clinic-id="56"', 'data-clinic-id="57"', $html),
        'ccw_artifact_loader_count_invalid' => str_replace('</head>', $duplicate_loader . '</head>', $html),
        'ccw_artifact_loader_csp_missing' => str_replace('connect-src &apos;self&apos; https://api.example.test', 'connect-src &apos;self&apos;', $html),
        'ccw_artifact_form_forbidden' => str_replace(' data-cc-native-intake="true"', '', $html),
    );
    foreach ($cases as $expected => $candidate) {
        $tmp = tempnam(sys_get_temp_dir(), 'ccw-loader-');
        file_put_contents($tmp, $candidate);
        ccw_test_throws($expected, static function () use ($tmp, $candidate, $runtime, $pointer) {
            CCW_Manifest::inspect_file('index.html', $tmp, array(
                'size_bytes' => strlen($candidate),
                'sha256' => hash('sha256', $candidate),
            ), $runtime, $pointer['manifest']);
        });
        unlink($tmp);
    }
    foreach (array(
        str_replace('style-src &apos;self&apos; &apos;unsafe-inline&apos;', 'style-src &apos;self&apos;', $html),
        str_replace('https://api.example.test data:', 'data:', $html),
    ) as $candidate) {
        $tmp = tempnam(sys_get_temp_dir(), 'ccw-loader-csp-');
        file_put_contents($tmp, $candidate);
        ccw_test_throws('ccw_artifact_loader_csp_missing', static function () use ($tmp, $candidate, $runtime, $pointer) {
            CCW_Manifest::inspect_file('index.html', $tmp, array(
                'size_bytes' => strlen($candidate),
                'sha256' => hash('sha256', $candidate),
            ), $runtime, $pointer['manifest']);
        });
        unlink($tmp);
    }
};

$tests['artifact CSP limits dynamic runtime allowances to styles and images'] = static function () {
    $artifact = ccw_test_artifact('csp-sources');
    $runtime = (new CCW_Cache())->pointer()['runtime_configuration'] ?? array();
    $headers = $artifact['manifest']['headers'];
    CCW_Manifest::safe_headers($headers, $runtime);
    foreach (array(
        str_replace("script-src 'sha256-example'", "script-src 'unsafe-inline' 'sha256-example'", $headers['content-security-policy']),
        str_replace("connect-src 'self'", "connect-src data: 'self'", $headers['content-security-policy']),
        str_replace("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' blob:", $headers['content-security-policy']),
    ) as $unsafe) {
        ccw_test_throws('ccw_artifact_security_headers_incomplete', static function () use ($headers, $runtime, $unsafe) {
            CCW_Manifest::safe_headers(array_merge($headers, array('content-security-policy' => $unsafe)), $runtime);
        });
    }
};

$tests['site claim exposes only a digest and disappears after backend ACK'] = static function () {
    $installation_id = 'f6d6d9bb-093e-4a40-8465-5ebf9edcde44';
    $raw_claim = str_repeat('q', 43);
    $reflection = new ReflectionClass('CCW_Config');
    $property = $reflection->getProperty('provisioned');
    $property->setAccessible(true);
    $property->setValue(null, array(
        'installation_id' => $installation_id,
        'api_base' => 'https://crm.clinicaclick.com',
        'token' => 'ccw_' . str_repeat('a', 43),
        'site_claim_token' => $raw_claim,
    ));
    delete_option(CCW_Config::OPTION_SITE_CLAIM_ACK);

    $document = CCW_Site_Claim::claim_document();
    ccw_test_assert(is_array($document), 'site claim was not exposed while pending');
    ccw_test_assert(($document['installation_id'] ?? '') === $installation_id, 'site claim installation mismatch');
    ccw_test_assert(($document['canonical_home_url'] ?? '') === 'https://cliente.example.test', 'site claim home mismatch');
    ccw_test_assert(($document['claim_token_sha256'] ?? '') === hash('sha256', $raw_claim), 'site claim digest mismatch');
    ccw_test_assert(strpos(json_encode($document), $raw_claim) === false, 'site claim leaked the raw challenge');

    ccw_test_assert(CCW_Config::acknowledge_site_claim() === true, 'site claim ACK was not persisted');
    ccw_test_assert(CCW_Site_Claim::claim_document() === null, 'site claim remained public after ACK');
    $property->setValue(null, array());
    delete_option(CCW_Config::OPTION_SITE_CLAIM_ACK);
};

$passed = 0;
foreach ($tests as $name => $test) {
    try {
        $test();
        $passed++;
        echo "ok - {$name}\n";
    } catch (Throwable $error) {
        fwrite(STDERR, "not ok - {$name}: {$error->getMessage()}\n");
        exit(1);
    }
}

echo "{$passed} tests passed\n";
ccw_test_remove_tree(__DIR__ . '/tmp');
