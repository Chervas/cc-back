<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_JSON
{
    /**
     * Canonical JSON shared with Clinicaclick's Node renderer: object keys are
     * sorted recursively, arrays keep their order and no insignificant
     * whitespace is emitted.
     *
     * @param mixed $value
     */
    public static function canonical($value)
    {
        $normalized = self::normalize($value);
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS;
        $json = json_encode($normalized, $flags);
        if (!is_string($json) || json_last_error() !== JSON_ERROR_NONE) {
            throw new CCW_Error('ccw_json_encode_failed', 'No se pudo serializar el documento firmado.');
        }
        return $json;
    }

    /**
     * @return mixed
     */
    private static function normalize($value)
    {
        if (is_object($value)) {
            $value = get_object_vars($value);
        }
        if (is_string($value)) {
            return self::normalize_string($value);
        }
        if (is_float($value) && $value == 0.0) {
            return 0;
        }
        if (!is_array($value)) {
            return $value;
        }
        if (self::is_list($value)) {
            return array_map(array(__CLASS__, 'normalize'), array_values($value));
        }
        $normalized_keys = array();
        foreach (array_keys($value) as $key) {
            $normalized = self::normalize_string((string) $key);
            if (isset($normalized_keys[$normalized])) {
                throw new CCW_Error('ccw_json_key_collision', 'Dos propiedades colisionan al normalizar Unicode.');
            }
            $normalized_keys[$normalized] = $key;
        }
        $keys = array_keys($normalized_keys);
        sort($keys, SORT_STRING);
        $result = array();
        foreach ($keys as $key) {
            $result[(string) $key] = self::normalize($value[$normalized_keys[$key]]);
        }
        return $result;
    }

    private static function is_list(array $value)
    {
        if ($value === array()) {
            return true;
        }
        return array_keys($value) === range(0, count($value) - 1);
    }

    private static function normalize_string($value)
    {
        if (class_exists('Normalizer')) {
            $normalized = Normalizer::normalize((string) $value, Normalizer::FORM_C);
            if (!is_string($normalized)) {
                throw new CCW_Error('ccw_json_unicode_invalid', 'No se pudo normalizar un valor Unicode firmado.');
            }
            return $normalized;
        }
        // Current signed manifests/control payloads contain only ASCII. If a
        // future schema adds human text, hosts without ext-intl fail closed
        // instead of verifying a representation different from Node NFC.
        if (preg_match('/[^\x00-\x7f]/', (string) $value)) {
            throw new CCW_Error('ccw_json_nfc_unavailable', 'El host necesita ext-intl para verificar valores Unicode firmados.');
        }
        return (string) $value;
    }

    /** @return array<string,mixed> */
    public static function decode_object($json, $code = 'ccw_json_invalid')
    {
        $decoded = json_decode((string) $json, true);
        if (!is_array($decoded) || self::is_list($decoded)) {
            throw new CCW_Error($code, 'La respuesta JSON no tiene el formato esperado.');
        }
        return $decoded;
    }
}
