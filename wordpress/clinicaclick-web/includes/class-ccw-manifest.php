<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Manifest
{
    const MAX_FILES = 512;
    const MAX_FILE_BYTES = 10485760;
    const MAX_TOTAL_BYTES = 52428800;

    /** @var array<string,array<int,string>> */
    private static $content_types = array(
        'html' => array('text/html', 'text/html; charset=utf-8'),
        'css' => array('text/css', 'text/css; charset=utf-8'),
        'txt' => array('text/plain', 'text/plain; charset=utf-8'),
        'xml' => array('application/xml', 'application/xml; charset=utf-8', 'text/xml'),
        'webp' => array('image/webp'),
        'avif' => array('image/avif'),
        'png' => array('image/png'),
        'jpg' => array('image/jpeg'),
        'jpeg' => array('image/jpeg'),
        'woff' => array('font/woff'),
        'woff2' => array('font/woff2'),
    );

    /** @return array<string,mixed> */
    public static function verify(array $manifest, array $envelope, $expected_hash, array $runtime_configuration = array())
    {
        if (!CCW_Trust_Store::verify_signed_payload($manifest, $envelope)) {
            throw new CCW_Error('ccw_manifest_signature_invalid', 'La firma del artefacto no es válida.');
        }
        return self::validate($manifest, $expected_hash, $runtime_configuration);
    }

    /** @return array<string,mixed> */
    public static function validate(array $manifest, $expected_hash, array $runtime_configuration = array())
    {
        $artifact_hash = (string) ($manifest['artifact_hash'] ?? '');
        if (
            (int) ($manifest['schema_version'] ?? 0) !== 1
            || (string) ($manifest['environment'] ?? '') !== 'production'
            || !preg_match('/^[a-f0-9]{64}$/', $artifact_hash)
            || !hash_equals((string) $expected_hash, $artifact_hash)
        ) {
            throw new CCW_Error('ccw_manifest_contract_invalid', 'El manifest no corresponde a un artefacto de producción compatible.');
        }
        if (empty($manifest['renderer_version']) || strlen((string) $manifest['renderer_version']) > 100) {
            throw new CCW_Error('ccw_renderer_version_invalid', 'La versión del renderer no es válida.');
        }

        $files = $manifest['files'] ?? null;
        if (!is_array($files) || $files === array() || count($files) > self::MAX_FILES || !isset($files['index.html'])) {
            throw new CCW_Error('ccw_manifest_files_invalid', 'El manifest no contiene un conjunto de ficheros válido.');
        }
        $normalized_files = array();
        $total = 0;
        foreach ($files as $path => $metadata) {
            $path = self::safe_path($path);
            if (!is_array($metadata)) {
                throw new CCW_Error('ccw_manifest_file_invalid', 'Los metadatos de un fichero no son válidos.', array('path' => $path));
            }
            $size = (int) ($metadata['size_bytes'] ?? -1);
            $hash = (string) ($metadata['sha256'] ?? '');
            $content_type = strtolower(trim((string) ($metadata['content_type'] ?? '')));
            if ($size < 0 || $size > self::MAX_FILE_BYTES || !preg_match('/^[a-f0-9]{64}$/', $hash)) {
                throw new CCW_Error('ccw_manifest_file_integrity_invalid', 'Hash o tamaño de fichero no válido.', array('path' => $path));
            }
            self::assert_content_type($path, $content_type);
            $total += $size;
            if ($total > self::MAX_TOTAL_BYTES) {
                throw new CCW_Error('ccw_manifest_too_large', 'El artefacto supera el tamaño máximo permitido.');
            }
            $normalized_files[$path] = array(
                'sha256' => $hash,
                'size_bytes' => $size,
                'content_type' => $content_type,
            );
        }
        $manifest['files'] = $normalized_files;
        $manifest['page_routes'] = self::safe_page_routes($manifest, $normalized_files);
        $manifest['intake_forms'] = self::safe_intake_forms($manifest, $normalized_files);
        self::assert_runtime_binding($manifest, $runtime_configuration);
        $manifest['headers'] = self::safe_headers($manifest['headers'] ?? array(), $runtime_configuration);
        return $manifest;
    }

    /**
     * Every published HTML document has one immutable page identity/path.
     * The intake bridge uses this signed allowlist for the original landing
     * path; accepting an arbitrary browser path would let a request forge
     * cross-page attribution inside the same WordPress origin.
     *
     * @param array<string,mixed> $manifest
     * @param array<string,array<string,mixed>> $files
     * @return array<string,array<string,string>>
     */
    private static function safe_page_routes(array $manifest, array $files)
    {
        $routes = $manifest['page_routes'] ?? null;
        if (!is_array($routes) || $routes === array() || count($routes) > 100) {
            throw new CCW_Error('ccw_manifest_page_routes_invalid', 'El contrato firmado de páginas no es válido.');
        }
        $uuid = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';
        $normalized = array();
        $html_paths = array();
        foreach ($routes as $page_id => $metadata) {
            $page_id = strtolower((string) $page_id);
            if (!preg_match($uuid, $page_id) || !is_array($metadata)) {
                throw new CCW_Error('ccw_manifest_page_route_invalid', 'El artefacto contiene una página no válida.');
            }
            $keys = array_keys($metadata);
            sort($keys, SORT_STRING);
            if ($keys !== array('page_path')) {
                throw new CCW_Error('ccw_manifest_page_route_invalid', 'El contrato de una página contiene campos no permitidos.');
            }
            $page_path = (string) $metadata['page_path'];
            if ($page_path !== '/' && !preg_match('#^/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/$#', $page_path)) {
                throw new CCW_Error('ccw_manifest_page_path_invalid', 'La ruta firmada de una página no es válida.');
            }
            $html_path = $page_path === '/' ? 'index.html' : substr($page_path, 1) . 'index.html';
            if (!isset($files[$html_path]) || isset($html_paths[$html_path])) {
                throw new CCW_Error('ccw_manifest_page_file_mismatch', 'Las rutas firmadas no coinciden con las páginas del artefacto.');
            }
            $html_paths[$html_path] = true;
            $normalized[$page_id] = array('page_path' => $page_path);
        }
        foreach ($files as $file_path => $_metadata) {
            if (substr((string) $file_path, -5) === '.html' && !isset($html_paths[$file_path])) {
                throw new CCW_Error('ccw_manifest_page_file_mismatch', 'Las rutas firmadas no cubren todas las páginas del artefacto.');
            }
        }
        return $normalized;
    }

    /**
     * Ensures the server-side HMAC/scope used to compile the runtime hash is
     * the same signed runtime that the plugin will use. The HMAC is never
     * embedded into immutable HTML. A runtime rotation therefore requires a
     * freshly compiled artifact instead of silently desynchronizing loader and
     * native form forwarding.
     *
     * @param array<string,mixed> $manifest
     * @param array<string,mixed> $runtime_configuration
     */
    public static function assert_runtime_binding(array $manifest, array $runtime_configuration)
    {
        if ($runtime_configuration === array()) {
            return;
        }
        $measurement = is_array($runtime_configuration['measurement'] ?? null)
            ? $runtime_configuration['measurement']
            : array('enabled' => false);
        if (!empty($measurement['enabled'])) {
            $normalized = array(
                'enabled' => true,
                'scope_type' => (string) ($measurement['scope_type'] ?? ''),
                'scope_id' => (int) ($measurement['scope_id'] ?? 0),
                'api_url' => CCW_Config::api_base(),
                'loader_url' => CCW_Config::api_base() . '/assets/loader.js',
                'hmac_key' => (string) ($measurement['hmac_key'] ?? ''),
                'consent_mode_enabled' => !empty($measurement['consent_mode_enabled']),
                'consent_provider' => (string) ($measurement['consent_provider'] ?? ''),
                'chat_enabled' => !empty($measurement['chat_enabled']),
                'whatsapp_enabled' => !empty($measurement['whatsapp_enabled']),
                'phone_enabled' => !empty($measurement['phone_enabled']),
            );
        } else {
            $normalized = array('enabled' => false);
        }
        $expected = hash('sha256', CCW_JSON::canonical(array(
            'schema_version' => 1,
            'measurement' => $normalized,
        )));
        $actual = (string) ($manifest['runtime_config_hash'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $actual) || !hash_equals($expected, $actual)) {
            throw new CCW_Error('ccw_runtime_artifact_configuration_mismatch', 'El artefacto no fue compilado con el mismo runtime firmado.');
        }
    }

    /**
     * @param array<string,mixed> $manifest
     * @param array<string,array<string,mixed>> $files
     * @return array<string,array<string,string>>
     */
    private static function safe_intake_forms(array $manifest, array $files)
    {
        $forms = $manifest['intake_forms'] ?? array();
        if (!is_array($forms) || count($forms) > 100) {
            throw new CCW_Error('ccw_manifest_intake_forms_invalid', 'El contrato firmado de formularios no es válido.');
        }
        if ($forms === array()) {
            return array();
        }
        $uuid = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';
        if (!preg_match($uuid, (string) ($manifest['project_id'] ?? '')) || !preg_match($uuid, (string) ($manifest['revision_id'] ?? ''))) {
            throw new CCW_Error('ccw_manifest_intake_identity_invalid', 'El artefacto no identifica proyecto y revisión de forma válida.');
        }
        $normalized = array();
        foreach ($forms as $form_id => $metadata) {
            $form_id = (string) $form_id;
            if (
                !preg_match('/^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9_-]{2,63})$/i', $form_id)
                || !is_array($metadata)
            ) {
                throw new CCW_Error('ccw_manifest_intake_form_invalid', 'El artefacto contiene un formulario no válido.');
            }
            $keys = array_keys($metadata);
            sort($keys, SORT_STRING);
            if ($keys !== array('error_anchor', 'fields', 'page_id', 'page_path', 'success_anchor')) {
                throw new CCW_Error('ccw_manifest_intake_form_invalid', 'El contrato de un formulario contiene campos no permitidos.');
            }
            $fields = self::safe_intake_fields($metadata['fields'] ?? null);
            $page_path = (string) $metadata['page_path'];
            if ($page_path !== '/' && !preg_match('#^/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/$#', $page_path)) {
                throw new CCW_Error('ccw_manifest_intake_page_path_invalid', 'La ruta firmada de un formulario no es válida.');
            }
            $page_id = strtolower((string) $metadata['page_id']);
            if (!preg_match($uuid, $page_id)) {
                throw new CCW_Error('ccw_manifest_intake_page_invalid', 'La página firmada de un formulario no es válida.');
            }
            $route = $manifest['page_routes'][$page_id] ?? null;
            if (!is_array($route) || !hash_equals((string) ($route['page_path'] ?? ''), $page_path)) {
                throw new CCW_Error('ccw_manifest_intake_page_route_mismatch', 'El formulario no coincide con la ruta firmada de su página.');
            }
            $success = (string) $metadata['success_anchor'];
            $error = (string) $metadata['error_anchor'];
            if ($success !== 'cc-' . $form_id . '-success' || $error !== 'cc-' . $form_id . '-error') {
                throw new CCW_Error('ccw_manifest_intake_anchor_invalid', 'Los destinos firmados del formulario no son válidos.');
            }
            $html_path = $page_path === '/' ? 'index.html' : substr($page_path, 1) . 'index.html';
            if (!isset($files[$html_path])) {
                throw new CCW_Error('ccw_manifest_intake_page_missing', 'El formulario apunta a una página que no forma parte del artefacto.');
            }
            $normalized[$form_id] = array(
                'page_path' => $page_path,
                'page_id' => $page_id,
                'success_anchor' => $success,
                'error_anchor' => $error,
                'fields' => $fields,
            );
        }
        return $normalized;
    }

    /** @return array<int,array{name:string,type:string,required:bool}> */
    private static function safe_intake_fields($fields)
    {
        $types = array(
            'first_name' => 'text',
            'last_name' => 'text',
            'email' => 'email',
            'phone' => 'tel',
            'message' => 'textarea',
            'preferred_contact' => 'select',
            'privacy_consent' => 'checkbox',
        );
        if (!is_array($fields) || $fields === array() || count($fields) > count($types)) {
            throw new CCW_Error('ccw_manifest_intake_fields_invalid', 'Los campos firmados del formulario no son válidos.');
        }
        $normalized = array();
        $seen = array();
        foreach ($fields as $field) {
            if (!is_array($field)) {
                throw new CCW_Error('ccw_manifest_intake_fields_invalid', 'Los campos firmados del formulario no son válidos.');
            }
            $keys = array_keys($field);
            sort($keys, SORT_STRING);
            $name = (string) ($field['name'] ?? '');
            $type = (string) ($field['type'] ?? '');
            if (
                $keys !== array('name', 'required', 'type')
                || !isset($types[$name])
                || isset($seen[$name])
                || !hash_equals($types[$name], $type)
                || !is_bool($field['required'] ?? null)
            ) {
                throw new CCW_Error('ccw_manifest_intake_fields_invalid', 'Los campos firmados del formulario no son válidos.');
            }
            $seen[$name] = true;
            $normalized[] = array('name' => $name, 'type' => $type, 'required' => $field['required']);
        }
        if (
            !isset($seen['privacy_consent'])
            || !in_array('email', array_keys($seen), true) && !in_array('phone', array_keys($seen), true)
        ) {
            throw new CCW_Error('ccw_manifest_intake_fields_invalid', 'El contrato firmado necesita privacidad y un canal de contacto.');
        }
        foreach ($normalized as $field) {
            if ($field['name'] === 'privacy_consent' && $field['required'] !== true) {
                throw new CCW_Error('ccw_manifest_intake_fields_invalid', 'La privacidad debe ser obligatoria.');
            }
        }
        return $normalized;
    }

    public static function safe_path($path)
    {
        $path = (string) $path;
        if (
            $path === ''
            || strlen($path) > 240
            || strpos($path, '..') !== false
            || strpos($path, '\\') !== false
            || strpos($path, '%') !== false
            || $path[0] === '/'
            || !preg_match('/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/', $path)
        ) {
            throw new CCW_Error('ccw_artifact_path_invalid', 'El artefacto contiene una ruta no permitida.');
        }
        foreach (explode('/', $path) as $segment) {
            if (strlen($segment) > 100 || $segment === '.' || $segment === '..') {
                throw new CCW_Error('ccw_artifact_path_invalid', 'El artefacto contiene una ruta no permitida.');
            }
        }
        $extension = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));
        if (!isset(self::$content_types[$extension])) {
            throw new CCW_Error('ccw_artifact_file_type_forbidden', 'El artefacto contiene un tipo de fichero no permitido.', array('path' => $path));
        }
        if ($extension === 'html' && !preg_match('#^(?:index|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/index)\.html$#', $path)) {
            throw new CCW_Error('ccw_artifact_html_path_invalid', 'Las páginas solo pueden publicarse como rutas de landing válidas.', array('path' => $path));
        }
        return $path;
    }

    private static function assert_content_type($path, $content_type)
    {
        $extension = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));
        if (!in_array($content_type, self::$content_types[$extension] ?? array(), true)) {
            throw new CCW_Error('ccw_artifact_content_type_invalid', 'El tipo MIME no coincide con el fichero.', array('path' => $path));
        }
    }

    /** @return array<string,string> */
    public static function safe_headers($headers, array $runtime_configuration = array())
    {
        if (!is_array($headers)) {
            throw new CCW_Error('ccw_artifact_headers_invalid', 'Las cabeceras del artefacto no son válidas.');
        }
        $allowed = array(
            'content-security-policy',
            'cross-origin-opener-policy',
            'cross-origin-resource-policy',
            'permissions-policy',
            'referrer-policy',
            'x-content-type-options',
            'x-frame-options',
        );
        $result = array();
        foreach ($headers as $name => $value) {
            $name = strtolower((string) $name);
            $value = trim((string) $value);
            if (!in_array($name, $allowed, true) || $value === '' || strlen($value) > 4096 || preg_match('/[\r\n]/', $value)) {
                throw new CCW_Error('ccw_artifact_header_forbidden', 'El artefacto contiene una cabecera no permitida.');
            }
            $result[$name] = $value;
        }
        if (($result['x-content-type-options'] ?? '') !== 'nosniff') {
            throw new CCW_Error('ccw_artifact_security_headers_incomplete', 'El artefacto debe activar nosniff.');
        }
        $csp = (string) ($result['content-security-policy'] ?? '');
        $measurement_enabled = self::runtime_measurement_enabled($runtime_configuration);
        $source_policy_valid = true;
        foreach (explode(';', $csp) as $raw_directive) {
            $parts = preg_split('/\s+/', trim((string) $raw_directive));
            $directive = strtolower((string) array_shift($parts));
            if ($directive === '') {
                continue;
            }
            foreach ($parts as $token) {
                $token = strtolower((string) $token);
                if ($token === "'unsafe-eval'" || $token === 'blob:') {
                    $source_policy_valid = false;
                }
                if ($token === "'unsafe-inline'" && (!$measurement_enabled || $directive !== 'style-src')) {
                    $source_policy_valid = false;
                }
                if ($token === 'data:' && (!$measurement_enabled || $directive !== 'img-src')) {
                    $source_policy_valid = false;
                }
            }
        }
        if (
            !preg_match('/(?:^|;)\s*default-src\s+\'none\'(?:\s*;|$)/i', $csp)
            || !preg_match('/(?:^|;)\s*base-uri\s+\'none\'(?:\s*;|$)/i', $csp)
            || !preg_match('/(?:^|;)\s*frame-ancestors\s+\'none\'(?:\s*;|$)/i', $csp)
            || !$source_policy_valid
            || ($result['x-frame-options'] ?? '') !== 'DENY'
        ) {
            throw new CCW_Error('ccw_artifact_security_headers_incomplete', 'La política de seguridad del artefacto no es suficientemente estricta.');
        }
        if (self::runtime_measurement_enabled($runtime_configuration)) {
            self::assert_loader_csp($csp);
        }
        return $result;
    }

    public static function inspect_file($path, $file_path, array $metadata, array $runtime_configuration = array(), array $manifest = array())
    {
        if (!is_file($file_path) || filesize($file_path) !== (int) $metadata['size_bytes']) {
            throw new CCW_Error('ccw_artifact_download_size_mismatch', 'El tamaño descargado no coincide con el manifest.', array('path' => $path));
        }
        if (!hash_equals((string) $metadata['sha256'], hash_file('sha256', $file_path))) {
            throw new CCW_Error('ccw_artifact_download_hash_mismatch', 'El hash descargado no coincide con el manifest.', array('path' => $path));
        }
        $extension = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));
        if ($extension === 'html') {
            self::inspect_html(
                (string) file_get_contents($file_path),
                $runtime_configuration,
                self::intake_forms_for_html_path($manifest, $path),
                $manifest,
                $path
            );
        }
        if ($extension === 'css') {
            $css = (string) file_get_contents($file_path);
            if (preg_match('/(?:@import|expression\s*\(|javascript\s*:|data\s*:\s*text\/html)/i', $css)) {
                throw new CCW_Error('ccw_artifact_css_code_forbidden', 'El CSS contiene una construcción no permitida.', array('path' => $path));
            }
        }
    }

    private static function inspect_html($html, array $runtime_configuration = array(), array $intake_forms = array(), array $manifest = array(), $html_path = '')
    {
        if (
            stripos($html, '<?php') !== false
            || preg_match('/\son[a-z0-9_-]+\s*=/i', $html)
            || preg_match('/\sform(?:action|enctype|method|target)\s*=/i', $html)
            || preg_match('/(?:javascript\s*:|data\s*:\s*text\/html)/i', $html)
            || preg_match('/<(?:iframe|object|embed|applet|base)\b/i', $html)
            || preg_match('/<meta\b[^>]*http-equiv\s*=\s*["\']?refresh/i', $html)
        ) {
            throw new CCW_Error('ccw_artifact_html_code_forbidden', 'El HTML contiene código ejecutable o embebido no permitido.');
        }

        $matches = array();
        $external_scripts = 0;
        preg_match_all('/<script\b([^>]*)>(.*?)<\/script\s*>/is', $html, $matches, PREG_SET_ORDER);
        foreach ($matches as $match) {
            $attributes = trim((string) $match[1]);
            $parsed = self::parse_tag_attributes($attributes);
            if (isset($parsed['src'])) {
                $external_scripts++;
                self::assert_loader_script($parsed, (string) $match[2], $runtime_configuration, $manifest, $html_path);
                continue;
            }
            if (count($parsed) !== 1 || !isset($parsed['type']) || $parsed['type'] !== 'application/ld+json') {
                throw new CCW_Error('ccw_artifact_script_forbidden', 'Solo se permite JSON-LD y el loader firmado de ClinicaClick.');
            }
            json_decode((string) $match[2], true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                throw new CCW_Error('ccw_artifact_jsonld_invalid', 'El JSON-LD de la página no es válido.');
            }
        }
        $without_allowed = preg_replace('/<script\b[^>]*>.*?<\/script\s*>/is', '', $html);
        if (preg_match('/<script\b/i', (string) $without_allowed)) {
            throw new CCW_Error('ccw_artifact_script_forbidden', 'La página contiene una etiqueta de script incompleta o no permitida.');
        }
        if (self::runtime_measurement_enabled($runtime_configuration) && $external_scripts !== 1) {
            throw new CCW_Error('ccw_artifact_loader_count_invalid', 'Cada página debe contener exactamente un loader firmado de ClinicaClick.');
        }

        if (self::runtime_measurement_enabled($runtime_configuration)) {
            $meta_matches = array();
            preg_match_all('/<meta\b([^>]*)>/i', $html, $meta_matches, PREG_SET_ORDER);
            $meta_csp = array();
            foreach ($meta_matches as $meta_match) {
                $meta = self::parse_tag_attributes((string) $meta_match[1]);
                if (strtolower((string) ($meta['http-equiv'] ?? '')) === 'content-security-policy') {
                    $meta_csp[] = (string) ($meta['content'] ?? '');
                }
            }
            if (count($meta_csp) !== 1) {
                throw new CCW_Error('ccw_artifact_meta_csp_invalid', 'Cada página debe contener una única política CSP coherente con el loader.');
            }
            self::assert_loader_csp($meta_csp[0]);
        }
        if ($manifest !== array()) {
            self::inspect_intake_forms($html, $intake_forms, $manifest);
        }
    }

    /** @return array<string,array<string,string>> */
    private static function intake_forms_for_html_path(array $manifest, $html_path)
    {
        if (!is_array($manifest['intake_forms'] ?? null)) {
            return array();
        }
        $result = array();
        foreach ($manifest['intake_forms'] as $form_id => $metadata) {
            if (!is_array($metadata)) {
                continue;
            }
            $page_path = (string) ($metadata['page_path'] ?? '');
            $expected_path = $page_path === '/' ? 'index.html' : substr($page_path, 1) . 'index.html';
            if (hash_equals((string) $html_path, $expected_path)) {
                $result[(string) $form_id] = $metadata;
            }
        }
        return $result;
    }

    /**
     * The static compiler marks native forms so loader.js never captures the
     * same submit a second time. Identity inputs are inspected against the
     * signed manifest before a release can become active.
     *
     * @param array<string,array<string,string>> $expected_forms
     * @param array<string,mixed> $manifest
     */
    private static function inspect_intake_forms($html, array $expected_forms, array $manifest)
    {
        $matches = array();
        preg_match_all('/<form\b([^>]*)>(.*?)<\/form\s*>/is', (string) $html, $matches, PREG_SET_ORDER);
        $seen = array();
        foreach ($matches as $match) {
            $attributes = self::parse_tag_attributes((string) $match[1]);
            $action = (string) ($attributes['action'] ?? '');
            $native = (string) ($attributes['data-cc-native-intake'] ?? '');
            if ($action !== CCW_Intake_Bridge::ENDPOINT_PATH || $native !== 'true') {
                throw new CCW_Error('ccw_artifact_form_forbidden', 'La página contiene un formulario que no usa el intake nativo firmado.');
            }
            $allowed_form_attributes = array('accept-charset', 'action', 'class', 'data-cc-native-intake', 'enctype', 'id', 'method');
            foreach (array_keys($attributes) as $name) {
                if (!in_array($name, $allowed_form_attributes, true)) {
                    throw new CCW_Error('ccw_artifact_form_attributes_invalid', 'El formulario contiene atributos no permitidos.');
                }
            }
            if (
                strtolower((string) ($attributes['method'] ?? '')) !== 'post'
                || strtoupper((string) ($attributes['accept-charset'] ?? '')) !== 'UTF-8'
                || (isset($attributes['enctype']) && strtolower((string) $attributes['enctype']) !== 'application/x-www-form-urlencoded')
            ) {
                throw new CCW_Error('ccw_artifact_form_contract_invalid', 'El formulario no usa POST urlencoded UTF-8.');
            }
            $form_html_id = (string) ($attributes['id'] ?? '');
            if (strpos($form_html_id, 'cc-') !== 0) {
                throw new CCW_Error('ccw_artifact_form_identity_invalid', 'El formulario no tiene una identidad firmada válida.');
            }
            $form_id = substr($form_html_id, 3);
            if (!isset($expected_forms[$form_id]) || isset($seen[$form_id])) {
                throw new CCW_Error('ccw_artifact_form_identity_invalid', 'El formulario no coincide de forma única con el manifest.');
            }
            $seen[$form_id] = true;
            $metadata = $expected_forms[$form_id];
            $controls = self::named_form_controls((string) $match[2]);
            $required_hidden = array(
                'web_project_id' => strtolower((string) ($manifest['project_id'] ?? '')),
                'web_revision_id' => strtolower((string) ($manifest['revision_id'] ?? '')),
                'web_page_id' => strtolower((string) ($metadata['page_id'] ?? '')),
                'web_form_id' => $form_id,
            );
            foreach ($required_hidden as $name => $value) {
                if (
                    !isset($controls[$name])
                    || strtolower((string) ($controls[$name]['type'] ?? '')) !== 'hidden'
                    || !is_string($controls[$name]['value'] ?? null)
                    || !hash_equals($value, (string) $controls[$name]['value'])
                ) {
                    throw new CCW_Error('ccw_artifact_form_identity_invalid', 'Falta una identidad oculta firmada del formulario.');
                }
            }
            if (
                !isset($controls['_cc_company'])
                || strtolower((string) ($controls['_cc_company']['type'] ?? 'text')) !== 'text'
                || !isset($controls['privacy_consent'])
                || strtolower((string) ($controls['privacy_consent']['type'] ?? '')) !== 'checkbox'
                || (string) ($controls['privacy_consent']['value'] ?? '') !== '1'
                || !array_key_exists('required', $controls['privacy_consent'])
            ) {
                throw new CCW_Error('ccw_artifact_form_safety_fields_invalid', 'El formulario no contiene consentimiento y honeypot válidos.');
            }
            if (!isset($controls['email']) && !isset($controls['phone'])) {
                throw new CCW_Error('ccw_artifact_form_contact_missing', 'El formulario debe solicitar email o teléfono.');
            }
            $expected_field_names = array();
            foreach ((array) ($metadata['fields'] ?? array()) as $field) {
                $name = (string) ($field['name'] ?? '');
                $expected_field_names[$name] = true;
                if (
                    !isset($controls[$name])
                    || array_key_exists('required', $controls[$name]) !== !empty($field['required'])
                ) {
                    throw new CCW_Error('ccw_artifact_form_required_mismatch', 'Los campos obligatorios no coinciden con el manifest firmado.');
                }
            }
            foreach (array('first_name', 'last_name', 'email', 'phone', 'message', 'preferred_contact', 'privacy_consent') as $name) {
                if (isset($controls[$name]) !== isset($expected_field_names[$name])) {
                    throw new CCW_Error('ccw_artifact_form_fields_mismatch', 'Los campos visibles no coinciden con el manifest firmado.');
                }
            }
            foreach (array('success_anchor', 'error_anchor') as $anchor_key) {
                $anchor = preg_quote((string) $metadata[$anchor_key], '/');
                if (!preg_match('/\bid\s*=\s*(["\'])' . $anchor . '\1/i', (string) $match[2])) {
                    throw new CCW_Error('ccw_artifact_form_anchor_missing', 'La página no contiene las anclas firmadas del formulario.');
                }
            }
        }
        if (count($seen) !== count($expected_forms)) {
            throw new CCW_Error('ccw_artifact_form_missing', 'Falta un formulario declarado por el manifest firmado.');
        }
        $without_forms = preg_replace('/<form\b[^>]*>.*?<\/form\s*>/is', '', (string) $html);
        if (preg_match('/<form\b/i', (string) $without_forms)) {
            throw new CCW_Error('ccw_artifact_form_forbidden', 'La página contiene un formulario incompleto o anidado.');
        }
    }

    /** @return array<string,array<string,string|null>> */
    private static function named_form_controls($body)
    {
        $allowed_names = array_fill_keys(array(
            'first_name', 'last_name', 'email', 'phone', 'message', 'preferred_contact',
            'privacy_consent', '_cc_ad_user_data', '_cc_ad_personalization', '_cc_company',
            'web_project_id', 'web_revision_id', 'web_page_id', 'web_form_id',
        ), true);
        $matches = array();
        preg_match_all('/<(?:input|textarea|select)\b([^>]*)>/i', (string) $body, $matches, PREG_SET_ORDER);
        $controls = array();
        foreach ($matches as $match) {
            $attributes = self::parse_tag_attributes((string) $match[1]);
            if (!isset($attributes['name'])) {
                continue;
            }
            $name = (string) $attributes['name'];
            if (!isset($allowed_names[$name]) || isset($controls[$name])) {
                throw new CCW_Error('ccw_artifact_form_fields_invalid', 'El formulario contiene un campo duplicado o no permitido.');
            }
            $controls[$name] = $attributes;
        }
        return $controls;
    }

    private static function runtime_measurement_enabled(array $runtime_configuration)
    {
        return !empty($runtime_configuration['measurement']['enabled']);
    }

    /** @return array<string,string|null> */
    private static function parse_tag_attributes($source)
    {
        $source = trim((string) $source);
        $length = strlen($source);
        $offset = 0;
        $result = array();
        while ($offset < $length) {
            if (!preg_match(
                '/\G\s*([A-Za-z_:][A-Za-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/i',
                $source,
                $match,
                PREG_UNMATCHED_AS_NULL,
                $offset
            )) {
                throw new CCW_Error('ccw_artifact_tag_attributes_invalid', 'La página contiene atributos HTML no válidos.');
            }
            $consumed = strlen((string) $match[0]);
            if ($consumed < 1) {
                throw new CCW_Error('ccw_artifact_tag_attributes_invalid', 'La página contiene atributos HTML no válidos.');
            }
            $offset += $consumed;
            $name = strtolower((string) $match[1]);
            if (array_key_exists($name, $result)) {
                throw new CCW_Error('ccw_artifact_tag_attribute_duplicate', 'La página contiene un atributo HTML duplicado.');
            }
            $value = null;
            foreach (array(2, 3, 4) as $index) {
                if (array_key_exists($index, $match) && $match[$index] !== null) {
                    $value = html_entity_decode((string) $match[$index], ENT_QUOTES | ENT_HTML5, 'UTF-8');
                    break;
                }
            }
            if ($value !== null && preg_match('/[\x00-\x1f\x7f]/', $value)) {
                throw new CCW_Error('ccw_artifact_tag_attribute_invalid', 'La página contiene un atributo HTML no válido.');
            }
            $result[$name] = $value;
        }
        return $result;
    }

    /** @param array<string,string|null> $attributes */
    private static function assert_loader_script(array $attributes, $body, array $runtime_configuration, array $manifest = array(), $html_path = '')
    {
        if (!self::runtime_measurement_enabled($runtime_configuration) || trim((string) $body) !== '') {
            throw new CCW_Error('ccw_artifact_loader_forbidden', 'El loader de la página no corresponde al runtime firmado.');
        }
        $measurement = $runtime_configuration['measurement'];
        $scope_type = (string) ($measurement['scope_type'] ?? '');
        $scope_attribute = $scope_type === 'clinic' ? 'data-clinic-id' : ($scope_type === 'group' ? 'data-group-id' : '');
        if ($scope_attribute === '') {
            throw new CCW_Error('ccw_artifact_loader_scope_invalid', 'El loader no contiene un alcance firmado válido.');
        }
        $project_id = strtolower(trim((string) ($manifest['project_id'] ?? '')));
        $revision_id = strtolower(trim((string) ($manifest['revision_id'] ?? '')));
        $page_id = strtolower(trim((string) ($attributes['data-web-page-id'] ?? '')));
        $uuid = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';
        $page_route = is_array($manifest['page_routes'][$page_id] ?? null)
            ? $manifest['page_routes'][$page_id]
            : array();
        $page_path = (string) ($page_route['page_path'] ?? '');
        $expected_html_path = $page_path === '/'
            ? 'index.html'
            : trim($page_path, '/') . '/index.html';
        if (
            !preg_match($uuid, $project_id)
            || !preg_match($uuid, $revision_id)
            || !preg_match($uuid, $page_id)
            || !hash_equals($project_id, strtolower((string) ($attributes['data-web-project-id'] ?? '')))
            || !hash_equals($revision_id, strtolower((string) ($attributes['data-web-revision-id'] ?? '')))
            || !preg_match('#^/(?:[a-z0-9][a-z0-9_-]{0,79}/)?$#', $page_path)
            || !hash_equals($expected_html_path, (string) $html_path)
        ) {
            throw new CCW_Error('ccw_artifact_loader_identity_invalid', 'El loader no coincide con la página firmada del artefacto.');
        }
        $expected = array(
            'src' => CCW_Config::api_base() . '/assets/loader.js',
            'async' => null,
            'data-api-url' => CCW_Config::api_base(),
            'data-event-bridge-url' => CCW_Intake_Bridge::EVENT_ENDPOINT_PATH,
            'data-web-project-id' => $project_id,
            'data-web-revision-id' => $revision_id,
            'data-web-page-id' => $page_id,
            $scope_attribute => (string) (int) ($measurement['scope_id'] ?? 0),
            'data-consent-mode-enabled' => !empty($measurement['consent_mode_enabled']) ? 'true' : 'false',
            'data-consent-provider' => (string) ($measurement['consent_provider'] ?? 'external_cmp'),
        );
        $actual_keys = array_keys($attributes);
        $expected_keys = array_keys($expected);
        sort($actual_keys, SORT_STRING);
        sort($expected_keys, SORT_STRING);
        if ($actual_keys !== $expected_keys) {
            throw new CCW_Error('ccw_artifact_loader_attributes_invalid', 'El loader contiene atributos no permitidos o incompletos.');
        }
        foreach ($expected as $name => $value) {
            if ($value === null) {
                if ($attributes[$name] !== null) {
                    throw new CCW_Error('ccw_artifact_loader_attributes_invalid', 'El atributo async del loader no es válido.');
                }
            } elseif (!is_string($attributes[$name]) || !hash_equals($value, $attributes[$name])) {
                throw new CCW_Error('ccw_artifact_loader_configuration_mismatch', 'El loader no coincide con la configuración firmada.');
            }
        }
    }

    private static function assert_loader_csp($csp)
    {
        $directives = array();
        foreach (explode(';', (string) $csp) as $raw_directive) {
            $raw_directive = trim($raw_directive);
            if ($raw_directive === '') {
                continue;
            }
            $parts = preg_split('/\s+/', $raw_directive);
            $name = strtolower((string) array_shift($parts));
            if ($name === '' || isset($directives[$name])) {
                throw new CCW_Error('ccw_artifact_loader_csp_invalid', 'La política CSP del loader no es válida.');
            }
            $directives[$name] = $parts;
        }
        $origin = CCW_Config::api_base();
        $script = $directives['script-src'] ?? array();
        $connect = $directives['connect-src'] ?? array();
        $style = $directives['style-src'] ?? array();
        $images = $directives['img-src'] ?? array();
        if (isset($directives['script-src-elem']) || isset($directives['script-src-attr'])) {
            throw new CCW_Error('ccw_artifact_loader_csp_external_forbidden', 'La política CSP no puede redefinir por separado la ejecución de scripts.');
        }
        if (!in_array($origin, $script, true) || !in_array($origin, $connect, true)) {
            throw new CCW_Error('ccw_artifact_loader_csp_missing', 'La política CSP bloquearía el loader o sus peticiones.');
        }
        foreach ($script as $token) {
            if ($token !== $origin && !preg_match('/^\'sha(?:256|384|512)-[A-Za-z0-9+\/_=-]+\'$/', (string) $token)) {
                throw new CCW_Error('ccw_artifact_loader_csp_external_forbidden', 'La política CSP permite scripts externos no autorizados.');
            }
        }
        foreach ($connect as $token) {
            if ($token !== $origin && $token !== "'self'") {
                throw new CCW_Error('ccw_artifact_loader_csp_external_forbidden', 'La política CSP permite conexiones externas no autorizadas.');
            }
        }
        foreach (array("'self'", "'unsafe-inline'") as $required) {
            if (!in_array($required, $style, true)) {
                throw new CCW_Error('ccw_artifact_loader_csp_missing', 'La política CSP bloquearía los estilos del runtime.');
            }
        }
        foreach ($style as $token) {
            if ($token !== "'self'" && $token !== "'unsafe-inline'") {
                throw new CCW_Error('ccw_artifact_loader_csp_external_forbidden', 'La política CSP permite estilos externos no autorizados.');
            }
        }
        foreach (array("'self'", 'https://media.clinicaclick.com', $origin, 'data:') as $required) {
            if (!in_array($required, $images, true)) {
                throw new CCW_Error('ccw_artifact_loader_csp_missing', 'La política CSP bloquearía las imágenes del runtime.');
            }
        }
        foreach ($images as $token) {
            if (!in_array($token, array("'self'", 'https://media.clinicaclick.com', $origin, 'data:'), true)) {
                throw new CCW_Error('ccw_artifact_loader_csp_external_forbidden', 'La política CSP permite imágenes externas no autorizadas.');
            }
        }
    }

    /** @return array<string,mixed> */
    public static function verify_runtime_configuration(array $runtime, array $envelope, $installation_id)
    {
        if (!CCW_Trust_Store::verify_signed_payload($runtime, $envelope)) {
            throw new CCW_Error('ccw_runtime_signature_invalid', 'La configuración de runtime no tiene una firma válida.');
        }
        if (
            (int) ($runtime['schema_version'] ?? 0) !== 1
            || !hash_equals((string) $installation_id, (string) ($runtime['installation_id'] ?? ''))
            || (string) ($runtime['route_prefix'] ?? '') !== '/cita'
            || !in_array((string) ($runtime['status'] ?? ''), array('active', 'retired'), true)
            || (int) ($runtime['sequence'] ?? 0) < 1
        ) {
            throw new CCW_Error('ccw_runtime_contract_invalid', 'La configuración de runtime no corresponde a esta instalación.');
        }
        $desired_hash = $runtime['desired_artifact_hash'] ?? null;
        if (($runtime['status'] === 'active' && !preg_match('/^[a-f0-9]{64}$/', (string) $desired_hash))
            || ($runtime['status'] === 'retired' && $desired_hash !== null)) {
            throw new CCW_Error('ccw_runtime_artifact_invalid', 'La configuración firmada no identifica correctamente el artefacto deseado.');
        }
        $measurement = $runtime['measurement'] ?? array('enabled' => false);
        if (!is_array($measurement) || !is_bool($measurement['enabled'] ?? null)) {
            throw new CCW_Error('ccw_measurement_contract_invalid', 'La configuración de medición no es válida.');
        }
        if ($measurement['enabled']) {
            $scope_type = (string) ($measurement['scope_type'] ?? '');
            $scope_id = (int) ($measurement['scope_id'] ?? 0);
            $hmac = (string) ($measurement['hmac_key'] ?? '');
            if (
                !in_array($scope_type, array('clinic', 'group'), true)
                || $scope_id < 1
                || (string) ($measurement['loader_path'] ?? '') !== '/assets/loader.js'
                || strlen($hmac) < 16
                || strlen($hmac) > 512
                || preg_match('/[\x00-\x20\x7f]/', $hmac)
            ) {
                throw new CCW_Error('ccw_measurement_contract_invalid', 'La configuración de medición no es válida.');
            }
            $runtime['measurement'] = array(
                'enabled' => true,
                'scope_type' => $scope_type,
                'scope_id' => $scope_id,
                'loader_path' => '/assets/loader.js',
                'hmac_key' => $hmac,
                'consent_mode_enabled' => !empty($measurement['consent_mode_enabled']),
                'consent_provider' => in_array((string) ($measurement['consent_provider'] ?? ''), array('clinicaclick', 'external_cmp'), true)
                    ? (string) $measurement['consent_provider']
                    : 'external_cmp',
                'chat_enabled' => !empty($measurement['chat_enabled']),
                'whatsapp_enabled' => !empty($measurement['whatsapp_enabled']),
                'phone_enabled' => !empty($measurement['phone_enabled']),
            );
        } else {
            $runtime['measurement'] = array('enabled' => false);
        }
        return $runtime;
    }
}
