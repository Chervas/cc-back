<?php
/**
 * Plugin Name: ClinicaClick Web Publisher
 * Plugin URI: https://clinicaclick.com/
 * Description: Medición de ClinicaClick y publicación segura de landings cacheadas.
 * Version: 2.0.0-alpha.4
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * Author: ClinicaClick
 * License: Proprietary
 * Text Domain: clinicaclick-web
 */

if (!defined('ABSPATH')) {
    exit;
}

define('CCW_VERSION', '2.0.0-alpha.4');
define('CCW_PLUGIN_FILE', __FILE__);
define('CCW_PLUGIN_DIR', plugin_dir_path(__FILE__));

require_once CCW_PLUGIN_DIR . 'includes/class-ccw-error.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-json.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-config.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-trust-store.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-manifest.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-cache.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-http.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-sync.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-intake-bridge.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-router.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-admin.php';
require_once CCW_PLUGIN_DIR . 'includes/class-ccw-plugin.php';

CCW_Plugin::boot();

register_activation_hook(__FILE__, array('CCW_Plugin', 'activate'));
register_deactivation_hook(__FILE__, array('CCW_Plugin', 'deactivate'));
