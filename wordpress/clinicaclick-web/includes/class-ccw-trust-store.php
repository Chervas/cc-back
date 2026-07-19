<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Trust_Store
{
    const SPKI_PREFIX_HEX = '302a300506032b6570032100';
    const MAX_RETIRED_KEYS = 32;

    /** @return array<string,array<string,mixed>> */
    public static function all()
    {
        $stored = get_option(CCW_Config::OPTION_TRUSTED_KEYS, array());
        $keys = is_array($stored) ? $stored : array();

        if (defined('CLINICACLICK_WEB_TRUST_DESCRIPTOR_JSON')) {
            $configured = json_decode((string) constant('CLINICACLICK_WEB_TRUST_DESCRIPTOR_JSON'), true);
            if (is_array($configured)) {
                $descriptors = isset($configured['key_id']) ? array($configured) : $configured;
                foreach ($descriptors as $descriptor) {
                    if (!is_array($descriptor)) {
                        continue;
                    }
                    try {
                        $normalized = self::validate_descriptor($descriptor);
                        $keys[$normalized['key_id']] = $normalized;
                    } catch (CCW_Error $error) {
                        // A broken server constant must not make a remote key trusted.
                    }
                }
            }
        }
        $provisioned = CCW_Config::provisioned();
        if (is_array($provisioned['trust_descriptor'] ?? null)) {
            try {
                $normalized = self::validate_descriptor($provisioned['trust_descriptor']);
                $keys[$normalized['key_id']] = $normalized;
            } catch (CCW_Error $error) {
                // Invalid provisioning never expands trust.
            }
        }
        return $keys;
    }

    /**
     * Imports the first trust anchor only from an out-of-band administrator
     * action. Remote desired-state data can rotate a key, but can never create
     * the first trusted key by itself.
     */
    public static function import_configured_descriptor($json)
    {
        $descriptor = is_array($json) ? $json : json_decode((string) $json, true);
        if (!is_array($descriptor)) {
            throw new CCW_Error('ccw_key_descriptor_invalid', 'El descriptor de clave pública no es JSON válido.');
        }
        $normalized = self::validate_descriptor($descriptor);
        $stored = get_option(CCW_Config::OPTION_TRUSTED_KEYS, array());
        $stored = is_array($stored) ? $stored : array();
        $previous_active = self::active_key_id(self::all());
        $previous_state = self::read_state();
        $stored[$normalized['key_id']] = $normalized;
        update_option(CCW_Config::OPTION_TRUSTED_KEYS, $stored, false);
        // This method is reachable only through an explicit administrator or
        // provisioned out-of-band action. It is therefore also the break-glass
        // path when the previous private key is lost/compromised; remote
        // desired-state never calls it.
        $retired = $previous_state['retired_key_ids'];
        if ($previous_active !== '' && !hash_equals($previous_active, $normalized['key_id'])) {
            $retired[] = $previous_active;
        }
        $retired = array_values(array_unique(array_filter($retired, static function ($candidate) use ($normalized) {
            return !hash_equals((string) $candidate, $normalized['key_id']);
        })));
        if (count($retired) > self::MAX_RETIRED_KEYS) {
            $retired = array_slice($retired, -self::MAX_RETIRED_KEYS);
        }
        self::write_state(array(
            'active_key_id' => $normalized['key_id'],
            'pending_key_id' => null,
            'pending_from_key_id' => null,
            'retired_key_ids' => $retired,
        ));
        return $normalized;
    }

    /** @return array<string,mixed> */
    public static function trust_remote_descriptor(array $descriptor, array $envelope = array())
    {
        $normalized = self::validate_descriptor($descriptor);
        $keys = self::all();
        if ($keys === array()) {
            throw new CCW_Error(
                'ccw_trust_not_configured',
                'Falta configurar el descriptor inicial de la clave pública de ClinicaClick.'
            );
        }
        $active_key_id = self::active_key_id($keys);
        if ($active_key_id === '' || !isset($keys[$active_key_id])) {
            throw new CCW_Error(
                'ccw_trust_state_ambiguous',
                'No se puede determinar de forma segura la clave de firma activa.'
            );
        }
        $state = self::read_state();
        $retired = array_fill_keys($state['retired_key_ids'], true);
        if (isset($retired[$normalized['key_id']])) {
            throw new CCW_Error('ccw_key_downgrade_blocked', 'Se ha rechazado una clave de firma retirada anteriormente.');
        }
        if (hash_equals($active_key_id, $normalized['key_id'])) {
            $existing = self::validate_descriptor($keys[$normalized['key_id']]);
            if (!hash_equals(self::raw_public_key($existing), self::raw_public_key($normalized))) {
                throw new CCW_Error('ccw_key_id_collision', 'El descriptor remoto no coincide con la clave pública ya confiada.');
            }
            return $existing;
        }

        if (isset($keys[$normalized['key_id']])) {
            $existing = self::validate_descriptor($keys[$normalized['key_id']]);
            if (!hash_equals(self::raw_public_key($existing), self::raw_public_key($normalized))) {
                throw new CCW_Error('ccw_key_id_collision', 'El descriptor remoto no coincide con la clave pública ya confiada.');
            }
            if (
                !hash_equals((string) ($state['pending_key_id'] ?? ''), $normalized['key_id'])
                || !hash_equals((string) ($state['pending_from_key_id'] ?? ''), $active_key_id)
            ) {
                throw new CCW_Error('ccw_key_rotation_not_authorized', 'La clave remota no pertenece a la transición activa.');
            }
        }
        if (!self::verify_signed_payload($normalized, $envelope, array($active_key_id => $keys[$active_key_id]))) {
            throw new CCW_Error('ccw_key_rotation_signature_invalid', 'La rotación de clave pública no está firmada por una clave confiada.');
        }
        $stored = get_option(CCW_Config::OPTION_TRUSTED_KEYS, array());
        $stored = is_array($stored) ? $stored : array();
        $stored[$normalized['key_id']] = $normalized;
        update_option(CCW_Config::OPTION_TRUSTED_KEYS, $stored, false);
        self::write_state(array(
            'active_key_id' => $active_key_id,
            'pending_key_id' => $normalized['key_id'],
            'pending_from_key_id' => $active_key_id,
            'retired_key_ids' => $state['retired_key_ids'],
        ));
        return $normalized;
    }

    /**
     * Marks a remotely introduced key active only after the signed desired
     * state has been applied completely. The previous active key remains in
     * the verification store for immutable historical artifacts, but can never
     * become active again through desired-state.
     */
    public static function promote_remote_descriptor($key_id)
    {
        $key_id = (string) $key_id;
        $keys = self::all();
        $active_key_id = self::active_key_id($keys);
        if ($active_key_id !== '' && hash_equals($active_key_id, $key_id)) {
            return $key_id;
        }
        $state = self::read_state();
        if (
            $active_key_id === ''
            || !isset($keys[$key_id])
            || !hash_equals((string) ($state['pending_key_id'] ?? ''), $key_id)
            || !hash_equals((string) ($state['pending_from_key_id'] ?? ''), $active_key_id)
        ) {
            throw new CCW_Error('ccw_key_rotation_not_authorized', 'La nueva clave no ha completado una transición firmada válida.');
        }
        $retired = array_values(array_unique(array_merge(
            $state['retired_key_ids'],
            array($active_key_id)
        )));
        $retired = array_values(array_filter($retired, static function ($candidate) use ($key_id) {
            return !hash_equals((string) $candidate, $key_id);
        }));
        if (count($retired) > self::MAX_RETIRED_KEYS) {
            $retired = array_slice($retired, -self::MAX_RETIRED_KEYS);
        }
        self::write_state(array(
            'active_key_id' => $key_id,
            'pending_key_id' => null,
            'pending_from_key_id' => null,
            'retired_key_ids' => $retired,
        ));
        return $key_id;
    }

    /** @return string */
    public static function active_key_id(array $keys = null)
    {
        $keys = $keys === null ? self::all() : $keys;
        $state = self::read_state();
        $active = (string) ($state['active_key_id'] ?? '');
        if ($active !== '' && isset($keys[$active])) {
            return $active;
        }

        $bootstrap = self::bootstrap_descriptor();
        if (is_array($bootstrap)) {
            try {
                $normalized = self::validate_descriptor($bootstrap);
                if (isset($keys[$normalized['key_id']])) {
                    self::write_state(array(
                        'active_key_id' => $normalized['key_id'],
                        'pending_key_id' => null,
                        'pending_from_key_id' => null,
                        'retired_key_ids' => array(),
                    ));
                    return $normalized['key_id'];
                }
            } catch (CCW_Error $error) {
                return '';
            }
        }
        if (count($keys) === 1) {
            $key_id = (string) array_key_first($keys);
            self::write_state(array(
                'active_key_id' => $key_id,
                'pending_key_id' => null,
                'pending_from_key_id' => null,
                'retired_key_ids' => array(),
            ));
            return $key_id;
        }
        return '';
    }

    /** @return array<string,mixed> */
    private static function read_state()
    {
        $empty = array(
            'active_key_id' => '',
            'pending_key_id' => null,
            'pending_from_key_id' => null,
            'retired_key_ids' => array(),
        );
        $stored = get_option(CCW_Config::OPTION_SIGNING_TRUST_STATE, array());
        if (!is_array($stored)) {
            return $empty;
        }
        try {
            $installation_id = CCW_Config::installation_id();
            $api_base_hash = hash('sha256', CCW_Config::api_base());
        } catch (CCW_Error $error) {
            return $empty;
        }
        if (
            !isset($stored['installation_id'], $stored['api_base_hash'])
            || !hash_equals($installation_id, (string) $stored['installation_id'])
            || !hash_equals($api_base_hash, (string) $stored['api_base_hash'])
        ) {
            return $empty;
        }
        $key_pattern = '/^ed25519-[a-f0-9]{16}$/';
        $active = (string) ($stored['active_key_id'] ?? '');
        $pending = isset($stored['pending_key_id']) ? (string) $stored['pending_key_id'] : null;
        $pending_from = isset($stored['pending_from_key_id']) ? (string) $stored['pending_from_key_id'] : null;
        $retired = is_array($stored['retired_key_ids'] ?? null) ? $stored['retired_key_ids'] : array();
        if (
            ($active !== '' && !preg_match($key_pattern, $active))
            || ($pending !== null && !preg_match($key_pattern, $pending))
            || ($pending_from !== null && !preg_match($key_pattern, $pending_from))
            || count($retired) > self::MAX_RETIRED_KEYS
        ) {
            return $empty;
        }
        $retired = array_values(array_unique(array_filter(array_map('strval', $retired), static function ($candidate) use ($key_pattern) {
            return preg_match($key_pattern, $candidate) === 1;
        })));
        return array(
            'active_key_id' => $active,
            'pending_key_id' => $pending,
            'pending_from_key_id' => $pending_from,
            'retired_key_ids' => $retired,
        );
    }

    /** @param array<string,mixed> $state */
    private static function write_state(array $state)
    {
        update_option(CCW_Config::OPTION_SIGNING_TRUST_STATE, array(
            'installation_id' => CCW_Config::installation_id(),
            'api_base_hash' => hash('sha256', CCW_Config::api_base()),
            'active_key_id' => (string) ($state['active_key_id'] ?? ''),
            'pending_key_id' => $state['pending_key_id'] ?? null,
            'pending_from_key_id' => $state['pending_from_key_id'] ?? null,
            'retired_key_ids' => array_values($state['retired_key_ids'] ?? array()),
        ), false);
    }

    /** @return array<string,mixed>|null */
    private static function bootstrap_descriptor()
    {
        $provisioned = CCW_Config::provisioned();
        if (is_array($provisioned['trust_descriptor'] ?? null)) {
            return $provisioned['trust_descriptor'];
        }
        if (!defined('CLINICACLICK_WEB_TRUST_DESCRIPTOR_JSON')) {
            return null;
        }
        $configured = json_decode((string) constant('CLINICACLICK_WEB_TRUST_DESCRIPTOR_JSON'), true);
        return is_array($configured) && isset($configured['key_id']) ? $configured : null;
    }

    /** @return array<string,mixed> */
    public static function validate_descriptor(array $descriptor)
    {
        foreach (array_keys($descriptor) as $field) {
            if (preg_match('/(?:private|secret|seed|token)/i', (string) $field)) {
                throw new CCW_Error('ccw_private_key_forbidden', 'El plugin solo admite descriptores de clave pública.');
            }
        }
        $schema_version = (int) ($descriptor['schema_version'] ?? 0);
        $algorithm = (string) ($descriptor['algorithm'] ?? '');
        $key_id = (string) ($descriptor['key_id'] ?? '');
        if ($schema_version !== 1 || $algorithm !== 'Ed25519' || !preg_match('/^ed25519-[a-f0-9]{16}$/', $key_id)) {
            throw new CCW_Error('ccw_key_descriptor_invalid', 'El descriptor de firma no es compatible.');
        }

        $raw = self::raw_public_key($descriptor);
        $der = hex2bin(self::SPKI_PREFIX_HEX) . $raw;
        $expected_key_id = 'ed25519-' . substr(hash('sha256', $der), 0, 16);
        if (!hash_equals($expected_key_id, $key_id)) {
            throw new CCW_Error('ccw_key_descriptor_id_invalid', 'El identificador de la clave pública no coincide con su contenido.');
        }

        $now = time();
        $valid_from = isset($descriptor['valid_from']) ? strtotime((string) $descriptor['valid_from']) : false;
        $valid_until = isset($descriptor['valid_until']) ? strtotime((string) $descriptor['valid_until']) : false;
        if ($valid_from !== false && $valid_from > $now + 300) {
            throw new CCW_Error('ccw_key_not_yet_valid', 'La clave de firma todavía no es válida.');
        }
        if ($valid_until !== false && $valid_until <= $now) {
            throw new CCW_Error('ccw_key_expired', 'La clave de firma ha caducado.');
        }

        $normalized = array(
            'schema_version' => 1,
            'algorithm' => 'Ed25519',
            'key_id' => $key_id,
            'public_key_base64' => base64_encode($raw),
        );
        foreach (array('valid_from', 'valid_until') as $field) {
            if (!empty($descriptor[$field])) {
                $normalized[$field] = (string) $descriptor[$field];
            }
        }
        return $normalized;
    }

    public static function raw_public_key(array $descriptor)
    {
        if (!empty($descriptor['public_key_base64'])) {
            $raw = base64_decode((string) $descriptor['public_key_base64'], true);
            if (is_string($raw) && strlen($raw) === SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
                return $raw;
            }
        }

        if (!empty($descriptor['public_key_pem'])) {
            $pem = preg_replace('/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/', '', (string) $descriptor['public_key_pem']);
            $der = base64_decode((string) $pem, true);
            $prefix = hex2bin(self::SPKI_PREFIX_HEX);
            if (is_string($der) && strlen($der) === strlen($prefix) + SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES && substr($der, 0, strlen($prefix)) === $prefix) {
                return substr($der, strlen($prefix));
            }
        }
        throw new CCW_Error('ccw_key_material_invalid', 'La clave pública Ed25519 no es válida.');
    }

    /**
     * @param mixed $payload
     * @param array<string,mixed> $envelope
     * @param array<string,array<string,mixed>>|null $keys
     */
    public static function verify_signed_payload($payload, array $envelope, array $keys = null)
    {
        if (!function_exists('sodium_crypto_sign_verify_detached')) {
            throw new CCW_Error('ccw_sodium_missing', 'El servidor necesita la extensión Sodium de PHP para verificar publicaciones.');
        }
        if (
            (int) ($envelope['signature_version'] ?? 0) !== 1
            || (string) ($envelope['algorithm'] ?? '') !== 'Ed25519'
            || !preg_match('/^ed25519-[a-f0-9]{16}$/', (string) ($envelope['key_id'] ?? ''))
            || !preg_match('/^[a-f0-9]{64}$/', (string) ($envelope['manifest_sha256'] ?? ''))
        ) {
            return false;
        }
        $canonical = CCW_JSON::canonical($payload);
        if (!hash_equals((string) $envelope['manifest_sha256'], hash('sha256', $canonical))) {
            return false;
        }
        $signature = base64_decode((string) ($envelope['signature'] ?? ''), true);
        if (!is_string($signature) || strlen($signature) !== SODIUM_CRYPTO_SIGN_BYTES) {
            return false;
        }
        $keys = $keys === null ? self::all() : $keys;
        $key_id = (string) $envelope['key_id'];
        if (!isset($keys[$key_id])) {
            return false;
        }
        $descriptor = self::validate_descriptor($keys[$key_id]);
        return sodium_crypto_sign_verify_detached($signature, $canonical, self::raw_public_key($descriptor));
    }

    /**
     * Verifies a control-plane document with exactly the descriptor accepted
     * for this desired-state response. Retired keys remain in the store only
     * so immutable local history can be inspected; they must never authorize a
     * new runtime, registry or remotely downloaded artifact.
     *
     * @param mixed $payload
     * @param array<string,mixed> $envelope
     */
    public static function verify_signed_payload_for_key($payload, array $envelope, $expected_key_id)
    {
        $expected_key_id = (string) $expected_key_id;
        if (
            !preg_match('/^ed25519-[a-f0-9]{16}$/', $expected_key_id)
            || !hash_equals($expected_key_id, (string) ($envelope['key_id'] ?? ''))
        ) {
            return false;
        }
        $keys = self::all();
        if (!isset($keys[$expected_key_id])) {
            return false;
        }
        return self::verify_signed_payload(
            $payload,
            $envelope,
            array($expected_key_id => $keys[$expected_key_id])
        );
    }
}
