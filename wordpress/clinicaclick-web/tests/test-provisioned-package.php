<?php

declare(strict_types=1);

/**
 * Cross-runtime acceptance test for the exact archive emitted by the Node
 * provisioner. It intentionally loads the PHP files from the extracted ZIP,
 * not from the checkout, so package omissions and bootstrap drift fail here.
 */

function ccw_package_fail(string $message): void
{
    throw new RuntimeException($message);
}

function ccw_package_assert(bool $condition, string $message): void
{
    if (!$condition) {
        ccw_package_fail($message);
    }
}

function ccw_package_remove_tree(string $path): void
{
    if (!is_dir($path) || is_link($path)) {
        if (is_file($path) || is_link($path)) {
            @unlink($path);
        }
        return;
    }
    foreach (scandir($path) ?: array() as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        ccw_package_remove_tree($path . '/' . $item);
    }
    @rmdir($path);
}

/** @return array<int,string> */
function ccw_extract_stored_zip(string $archive, string $destination): array
{
    $offset = 0;
    $length = strlen($archive);
    $entries = array();
    while ($offset + 4 <= $length) {
        $signature = unpack('Vvalue', substr($archive, $offset, 4));
        $signature = (int) ($signature['value'] ?? 0);
        if ($signature === 0x02014b50) {
            break;
        }
        ccw_package_assert($signature === 0x04034b50, 'ZIP local header is invalid');
        ccw_package_assert($offset + 30 <= $length, 'ZIP local header is truncated');
        $header = unpack(
            'Vsignature/vversion/vflags/vmethod/vtime/vdate/Vcrc/Vcompressed/Vuncompressed/vname_length/vextra_length',
            substr($archive, $offset, 30)
        );
        ccw_package_assert((int) $header['flags'] === 0, 'ZIP flags are not deterministic');
        ccw_package_assert((int) $header['method'] === 0, 'ZIP entry is not stored');
        ccw_package_assert(
            (int) $header['compressed'] === (int) $header['uncompressed'],
            'ZIP stored entry sizes differ'
        );
        $nameLength = (int) $header['name_length'];
        $extraLength = (int) $header['extra_length'];
        $bodyLength = (int) $header['uncompressed'];
        $nameOffset = $offset + 30;
        $bodyOffset = $nameOffset + $nameLength + $extraLength;
        ccw_package_assert($bodyOffset + $bodyLength <= $length, 'ZIP entry is truncated');
        $name = substr($archive, $nameOffset, $nameLength);
        ccw_package_assert(
            preg_match('#^clinicaclick-web/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$#', $name) === 1,
            'ZIP contains an unsafe path'
        );
        ccw_package_assert(!isset($entries[$name]), 'ZIP contains a duplicate path');
        $body = substr($archive, $bodyOffset, $bodyLength);
        ccw_package_assert(
            hash_equals(sprintf('%08x', (int) $header['crc']), hash('crc32b', $body)),
            'ZIP entry CRC mismatch'
        );
        $target = $destination . '/' . $name;
        $parent = dirname($target);
        ccw_package_assert(is_dir($parent) || mkdir($parent, 0750, true), 'Could not create ZIP destination');
        ccw_package_assert(file_put_contents($target, $body, LOCK_EX) === strlen($body), 'Could not extract ZIP entry');
        $entries[$name] = $name;
        $offset = $bodyOffset + $bodyLength;
    }
    ccw_package_assert(count($entries) >= 10, 'Provisioned ZIP is unexpectedly incomplete');
    ccw_package_assert($offset + 4 <= $length, 'ZIP central directory is missing');
    return array_values($entries);
}

$archive = (string) stream_get_contents(STDIN);
ccw_package_assert(strlen($archive) > 1024, 'Node provisioner did not emit a ZIP');
ccw_package_assert(strpos($archive, 'PRIVATE KEY') === false, 'ZIP contains private signing material');

$temporaryRoot = sys_get_temp_dir() . '/ccw-provisioned-' . bin2hex(random_bytes(12));
ccw_package_assert(mkdir($temporaryRoot, 0700, true), 'Could not create package test root');
register_shutdown_function(static function () use ($temporaryRoot): void {
    ccw_package_remove_tree($temporaryRoot);
});

