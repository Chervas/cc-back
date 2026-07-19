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
    const OPTION_SIGNING_TRUST_STATE = 'ccw_signing_trust_state';
    const OPTION_RUNTIME = 'ccw_runtime_configuration';
    const OPTION_SYNC = 'ccw_sync_state';
    const OPTION_PURGE = 'ccw_purge_on_uninstall';
    const OPTION_SITE_CLAIM_ACK = 'ccw_site_claim_ack';

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

    public static function site_claim_token()
    {
        $value = defined('CLINICACLICK_WEB_SITE_CLAIM_TOKEN')
            ? constant('CLINICACLICK_WEB_SITE_CLAIM_TOKEN')
            : (self::provisioned()['site_claim_token'] ?? '');
        $value = trim((string) $value);
        if ($value === '') {
            return '';
        }
        if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $value)) {
            throw new CCW_Error('ccw_site_claim_token_invalid', 'La prueba de control del sitio no es válida.');
        }
        $decoded = base64_decode(strtr($value, '-_', '+/') . '=', true);
        if (!is_string($decoded) || strlen($decoded) !== 32) {
            throw new CCW_Error('ccw_site_claim_token_invalid', 'La prueba de control del sitio no es válida.');
        }
        return $value;
    }

    public static function site_claim_digest()
    {
        $token = self::site_claim_token();
        return $token === '' ? '' : hash('sha256', $token);
    }

    public static function site_claim_is_pending()
    {
        try {
            $installation_id = self::installation_id();
            $digest = self::site_claim_digest();
        } catch (CCW_Error $error) {
            return false;
        }
        if ($installation_id === '' || $digest === '') {
            return false;
        }
        $ack = get_option(self::OPTION_SITE_CLAIM_ACK, array());
        return !is_array($ack)
            || !isset($ack['installation_id'], $ack['claim_token_sha256'])
            || !hash_equals($installation_id, (string) $ack['installation_id'])
            || !hash_equals($digest, (string) $ack['claim_token_sha256']);
    }

    public static function acknowledge_site_claim()
    {
        if (!self::site_claim_is_pending()) {
            return false;
        }
        update_option(self::OPTION_SITE_CLAIM_ACK, array(
            'installation_id' => self::installation_id(),
            'claim_token_sha256' => self::site_claim_digest(),
            'acknowledged_at' => gmdate('c'),
        ), false);
        return true;
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
        $stored = get_option(self::OPTION_RUNTIME, array());
        if (!is_array($stored) || $stored === array()) {
            return array();
        }
        try {
            $installation_id = self::installation_id();
            $api_base_hash = hash('sha256', self::api_base());
        } catch (CCW_Error $error) {
            return array();
        }
        $is_wrapped = isset($stored['installation_id'], $stored['api_base_hash'], $stored['value']);
        if (!$is_wrapped) {
            // alpha.7 stored the already signature-verified runtime directly.
            // Adopt it once only when both tenant and exact control-plane API
            // still match; otherwise fail closed and wait for desired-state.
            if (
                array_key_exists('api_base_hash', $stored)
                || array_key_exists('value', $stored)
                || !isset($stored['installation_id'], $stored['measurement'])
                || !is_array($stored['measurement'])
                || !hash_equals($installation_id, (string) $stored['installation_id'])
            ) {
                return array();
            }
            try {
                $runtime_api_base = self::validate_api_base($stored['measurement']['api_url'] ?? '');
            } catch (CCW_Error $error) {
                return array();
            }
            if ($runtime_api_base === '' || !hash_equals(self::api_base(), $runtime_api_base)) {
                return array();
            }
            update_option(self::OPTION_RUNTIME, array(
                'installation_id' => $installation_id,
                'api_base_hash' => $api_base_hash,
                'value' => $stored,
            ), false);
            return $stored;
        }
        if (
            $installation_id === ''
            || !isset($stored['installation_id'], $stored['api_base_hash'], $stored['value'])
            || !is_array($stored['value'])
            || !hash_equals($installation_id, (string) $stored['installation_id'])
            || !hash_equals($api_base_hash, (string) $stored['api_base_hash'])
            || !hash_equals($installation_id, (string) ($stored['value']['installation_id'] ?? ''))
        ) {
            return array();
        }
        return $stored['value'];
    }

    /** @param array<string,mixed> $value */
    public static function set_runtime_configuration(array $value)
    {
        if (!hash_equals(self::installation_id(), (string) ($value['installation_id'] ?? ''))) {
            throw new CCW_Error('ccw_runtime_installation_mismatch', 'La configuración firmada pertenece a otra instalación.');
        }
        update_option(self::OPTION_RUNTIME, array(
            'installation_id' => self::installation_id(),
            'api_base_hash' => hash('sha256', self::api_base()),
            'value' => $value,
        ), false);
    }

    /** @return array<string,mixed> */
    public static function sync_state()
    {
        $value = get_option(self::OPTION_SYNC, array());
        if (!is_array($value) || $value === array()) {
            return array();
        }
        try {
            $installation_id = self::installation_id();
            $api_base_hash = hash('sha256', self::api_base());
        } catch (CCW_Error $error) {
            return array();
        }
        if (
            !isset($value['installation_id'], $value['api_base_hash'])
            || !hash_equals($installation_id, (string) $value['installation_id'])
        ) {
            return array();
        }
        if (
            !hash_equals($api_base_hash, (string) $value['api_base_hash'])
        ) {
            return array();
        }
        return $value;
    }

    /** @param array<string,mixed> $value */
    public static function set_sync_state(array $value)
    {
        $value['installation_id'] = self::installation_id();
        $value['api_base_hash'] = hash('sha256', self::api_base());
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
        $previous_installation_id = (string) get_option(self::OPTION_INSTALLATION_ID, '');
        $previous_api_base = rtrim(trim((string) get_option(self::OPTION_API_BASE, '')), '/');
        $installation_changed = $previous_installation_id !== ''
            && !hash_equals(strtolower($previous_installation_id), $installation_id);
        $api_base_changed = $previous_api_base !== '' && !hash_equals($previous_api_base, $api_base);
        if ($installation_changed || $api_base_changed) {
            // Cache files are already isolated by installation_id. The option
            // backed control-plane state must be isolated too, otherwise an
            // old v2 handshake/ETag can suppress bootstrap for the new tenant.
            delete_option(self::OPTION_SYNC);
            delete_option(self::OPTION_RUNTIME);
            delete_option(self::OPTION_SIGNING_TRUST_STATE);
            delete_option(self::OPTION_SITE_CLAIM_ACK);
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

    public static function is_managed_configuration()
    {
        return defined('CLINICACLICK_WEB_INSTALLATION_ID')
            || defined('CLINICACLICK_WEB_API_BASE')
            || self::provisioned() !== array();
    }

    /**
     * Managed installations refuse any cache confirmed to live below the
     * public document root. This is independent of the current
     * request SAPI/server: WP-CLI must not write secrets that a later Nginx
     * request could expose, and .htaccess is not a portable security boundary.
     * The explicit context exists only so this can be tested without mutating
     * process-wide WordPress constants.
     *
     * @param array<string,mixed> $context
     * @return array<string,mixed>
     */
    public static function cache_storage_diagnostic($cache_root = null, array $context = array())
    {
        $managed = array_key_exists('managed', $context)
            ? (bool) $context['managed']
            : self::is_managed_configuration();
        $server_software = array_key_exists('server_software', $context)
            ? (string) $context['server_software']
            : (string) ($_SERVER['SERVER_SOFTWARE'] ?? '');
        $is_nginx = stripos($server_software, 'nginx') !== false;
        $uses_default = array_key_exists('uses_default', $context)
            ? (bool) $context['uses_default']
            : !defined('CLINICACLICK_WEB_CACHE_DIR');
        if ($cache_root === null) {
            $cache_root = defined('CLINICACLICK_WEB_CACHE_DIR')
                ? (string) constant('CLINICACLICK_WEB_CACHE_DIR')
                : rtrim((string) WP_CONTENT_DIR, '/\\') . '/clinicaclick-web-cache';
        }
        $root = self::canonical_filesystem_path((string) $cache_root);

        $document_roots = array();
        if (isset($context['document_roots']) && is_array($context['document_roots'])) {
            $document_roots = $context['document_roots'];
        } elseif (array_key_exists('document_root', $context)) {
            $document_roots = array($context['document_root']);
        } else {
            if (!empty($_SERVER['DOCUMENT_ROOT'])) {
                $document_roots[] = (string) $_SERVER['DOCUMENT_ROOT'];
            }
            if (defined('ABSPATH')) {
                $document_roots[] = (string) ABSPATH;
            }
        }
        $inside_document_root = false;
        foreach ($document_roots as $document_root) {
            $public_root = self::canonical_filesystem_path((string) $document_root);
            if ($root !== '' && $public_root !== '' && self::path_is_within($root, $public_root)) {
                $inside_document_root = true;
                break;
            }
        }
        // Definir la constante no convierte una ruta pública en privada. Todo
        // runtime gestionado debe quedar físicamente fuera del árbol servido.
        $safe = !($managed && $inside_document_root);
        return array(
            'safe' => $safe,
            'code' => $safe ? 'ok' : 'ccw_managed_cache_directory_public',
            'managed' => $managed,
            'nginx' => $is_nginx,
            'uses_default' => $uses_default,
            'inside_document_root' => $inside_document_root,
            'message' => $safe
                ? 'La caché local está protegida por la configuración del servidor.'
                : 'ClinicaClick Web está bloqueado: la caché de esta instalación gestionada está dentro del document root. Define CLINICACLICK_WEB_CACHE_DIR fuera del árbol público y vuelve a sincronizar.',
        );
    }

    /** @param array<string,mixed> $context */
    public static function assert_cache_storage_safe($cache_root = null, array $context = array())
    {
        $diagnostic = self::cache_storage_diagnostic($cache_root, $context);
        if (empty($diagnostic['safe'])) {
            throw new CCW_Error(
                (string) $diagnostic['code'],
                (string) $diagnostic['message'],
                array(
                    'managed' => (bool) $diagnostic['managed'],
                    'nginx' => (bool) $diagnostic['nginx'],
                    'uses_default' => (bool) $diagnostic['uses_default'],
                    'inside_document_root' => (bool) $diagnostic['inside_document_root'],
                )
            );
        }
        return true;
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

    private static function canonical_filesystem_path($value)
    {
        $path = str_replace('\\', '/', trim((string) $value));
        if ($path === '') {
            return '';
        }
        $probe = rtrim($path, '/');
        $suffix = array();
        while ($probe !== '' && !file_exists($probe)) {
            $parent = dirname($probe);
            if ($parent === $probe) {
                break;
            }
            array_unshift($suffix, basename($probe));
            $probe = $parent;
        }
        $real = realpath($probe);
        if ($real !== false) {
            $path = rtrim(str_replace('\\', '/', $real), '/');
            if ($suffix !== array()) {
                $path .= '/' . implode('/', $suffix);
            }
        }
        $path = preg_replace('#/+#', '/', $path);
        return rtrim((string) $path, '/');
    }

    private static function path_is_within($path, $parent)
    {
        $path = rtrim((string) $path, '/');
        $parent = rtrim((string) $parent, '/');
        if ($path === '' || $parent === '') {
            return false;
        }
        return $path === $parent || strpos($path, $parent . '/') === 0;
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
