<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Plugin
{
    const CRON_HOOK = 'ccw_sync_event';
    const OPTION_VERSION = 'ccw_plugin_version';

    public static function boot()
    {
        self::bootstrap_provisioned_runtime();
        (new CCW_Site_Claim())->register();
        (new CCW_Intake_Bridge())->register();
        (new CCW_Router())->register();
        if (is_admin()) {
            (new CCW_Admin())->register();
        }
        add_filter('cron_schedules', array(__CLASS__, 'cron_schedules'));
        add_action(self::CRON_HOOK, array(__CLASS__, 'cron_sync'));
        add_filter('site_status_tests', array(__CLASS__, 'site_health_tests'));
        add_action('admin_init', array(__CLASS__, 'maybe_upgrade'));
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            wp_schedule_event(time() + 60, 'ccw_fifteen_minutes', self::CRON_HOOK);
        }
    }

    public static function activate($network_wide = false)
    {
        if (version_compare(PHP_VERSION, '7.4', '<') || !function_exists('sodium_crypto_sign_verify_detached')) {
            deactivate_plugins(plugin_basename(CCW_PLUGIN_FILE));
            wp_die('ClinicaClick Web necesita PHP 7.4 o superior y la extensión Sodium.');
        }
        if ($network_wide && is_multisite()) {
            deactivate_plugins(plugin_basename(CCW_PLUGIN_FILE), true, true);
            wp_die('La activación de red todavía no está soportada. Activa ClinicaClick por sitio.');
        }
        // The public proof must resolve before the first authenticated report:
        // the backend performs a real same-origin GET and will not promote a
        // bearer-only pending installation. Flush all plugin routes first so
        // activation can complete the claim immediately instead of waiting
        // for cron.
        (new CCW_Intake_Bridge())->rewrite_rules();
        (new CCW_Router())->rewrite_rules();
        (new CCW_Site_Claim())->rewrite_rules();
        flush_rewrite_rules(false);
        if (CCW_Config::is_configured()) {
            try {
                CCW_Config::assert_cache_storage_safe();
                $cache = new CCW_Cache();
                $cache->initialize();
                // The first authenticated heartbeat completes the pending
                // installation handshake even before a landing exists. Network
                // failure never makes WordPress activation destructive; cron will
                // retry through the same authenticated control plane.
                self::report_capabilities($cache);
            } catch (CCW_Error $error) {
                if ($error->error_code() === 'ccw_managed_cache_directory_public') {
                    deactivate_plugins(plugin_basename(CCW_PLUGIN_FILE));
                    wp_die($error->getMessage());
                }
                throw $error;
            }
        }
        if (!wp_next_scheduled(self::CRON_HOOK)) {
            wp_schedule_event(time() + 60, 'ccw_fifteen_minutes', self::CRON_HOOK);
        }
        update_option(self::OPTION_VERSION, CCW_VERSION, false);
    }

    public static function deactivate()
    {
        $timestamp = wp_next_scheduled(self::CRON_HOOK);
        while ($timestamp) {
            wp_unschedule_event($timestamp, self::CRON_HOOK);
            $timestamp = wp_next_scheduled(self::CRON_HOOK);
        }
        flush_rewrite_rules(false);
    }

    public static function cron_schedules($schedules)
    {
        $schedules['ccw_fifteen_minutes'] = array(
            'interval' => 15 * MINUTE_IN_SECONDS,
            'display' => 'Cada 15 minutos (ClinicaClick Web)',
        );
        return $schedules;
    }

    public static function cron_sync()
    {
        if (!CCW_Config::is_configured()) {
            return;
        }
        try {
            (new CCW_Sync())->run(false);
        } catch (Throwable $error) {
            // Failure is persisted and reported with a stable error code by
            // CCW_Sync. Tokens and response bodies are deliberately not logged.
        }
    }

    public static function maybe_upgrade()
    {
        if ((string) get_option(self::OPTION_VERSION, '') === CCW_VERSION) {
            return;
        }
        (new CCW_Intake_Bridge())->rewrite_rules();
        (new CCW_Router())->rewrite_rules();
        (new CCW_Site_Claim())->rewrite_rules();
        flush_rewrite_rules(false);
        if (CCW_Config::is_configured()) self::report_capabilities(new CCW_Cache());
        update_option(self::OPTION_VERSION, CCW_VERSION, false);
    }

    public static function report_capabilities(CCW_Cache $cache = null)
    {
        if (!CCW_Config::is_configured()) return false;
        $cache = $cache ?: new CCW_Cache();
        $lock = null;
        try {
            try {
                $registry = $cache->route_registry();
            } catch (CCW_Error $error) {
                if ($error->error_code() !== 'ccw_route_registry_invalid') {
                    return false;
                }
                // An upgrade/activation must never break wp-admin because a
                // local control file is corrupt. Reset it under the same lock
                // used by sync; the next signed 200 rebuilds the registry.
                $lock = $cache->acquire_lock();
                $cache->reset_route_registry();
                $registry = $cache->route_registry();
                $cache->release_lock($lock);
                $lock = null;
            }
            return (new CCW_HTTP())->report(array(
                'schema_version' => 2,
                'event' => 'heartbeat',
                'plugin_version' => CCW_VERSION,
                'wordpress_version' => get_bloginfo('version'),
                'php_version' => PHP_VERSION,
                'site_hash' => hash('sha256', home_url('/')),
                'capabilities' => array('multi_publication_v2' => true),
                'registry_sequence' => (int) ($registry['sequence'] ?? 0),
                'routes' => $cache->route_report(),
                'duration_ms' => 0,
                'reported_at' => gmdate('c'),
            ));
        } catch (Throwable $error) {
            // Capability reporting is retried by cron/sync and must not make
            // plugin activation or admin_init fatal.
            return false;
        } finally {
            if ($lock !== null) {
                $cache->release_lock($lock);
            }
        }
    }

    private static function bootstrap_provisioned_runtime()
    {
        $provisioned = CCW_Config::provisioned();
        if (
            !is_array($provisioned['trust_descriptor'] ?? null)
            || !is_array($provisioned['bootstrap_runtime_configuration'] ?? null)
            || !is_array($provisioned['bootstrap_runtime_envelope'] ?? null)
        ) {
            return;
        }
        try {
            CCW_Config::assert_cache_storage_safe();
            $trusted_descriptor = CCW_Trust_Store::validate_descriptor($provisioned['trust_descriptor']);
            $runtime = CCW_Manifest::verify_runtime_configuration(
                $provisioned['bootstrap_runtime_configuration'],
                $provisioned['bootstrap_runtime_envelope'],
                CCW_Config::installation_id(),
                $trusted_descriptor['key_id']
            );
            $current = CCW_Config::runtime_configuration();
            if ((int) ($runtime['sequence'] ?? 0) > (int) ($current['sequence'] ?? 0)) {
                CCW_Config::set_runtime_configuration($runtime);
            }
        } catch (CCW_Error $error) {
            // Provisioning fails closed and can be repaired from the admin UI.
        }
    }

    public static function site_health_tests($tests)
    {
        $tests['direct']['clinicaclick_web'] = array(
            'label' => 'ClinicaClick Web',
            'test' => array(__CLASS__, 'site_health'),
        );
        return $tests;
    }

    public static function site_health()
    {
        $configured = CCW_Config::is_configured();
        $storage = CCW_Config::cache_storage_diagnostic();
        if (empty($storage['safe'])) {
            return array(
                'label' => 'ClinicaClick Web está bloqueado por seguridad',
                'status' => 'critical',
                'badge' => array('label' => 'ClinicaClick', 'color' => 'red'),
                'description' => '<p>' . esc_html((string) $storage['message']) . '</p>',
                'actions' => '<p><a href="' . esc_url(admin_url('options-general.php?page=clinicaclick-web')) . '">Corregir almacenamiento de ClinicaClick Web</a></p>',
                'test' => 'clinicaclick_web',
            );
        }
        $cache = $configured ? new CCW_Cache() : null;
        $pointer = $cache ? $cache->pointer() : array();
        $active_routes = 0;
        $attention_routes = 0;
        $registry_mode = false;
        if ($cache) {
            try {
                $registry = $cache->route_registry();
                if ((int) ($registry['sequence'] ?? 0) > 0) {
                    $registry_mode = true;
                    foreach ($registry['routes'] as $publication_id => $entry) {
                        $route = $cache->route_pointer($publication_id, (string) ($entry['route_prefix'] ?? ''));
                        if (($route['status'] ?? '') === 'active' && preg_match('/^[a-f0-9]{64}$/', (string) ($route['active_hash'] ?? ''))) {
                            $active_routes++;
                        } elseif (($route['status'] ?? '') !== 'retired') {
                            $attention_routes++;
                        }
                    }
                }
            } catch (CCW_Error $error) {
                $registry_mode = true;
                $attention_routes++;
            }
        }
        $multi = $registry_mode;
        $healthy = $configured && ($multi
            ? $active_routes > 0 && $attention_routes === 0
            : ($pointer['status'] ?? '') === 'active');
        $healthy_label = $multi
            ? sprintf('%d publicación(es) local(es) válida(s)', $active_routes)
            : 'ClinicaClick sirve una publicación local válida';
        $configured_description = $multi
            ? sprintf(
                'La caché local conserva %d ruta(s) activa(s); %d ruta(s) requieren revisión.',
                $active_routes,
                $attention_routes
            )
            : 'La última publicación válida se sirve desde la caché local, incluso si la API no responde.';
        return array(
            'label' => $healthy ? $healthy_label : 'ClinicaClick Web requiere atención',
            'status' => $healthy ? 'good' : 'recommended',
            'badge' => array('label' => 'ClinicaClick', 'color' => 'blue'),
            'description' => '<p>' . esc_html($configured
                ? $configured_description
                : 'Configura el identificador, la API, el token y el descriptor público para activar la sincronización.') . '</p>',
            'actions' => '<p><a href="' . esc_url(admin_url('options-general.php?page=clinicaclick-web')) . '">Abrir ClinicaClick Web</a></p>',
            'test' => 'clinicaclick_web',
        );
    }
}