$entries = ccw_extract_stored_zip($archive, $temporaryRoot);
$pluginRoot = $temporaryRoot . '/clinicaclick-web';
ccw_package_assert(in_array('clinicaclick-web/clinicaclick.php', $entries, true), 'Plugin entrypoint is missing');
ccw_package_assert(in_array('clinicaclick-web/config/installation.php', $entries, true), 'Provisioned config is missing');
ccw_package_assert(
    in_array('clinicaclick-web/includes/class-ccw-intake-bridge.php', $entries, true),
    'Intake bridge is missing from the provisioned package'
);
$entrypoint = file_get_contents($pluginRoot . '/clinicaclick.php');
ccw_package_assert(is_string($entrypoint), 'Plugin entrypoint could not be read');
ccw_package_assert(
    strpos($entrypoint, 'Plugin Name: ClinicaClick Web Publisher') !== false,
    'Plugin has an ambiguous visible name'
);
foreach ($entries as $entry) {
    ccw_package_assert(
        preg_match('#^clinicaclick-web/(?:tests|fixtures|tools|dist)/#', $entry) !== 1,
        'Development source leaked into the provisioned package'
    );
    ccw_package_assert(strpos($entry, 'clinicaclick/') !== 0, 'Legacy plugin root leaked into the package');
}

define('ABSPATH', $temporaryRoot . '/public/wordpress/');
define('WP_CONTENT_DIR', $temporaryRoot . '/public/wp-content');
define('CLINICACLICK_WEB_CACHE_DIR', $temporaryRoot . '/private/clinicaclick-web-cache');
define('DAY_IN_SECONDS', 86400);
define('MINUTE_IN_SECONDS', 60);
$_SERVER['SERVER_SOFTWARE'] = 'nginx/1.26.1';
$_SERVER['DOCUMENT_ROOT'] = $temporaryRoot . '/public';

$GLOBALS['ccw_package_options'] = array();
$GLOBALS['ccw_package_rewrites'] = array();
$GLOBALS['ccw_package_posts'] = array();
$GLOBALS['ccw_package_response_body'] = '';

final class WP_Error
{
    public $message;
    public function __construct($message)
    {
        $this->message = $message;
    }
}

function plugin_dir_path($file)
{
    return rtrim(dirname((string) $file), '/\\') . '/';
}

function get_option($key, $default = false)
{
    return array_key_exists($key, $GLOBALS['ccw_package_options'])
        ? $GLOBALS['ccw_package_options'][$key]
        : $default;
}

function update_option($key, $value, $autoload = null)
{
    $GLOBALS['ccw_package_options'][$key] = $value;
    return true;
}

function delete_option($key)
{
    unset($GLOBALS['ccw_package_options'][$key]);
    return true;
}

function home_url($path = '')
{
    return 'https://cliente.example.test' . $path;
}

function get_bloginfo($field)
{
    return $field === 'version' ? '6.6-test' : '';
}

function wp_json_encode($value, $flags = 0)
{
    return json_encode($value, $flags);
}

function wp_safe_remote_post($url, $args = array())
{
    $GLOBALS['ccw_package_posts'][] = array('url' => $url, 'args' => $args);
    return array(
        'response' => array('code' => 202),
        'headers' => array(),
        'body' => (string) $GLOBALS['ccw_package_response_body'],
    );
}

function is_wp_error($value)
{
    return $value instanceof WP_Error;
}

function wp_remote_retrieve_response_code($response)
{
    return (int) ($response['response']['code'] ?? 0);
}

function wp_remote_retrieve_body($response)
{
    return (string) ($response['body'] ?? '');
}

function wp_mkdir_p($path)
{
    return is_dir($path) || mkdir($path, 0750, true);
}

function is_admin()
{
    return false;
}

function is_multisite()
{
    return false;
}

function add_action($hook, $callback, $priority = 10, $acceptedArgs = 1)
{
    return true;
}

function add_filter($hook, $callback, $priority = 10, $acceptedArgs = 1)
{
    return true;
}

function add_rewrite_rule($regex, $query, $position = 'bottom')
{
    $GLOBALS['ccw_package_rewrites'][] = array($regex, $query, $position);
}

function flush_rewrite_rules($hard = true)
{
    return true;
}

function wp_next_scheduled($hook)
{
    return false;
}

function wp_schedule_event($timestamp, $recurrence, $hook, $args = array(), $wpError = false)
{
    return true;
}

function wp_unschedule_event($timestamp, $hook, $args = array(), $wpError = false)
{
    return true;
}

function register_activation_hook($file, $callback)
{
    return true;
}

function register_deactivation_hook($file, $callback)
{
    return true;
}

function plugin_basename($file)
{
    return basename((string) $file);
}

function deactivate_plugins($plugins, $silent = false, $networkWide = null)
{
    return true;
}

function wp_die($message)
{
    throw new RuntimeException((string) $message);
}

require $pluginRoot . '/clinicaclick.php';

