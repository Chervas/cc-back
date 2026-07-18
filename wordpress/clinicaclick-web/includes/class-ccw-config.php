<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Config
{
    /** @var array<string,mixed>|null */
    private static $provisioned = null;

    const OPTION_INSTALLATION_ID = 'ccw_installation_id';
    const OPTION_API_BASE = 'ccw_api_base';
    const OPTION_TOKEN = 'ccw_installation_token';
    const OPTION_TRUSTED_KEYS = 'ccw_trusted_signing_keys';
    const OPTION_RUNTIME = 'ccw_runtime_configuration';
    const OPTION_SYNC = 'ccw_sync_state';
    const OPTION_PURGE = 'ccw_purge_on_uninstall';

    public static function installation_id()
    {
        $value = defined('CLINICACLICK_WEB_INSTALLATION_ID')
            ? constant('CLINICACLICK_WEB_INSTALLATION_ID')
            : (self::provisioned()['installation_id'] ?? get_option(self::OPTION_INSTALLATION_ID, ''));
        return self::validate_installation_id($value);
    }

    public static function api_base()
    {
        $value = defined('CLINICACLICK_WEB_API_BASE')
            ? constant('CLINICACLICK_WEB_API_BASE')
            : (self::provisioned()['api_base'] ?? get_option(self::OPTION_API_BASE, ''));
        return self::validate_api_base($value);
    }

    public static function token()
    {
        $value = defined('CLINICACLICK_WEB_TOKEN')
            ? constant('CLINICACLICK_WEB_TOKEN')
            : (self::provisioned()['token'] ?? get_option(self::OPTION_TOKEN, ''));
        return self::validate_token($value);
    }

    public static function is_configured()
    {
        try {
            return self::installation_id() !== '' && self::api_base() !== '' && self::token() !== '';
        } catch (CCW_Error $error) {
            return false;
        }
    }

    public static function validate_installation_id($value)
    {
        $value = trim((string) $value);
        if ($value === '') {
            return '';
        }
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value)) {
            throw new CCW_Error('ccw_installation_id_invalid', 'El identificador de instalación no es válido.');
        }
        return strtolower($value);
    }

    public static function validate_api_base($value)
    {
        $value = rtrim(trim((string) $value), '/');
        if ($value === '') {
            return '';
        }
        $parts = parse_url($value);
        if (
            !is_array($parts)
            || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
            || empty($parts['host'])
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['query'])
            || isset($parts['fragment'])
        ) {
            throw new CCW_Error('ccw_api_base_invalid', 'La API de ClinicaClick debe ser una URL HTTPS sin credenciales ni parámetros.');
        }
        $path = isset($parts['path']) ? rtrim((string) $parts['path'], '/') : '';
        if ($path !== '' && !preg_match('#^/[A-Za-z0-9/_-]*$#', $path)) {
            throw new CCW_Error('ccw_api_base_invalid', 'La ruta base de la API no es válida.');
        }
        return $value;
    }

    public static function validate_token($value)
    {
        $value = trim((string) $value);
        if ($value === '') {
            return '';
        }
        $length = strlen($value);
        if ($length < 32 || $length > 512 || preg_match('/[\x00-\x20\x7f]/', $value)) {
            throw new CCW_Error('ccw_token_invalid', 'El token de instalación no tiene un formato válido.');
        }
        return $value;
    }

    /** @return array<string,mixed> */
    public static function runtime_configuration()
    {
        $value = get_option(self::OPTION_RUNTIME, array());
        return is_array($value) ? $value : array();
    }

    /** @param array<string,mixed> $value */
    public static function set_runtime_configuration(array $value)
    {
        update_option(self::OPTION_RUNTIME, $value, false);
    }

    /** @return array<string,mixed> */
    public static function sync_state()
    {
        $value = get_option(self::OPTION_SYNC, array());
        return is_array($value) ? $value : array();
    }

    /** @param array<string,mixed> $value */
    public static function set_sync_state(array $value)
    {
        update_option(self::OPTION_SYNC, $value, false);
    }

    /**
     * Saves only values supplied by an administrator. An empty token means
     * "keep the current token", so the secret is never rendered back into the
     * form.
     *
     * @param array<string,mixed> $input
     */
    public static function save_admin_configuration(array $input)
    {
        if (defined('CLINICACLICK_WEB_INSTALLATION_ID') || defined('CLINICACLICK_WEB_API_BASE') || self::provisioned() !== array()) {
            throw new CCW_Error('ccw_config_managed_by_constants', 'La configuración está gestionada por constantes del servidor.');
        }
        $installation_id = self::validate_installation_id($input['installation_id'] ?? '');
        $api_base = self::validate_api_base($input['api_base'] ?? '');
        $token = trim((string) ($input['token'] ?? ''));
        if ($installation_id === '' || $api_base === '') {
            throw new CCW_Error('ccw_configuration_incomplete', 'Indica la API y el identificador de instalación.');
        }
        $existing_token = (string) get_option(self::OPTION_TOKEN, '');
        if ($token === '' && $existing_token === '') {
            throw new CCW_Error('ccw_configuration_incomplete', 'Indica el token opaco de instalación.');
        }
        update_option(self::OPTION_INSTALLATION_ID, $installation_id, false);
        update_option(self::OPTION_API_BASE, $api_base, false);
        if ($token !== '') {
            update_option(self::OPTION_TOKEN, self::validate_token($token), false);
        }
    }

    public static function has_token()
    {
        try {
            return self::token() !== '';
        } catch (CCW_Error $error) {
            return false;
        }
    }

    public static function cache_root()
    {
        if (defined('CLINICACLICK_WEB_CACHE_DIR')) {
            $root = (string) constant('CLINICACLICK_WEB_CACHE_DIR');
        } else {
            $root = rtrim((string) WP_CONTENT_DIR, '/\\') . '/clinicaclick-web-cache';
        }
        $site_key = hash('sha256', self::installation_id() . '|' . home_url('/'));
        return rtrim($root, '/\\') . '/' . $site_key;
    }

    /**
     * Reads provisioned JSON without executing the PHP-shielded file.
     *
     * @return array<string,mixed>
     */
    public static function provisioned()
    {
        if (self::$provisioned !== null) {
            return self::$provisioned;
        }
        self::$provisioned = array();
        if (!defined('CCW_PLUGIN_DIR')) {
            return self::$provisioned;
        }
        $path = CCW_PLUGIN_DIR . 'config/installation.php';
        if (!is_file($path) || is_link($path) || filesize($path) > 65536) {
            return self::$provisioned;
        }
        $source = (string) file_get_contents($path);
        $marker = '__halt_compiler(); ?>';
        $offset = strpos($source, $marker);
        if ($offset === false) {
            return self::$provisioned;
        }
        $decoded = json_decode(trim(substr($source, $offset + strlen($marker))), true);
        if (is_array($decoded)) {
            self::$provisioned = $decoded;
        }
        return self::$provisioned;
    }
}
