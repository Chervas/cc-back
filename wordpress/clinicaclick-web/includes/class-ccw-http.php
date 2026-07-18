<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_HTTP
{
    const MAX_CONTROL_BYTES = 1048576;

    /** @return array<string,mixed>|null null means HTTP 304 */
    public function desired_state($etag = '')
    {
        $id = rawurlencode(CCW_Config::installation_id());
        $url = CCW_Config::api_base() . '/api/marketing/web-installations/' . $id . '/desired-state';
        $headers = $this->authenticated_headers();
        if ($etag !== '' && strlen($etag) <= 256 && !preg_match('/[\r\n]/', $etag)) {
            $headers['If-None-Match'] = $etag;
        }
        $response = wp_safe_remote_get($url, array(
            'headers' => $headers,
            'timeout' => 15,
            'redirection' => 0,
            'limit_response_size' => self::MAX_CONTROL_BYTES,
            'user-agent' => $this->user_agent(),
        ));
        if (is_wp_error($response)) {
            throw new CCW_Error('ccw_desired_state_unavailable', 'No se pudo consultar el estado deseado de la publicación.');
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status === 304) {
            return null;
        }
        if ($status !== 200) {
            throw new CCW_Error('ccw_desired_state_http_error', 'ClinicaClick no devolvió un estado deseado válido.', array('http_status' => $status));
        }
        $body = (string) wp_remote_retrieve_body($response);
        if ($body === '' || strlen($body) >= self::MAX_CONTROL_BYTES) {
            throw new CCW_Error('ccw_desired_state_too_large', 'La respuesta de control está vacía o supera el límite permitido.');
        }
        $decoded = CCW_JSON::decode_object($body, 'ccw_desired_state_json_invalid');
        $etag_value = (string) wp_remote_retrieve_header($response, 'etag');
        if ($etag_value !== '' && strlen($etag_value) <= 256 && !preg_match('/[\r\n]/', $etag_value)) {
            $decoded['_http_etag'] = $etag_value;
        }
        return $decoded;
    }

    /** @return array<string,mixed> */
    public function get_json($url, $error_prefix)
    {
        $url = self::safe_download_url($url);
        $response = wp_safe_remote_get($url, array(
            'headers' => $this->download_headers($url, 'application/json'),
            'timeout' => 15,
            'redirection' => 0,
            'limit_response_size' => self::MAX_CONTROL_BYTES,
            'user-agent' => $this->user_agent(),
        ));
        if (is_wp_error($response) || (int) wp_remote_retrieve_response_code($response) !== 200) {
            throw new CCW_Error($error_prefix . '_unavailable', 'No se pudo descargar un documento firmado del artefacto.');
        }
        $body = (string) wp_remote_retrieve_body($response);
        if ($body === '' || strlen($body) >= self::MAX_CONTROL_BYTES) {
            throw new CCW_Error($error_prefix . '_too_large', 'Un documento firmado supera el límite permitido.');
        }
        return CCW_JSON::decode_object($body, $error_prefix . '_invalid');
    }

    public function download_file($url, $target, $expected_bytes)
    {
        $url = self::safe_download_url($url);
        $expected_bytes = (int) $expected_bytes;
        if ($expected_bytes < 0 || $expected_bytes > CCW_Manifest::MAX_FILE_BYTES) {
            throw new CCW_Error('ccw_download_size_invalid', 'El tamaño esperado del fichero no es válido.');
        }
        $response = wp_safe_remote_get($url, array(
            'headers' => $this->download_headers($url, 'application/octet-stream'),
            'timeout' => 30,
            'redirection' => 0,
            'stream' => true,
            'filename' => $target,
            'limit_response_size' => $expected_bytes + 1,
            'user-agent' => $this->user_agent(),
        ));
        if (is_wp_error($response) || (int) wp_remote_retrieve_response_code($response) !== 200) {
            @unlink($target);
            throw new CCW_Error('ccw_artifact_file_unavailable', 'No se pudo descargar un fichero del artefacto.');
        }
        if (!is_file($target)) {
            throw new CCW_Error('ccw_artifact_file_missing', 'La descarga no produjo el fichero esperado.');
        }
    }

    /** @param array<string,mixed> $payload */
    public function report(array $payload)
    {
        if (!CCW_Config::is_configured()) {
            return false;
        }
        $id = rawurlencode(CCW_Config::installation_id());
        $url = CCW_Config::api_base() . '/api/marketing/web-installations/' . $id . '/reports';
        $body = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($body) || strlen($body) > 32768) {
            return false;
        }
        $response = wp_safe_remote_post($url, array(
            'headers' => array_merge($this->authenticated_headers(), array('Content-Type' => 'application/json')),
            'body' => $body,
            'timeout' => 8,
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
            'user-agent' => $this->user_agent(),
        ));
        return !is_wp_error($response) && in_array((int) wp_remote_retrieve_response_code($response), array(200, 202, 204), true);
    }

    public static function safe_download_url($value)
    {
        $value = trim((string) $value);
        $parts = parse_url($value);
        if (
            !is_array($parts)
            || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
            || empty($parts['host'])
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['fragment'])
            || strlen($value) > 4096
            || !wp_http_validate_url($value)
        ) {
            throw new CCW_Error('ccw_download_url_invalid', 'La URL de descarga del artefacto no es segura.');
        }
        return $value;
    }

    /** @return array<string,string> */
    private function authenticated_headers()
    {
        return array(
            'Accept' => 'application/json',
            'Authorization' => 'Bearer ' . CCW_Config::token(),
            'X-Clinicaclick-Plugin-Version' => CCW_VERSION,
        );
    }

    /** @return array<string,string> */
    private function download_headers($url, $accept)
    {
        $headers = array('Accept' => (string) $accept);
        if (self::url_origin($url) === self::url_origin(CCW_Config::api_base())) {
            $headers['Authorization'] = 'Bearer ' . CCW_Config::token();
            $headers['X-Clinicaclick-Plugin-Version'] = CCW_VERSION;
        }
        return $headers;
    }

    private static function url_origin($value)
    {
        $parts = parse_url((string) $value);
        $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
        return strtolower((string) ($parts['scheme'] ?? ''))
            . '://' . strtolower((string) ($parts['host'] ?? '')) . $port;
    }

    private function user_agent()
    {
        return 'ClinicaClick-Web/' . CCW_VERSION . '; WordPress/' . get_bloginfo('version');
    }
}