$expectedInstallationId = 'd6d6d9bb-493e-4a40-8465-5ebf9edcde44';
ccw_package_assert(CCW_Config::is_configured(), 'Extracted plugin did not accept its provisioned configuration');
ccw_package_assert(CCW_Config::is_managed_configuration(), 'Provisioned plugin was not classified as managed');
ccw_package_assert(
    !empty(CCW_Config::cache_storage_diagnostic()['safe']),
    'Provisioned Nginx plugin rejected its private cache constant'
);
ccw_package_assert(CCW_Config::installation_id() === $expectedInstallationId, 'Installation id changed in transit');
ccw_package_assert(CCW_Config::api_base() === 'https://crm.clinicaclick.com', 'API base changed in transit');
ccw_package_assert(CCW_Config::token() === 'ccw_' . str_repeat('a', 43), 'Opaque token changed in transit');
ccw_package_assert(CCW_Config::site_claim_token() === str_repeat('s', 43), 'Site claim changed in transit');

$provisioned = CCW_Config::provisioned();
ccw_package_assert(array_keys($provisioned) === array(
    'api_base',
    'bootstrap_runtime_configuration',
    'bootstrap_runtime_envelope',
    'installation_id',
    'site_claim_token',
    'token',
    'trust_descriptor',
), 'Provisioned config gained or lost a top-level field');
ccw_package_assert(
    CCW_Trust_Store::validate_descriptor($provisioned['trust_descriptor'])['key_id']
        === $provisioned['bootstrap_runtime_envelope']['key_id'],
    'Provisioned trust descriptor does not match the runtime signature'
);

$runtime = CCW_Config::runtime_configuration();
ccw_package_assert((int) ($runtime['sequence'] ?? 0) === 7, 'Plugin boot did not persist the signed runtime');
ccw_package_assert((string) ($runtime['installation_id'] ?? '') === $expectedInstallationId, 'Bootstrapped runtime scope is wrong');
ccw_package_assert((int) ($runtime['measurement']['scope_id'] ?? 0) === 66, 'Bootstrapped measurement scope is wrong');
ccw_package_assert(
    (string) ($runtime['measurement']['hmac_key'] ?? '') === '0123456789abcdef0123456789abcdef',
    'Bootstrapped measurement HMAC changed in transit'
);

CCW_Plugin::activate(false);
ccw_package_assert(get_option(CCW_Plugin::OPTION_VERSION, '') === CCW_VERSION, 'Extracted plugin activation did not complete');
ccw_package_assert(count($GLOBALS['ccw_package_rewrites']) === 5, 'Activation did not register claim, intake, event and landing routes');
ccw_package_assert(is_dir(CCW_Config::cache_root() . '/releases'), 'Activation did not initialize the local release cache');
ccw_package_assert(count($GLOBALS['ccw_package_posts']) === 1, 'Activation did not send its authenticated handshake');
$handshake = $GLOBALS['ccw_package_posts'][0];
ccw_package_assert(
    ($handshake['args']['headers']['Authorization'] ?? '') === 'Bearer ccw_' . str_repeat('a', 43),
    'Activation handshake omitted the installation bearer'
);
$handshake_payload = json_decode((string) $handshake['args']['body'], true);
ccw_package_assert(
    is_array($handshake_payload)
        && (int) ($handshake_payload['schema_version'] ?? 0) === 2
        && (string) ($handshake_payload['event'] ?? '') === 'heartbeat'
        && ($handshake_payload['capabilities']['multi_publication_v2'] ?? false) === true
        && (int) ($handshake_payload['registry_sequence'] ?? -1) === 0
        && ($handshake_payload['routes'] ?? null) === array(),
    'Activation capability heartbeat payload is missing or invalid'
);

$claim = CCW_Site_Claim::claim_document();
ccw_package_assert(is_array($claim), 'Provisioned plugin did not expose its temporary site claim');
ccw_package_assert(
    ($claim['installation_id'] ?? '') === $expectedInstallationId
        && ($claim['canonical_home_url'] ?? '') === 'https://cliente.example.test'
        && ($claim['claim_token_sha256'] ?? '') === hash('sha256', str_repeat('s', 43)),
    'Temporary site claim is not bound to installation, digest and canonical home'
);
ccw_package_assert(strpos(json_encode($claim), str_repeat('s', 43)) === false, 'Public site claim leaked its raw challenge');
foreach ($entries as $entry) {
    if ($entry === 'clinicaclick-web/config/installation.php') continue;
    $entryBody = file_get_contents($temporaryRoot . '/' . $entry);
    ccw_package_assert(
        !is_string($entryBody) || strpos($entryBody, str_repeat('s', 43)) === false,
        'Raw site claim leaked outside the provisioned config'
    );
}
$GLOBALS['ccw_package_response_body'] = json_encode(array('site_claim_acknowledged' => true));
ccw_package_assert((new CCW_HTTP())->report(array(
    'schema_version' => 2,
    'event' => 'heartbeat',
)) === true, 'Backend claim ACK report failed');
ccw_package_assert(CCW_Site_Claim::claim_document() === null, 'Site claim remained public after backend ACK');

echo "ok - Node provisioned ZIP boots and activates with the packaged PHP plugin\n";
