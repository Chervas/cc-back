<?php

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

// Content, trusted keys and last-known-good are intentionally retained by
// default. Destructive cleanup requires an explicit server constant or option.
$purge = (defined('CLINICACLICK_WEB_PURGE_ON_UNINSTALL') && CLINICACLICK_WEB_PURGE_ON_UNINSTALL === true)
    || get_option('ccw_purge_on_uninstall', false) === true;

if (!$purge) {
    return;
}

$installation_id = (string) get_option('ccw_installation_id', '');
$root_base = defined('CLINICACLICK_WEB_CACHE_DIR')
    ? (string) CLINICACLICK_WEB_CACHE_DIR
    : rtrim((string) WP_CONTENT_DIR, '/\\') . '/clinicaclick-web-cache';
$site_key = hash('sha256', strtolower($installation_id) . '|' . home_url('/'));
$root = rtrim($root_base, '/\\') . '/' . $site_key;

$delete_tree = static function ($path) use (&$delete_tree) {
    if (!is_dir($path) || is_link($path)) {
        if (is_file($path)) {
            @unlink($path);
        }
        return;
    }
    $items = scandir($path);
    if (!is_array($items)) {
        return;
    }
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $child = $path . '/' . $item;
        if (is_dir($child) && !is_link($child)) {
            $delete_tree($child);
        } else {
            @unlink($child);
        }
    }
    @rmdir($path);
};

if ($installation_id !== '' && is_dir($root) && !is_link($root)) {
    $delete_tree($root);
}

foreach (array(
    'ccw_installation_id',
    'ccw_api_base',
    'ccw_installation_token',
    'ccw_trusted_signing_keys',
    'ccw_signing_trust_state',
    'ccw_runtime_configuration',
    'ccw_sync_state',
    'ccw_purge_on_uninstall',
    'ccw_site_claim_ack',
    'ccw_plugin_version',
) as $option) {
    delete_option($option);
}
