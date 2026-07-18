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
    $csp = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'sha256-example' https://api.example.test; connect-src 'self' https://api.example.test";
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
        ),
    );
}

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

function ccw_test_install_remote(array $artifact, array $key, $sequence, $etag = '"v1"')
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
            'signing_key_descriptor_envelope' => array(),
            'runtime_configuration' => $runtime,
            'runtime_configuration_envelope' => ccw_test_sign($runtime, $key),
        ),
    );
    $api = CCW_Config::api_base() . '/api/marketing/web-installations/' . rawurlencode($installation) . '/desired-state';
    $GLOBALS['ccw_test_http'][$api] = array('code' => 200, 'headers' => array('etag' => $etag), 'body' => json_encode($desired));
    return array('api' => $api, 'manifest_url' => $manifest_url, 'envelope_url' => $envelope_url, 'desired' => $desired);
}

/** @return array<string,mixed> */
function ccw_test_setup_intake($marker = 'intake')
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
    $artifact = ccw_test_artifact($marker);
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

$tests['same-origin event relay signs chat telephone WhatsApp and generic channels server-side'] = static function () {
    $setup = ccw_test_setup_intake('event-relay');
    $captured = array();
    foreach (array('leads', 'events', 'whatsapp-origin') as $endpoint) {
        $url = 'https://api.example.test/api/intake/' . $endpoint;
        $GLOBALS['ccw_test_http'][$url] = static function ($requested_url, $args) use (&$captured, $endpoint) {
            $captured[$endpoint] = array('url' => $requested_url, 'args' => $args);
            return array('code' => 200, 'body' => '{"success":true,"id":601}');
        };
    }
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
        ccw_test_assert(($decoded['clinic_id'] ?? null) === 56 && !isset($decoded['group_id']), 'browser overrode the signed clinic scope');
        ccw_test_assert(($decoded['domain'] ?? '') === 'cliente.example.test', 'browser overrode the canonical domain');
        ccw_test_assert(strpos((string) ($decoded['page_url'] ?? ''), 'https://cliente.example.test/cita/') === 0, 'canonical page URL missing');
        ccw_test_assert(hash_equals(hash_hmac('sha256', $body, $setup['secret']), $headers['X-CC-Signature']), 'event relay HMAC mismatch');
        ccw_test_assert(strpos($body, $setup['secret']) === false, 'server-side HMAC leaked into the forwarded JSON');
    }

    $forged = array_merge(array(
        'schema_version' => 1,
        'endpoint' => 'events',
        'payload' => array('event_name' => 'ViewContent'),
    ), $identity);
    $bad_server = $setup['server'];
    $bad_server['CONTENT_TYPE'] = 'application/json';
    $bad_server['HTTP_ORIGIN'] = 'https://evil.example.test';
    ccw_test_throws('ccw_event_bridge_origin_invalid', static function () use ($setup, $bad_server, $forged) {
        ccw_test_event_process($setup['bridge'], $bad_server, $forged, 1784281100);
    });
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

    $without_ads = $setup['fields'];
    unset($without_ads['_cc_ad_user_data'], $without_ads['_cc_ad_personalization']);
    ccw_test_bridge_process($setup['bridge'], $setup['server'], $without_ads, 1784280301);
    $second_payload = json_decode((string) $captured['args']['body'], true);
    ccw_test_assert(!array_key_exists('ad_user_data', $second_payload['consent']), 'missing ad_user_data was invented');
    ccw_test_assert(!array_key_exists('ad_personalization', $second_payload['consent']), 'missing ad_personalization was invented');
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
