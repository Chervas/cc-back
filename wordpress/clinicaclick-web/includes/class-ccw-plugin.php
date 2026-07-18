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
        if (CCW_Config::is_configured()) {
            (new CCW_Cache())->initialize();
            // The first authenticated heartbeat completes the pending
            // installation handshake even before a landing exists. Network
            // failure never makes WordPress activation destructive; cron will
            // retry through the same authenticated control plane.
            (new CCW_HTTP())->report(array(
                'schema_version' => 1,
                'event' => 'heartbeat',
                'plugin_version' => CCW_VERSION,
                'wordpress_version' => get_bloginfo('version'),
                'php_version' => PHP_VERSION,
                'site_hash' => hash('sha256', home_url('/')),
                'status' => 'empty',
                'result' => 'activation_handshake',
                'duration_ms' => 0,
                'reported_at' => gmdate('c'),
            ));
        }
        (new CCW_Intake_Bridge())->rewrite_rules();
        (new CCW_Router())->rewrite_rules();
        flush_rewrite_rules(false);
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
        flush_rewrite_rules(false);
        update_option(self::OPTION_VERSION, CCW_VERSION, false);
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
            CCW_Trust_Store::validate_descriptor($provisioned['trust_descriptor']);
            $runtime = CCW_Manifest::verify_runtime_configuration(
                $provisioned['bootstrap_runtime_configuration'],
                $provisioned['bootstrap_runtime_envelope'],
                CCW_Config::installation_id()
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
        $pointer = $configured ? (new CCW_Cache())->pointer() : array();
        $healthy = $configured && ($pointer['status'] ?? '') === 'active';
        return array(
            'label' => $healthy ? 'ClinicaClick sirve una publicación local válida' : 'ClinicaClick Web requiere atención',
            'status' => $healthy ? 'good' : 'recommended',
            'badge' => array('label' => 'ClinicaClick', 'color' => 'blue'),
            'description' => '<p>' . esc_html($configured
                ? 'La última publicación válida se sirve desde la caché local, incluso si la API no responde.'
                : 'Configura el identificador, la API, el token y el descriptor público para activar la sincronización.') . '</p>',
            'actions' => '<p><a href="' . esc_url(admin_url('options-general.php?page=clinicaclick-web')) . '">Abrir ClinicaClick Web</a></p>',
            'test' => 'clinicaclick_web',
        );
    }
}
