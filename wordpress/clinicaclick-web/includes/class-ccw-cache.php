<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Cache
{
    /** @var string */
    private $root;

    /** @var array<string,mixed> */
    private $storage_context;

    /** @param array<string,mixed> $storage_context */
    public function __construct($root = null, array $storage_context = array())
    {
        $this->root = rtrim((string) ($root ?: CCW_Config::cache_root()), '/\\');
        $this->storage_context = $storage_context;
    }

    public function root()
    {
        return $this->root;
    }

    public function initialize()
    {
        $this->assert_storage_safe();
        foreach (array($this->root, $this->root . '/releases', $this->root . '/staging') as $directory) {
            if (!is_dir($directory) && !wp_mkdir_p($directory)) {
                throw new CCW_Error('ccw_cache_directory_failed', 'No se pudo preparar la caché local de Clinicaclick.');
            }
            if (is_link($directory)) {
                throw new CCW_Error('ccw_cache_symlink_forbidden', 'La caché local no puede ser un enlace simbólico.');
            }
        }
        $this->write_protection_files();
    }

    /** @return resource */
    public function acquire_lock()
    {
        $this->initialize();
        $handle = fopen($this->root . '/sync.lock', 'c');
        if (!is_resource($handle) || !flock($handle, LOCK_EX | LOCK_NB)) {
            if (is_resource($handle)) {
                fclose($handle);
            }
            throw new CCW_Error('ccw_sync_already_running', 'Ya hay una sincronización de Clinicaclick en curso.');
        }
        return $handle;
    }

    /** @param resource $handle */
    public function release_lock($handle)
    {
        if (is_resource($handle)) {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    public function create_staging_directory()
    {
        $this->initialize();
        try {
            $suffix = bin2hex(random_bytes(16));
        } catch (Throwable $error) {
            throw new CCW_Error('ccw_random_failed', 'No se pudo crear un staging seguro.', array(), $error);
        }
        $path = $this->root . '/staging/' . $suffix;
        if (!mkdir($path, 0700, false)) {
            throw new CCW_Error('ccw_staging_create_failed', 'No se pudo crear el staging local.');
        }
        return $path;
    }

    public function staging_file($staging, $relative_path)
    {
        $relative_path = CCW_Manifest::safe_path($relative_path);
        $staging_real = realpath($staging);
        if ($staging_real === false || strpos($staging_real, realpath($this->root . '/staging')) !== 0) {
            throw new CCW_Error('ccw_staging_path_invalid', 'El staging local no es válido.');
        }
        $target = $staging_real . '/' . $relative_path;
        $parent = dirname($target);
        if (!is_dir($parent) && !wp_mkdir_p($parent)) {
            throw new CCW_Error('ccw_staging_parent_failed', 'No se pudo preparar una carpeta del artefacto.');
        }
        if (is_link($parent)) {
            throw new CCW_Error('ccw_cache_symlink_forbidden', 'El artefacto no puede escribirse mediante enlaces simbólicos.');
        }
        return $target;
    }

    /**
     * @param array<string,mixed> $manifest
     * @return array<string,mixed>
     */
    public function promote($staging, array $manifest, array $runtime_configuration = array())
    {
        $artifact_hash = (string) $manifest['artifact_hash'];
        $release = $this->root . '/releases/' . $artifact_hash;
        $this->verify_directory($staging, $manifest, $runtime_configuration);

        if (is_dir($release)) {
            $this->verify_directory($release, $manifest, $runtime_configuration);
            $this->remove_tree($staging);
        } elseif (!rename($staging, $release)) {
            throw new CCW_Error('ccw_release_promote_failed', 'No se pudo promover el artefacto verificado.');
        }
        @chmod($release, 0750);

        $current = $this->pointer();
        $previous_hash = isset($current['active_hash']) && preg_match('/^[a-f0-9]{64}$/', (string) $current['active_hash'])
            ? (string) $current['active_hash']
            : null;
        $pointer = array(
            'schema_version' => 1,
            'installation_id' => CCW_Config::installation_id(),
            'status' => 'active',
            'active_hash' => $artifact_hash,
            'last_known_good_hash' => $previous_hash ?: $artifact_hash,
            'manifest' => $manifest,
            'runtime_configuration' => $runtime_configuration,
            'last_known_good_manifest' => $previous_hash && is_array($current['manifest'] ?? null)
                ? $current['manifest']
                : $manifest,
            'last_known_good_runtime_configuration' => $previous_hash
                ? (is_array($current['runtime_configuration'] ?? null) ? $current['runtime_configuration'] : array())
                : $runtime_configuration,
            'activated_at' => gmdate('c'),
            'manual_hold' => false,
        );
        $this->write_pointer($pointer);
        return $pointer;
    }

    /** @return array<string,mixed> */
    public function retire(array $runtime_configuration = array())
    {
        $pointer = $this->pointer();
        $pointer['schema_version'] = 1;
        $pointer['installation_id'] = CCW_Config::installation_id();
        $pointer['status'] = 'retired';
        if ($runtime_configuration !== array()) {
            $pointer['runtime_configuration'] = $runtime_configuration;
        }
        $pointer['retired_at'] = gmdate('c');
        $this->write_pointer($pointer);
        return $pointer;
    }

    /** @return array<string,mixed> */
    public function rollback_local()
    {
        $pointer = $this->pointer();
        $original_pointer = $pointer;
        $registry = $this->route_registry();
        $pilot_publication_id = null;
        foreach ($registry['routes'] as $publication_id => $entry) {
            if (
                (string) ($entry['route_prefix'] ?? '') !== '/cita/'
                || empty($entry['legacy_pilot'])
            ) {
                continue;
            }
            if ($pilot_publication_id !== null) {
                throw new CCW_Error(
                    'ccw_route_registry_invalid',
                    'El registro local contiene más de una ruta piloto.'
                );
            }
            $pilot_publication_id = (string) $publication_id;
        }
        $active = (string) ($pointer['active_hash'] ?? '');
        $lkg = (string) ($pointer['last_known_good_hash'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $active) || !preg_match('/^[a-f0-9]{64}$/', $lkg) || $active === $lkg) {
            throw new CCW_Error('ccw_rollback_unavailable', 'No hay una versión anterior disponible para rollback.');
        }
        $release = $this->root . '/releases/' . $lkg;
        if (!is_dir($release)) {
            throw new CCW_Error('ccw_rollback_release_missing', 'La última versión válida ya no está en caché.');
        }
        $pointer['active_hash'] = $lkg;
        $pointer['last_known_good_hash'] = $active;
        $active_manifest = $pointer['manifest'] ?? null;
        $lkg_manifest = $pointer['last_known_good_manifest'] ?? null;
        if (!is_array($active_manifest) || !is_array($lkg_manifest)) {
            throw new CCW_Error('ccw_rollback_manifest_missing', 'Faltan los metadatos firmados de la versión anterior.');
        }
        $pointer['manifest'] = $lkg_manifest;
        $pointer['last_known_good_manifest'] = $active_manifest;
        $active_runtime = $pointer['runtime_configuration'] ?? null;
        $lkg_runtime = $pointer['last_known_good_runtime_configuration'] ?? null;
        // A legacy LKG may predate per-release runtime persistence. Static
        // rollback must still work; the form bridge then fails closed until a
        // matching signed runtime is synchronized.
        $pointer['runtime_configuration'] = is_array($lkg_runtime) ? $lkg_runtime : array();
        $pointer['last_known_good_runtime_configuration'] = is_array($active_runtime) ? $active_runtime : array();
        $pointer['status'] = 'active';
        $pointer['manual_hold'] = true;
        $pointer['rolled_back_at'] = gmdate('c');
        if ($pilot_publication_id !== null) {
            // `/cita/` keeps its route runtime in routes.json so intake/events
            // can select it without reading the global option. Roll it back in
            // the same writer critical section as active.json. route_pointer()
            // also rejects a transient stale registry runtime by artifact hash,
            // so readers observe either the old coherent pair or the restored
            // coherent pair while the two atomic renames are performed.
            $registry['routes'][$pilot_publication_id]['runtime_configuration'] =
                $pointer['runtime_configuration'];
        }
        $this->write_pointer($pointer);
        if ($pilot_publication_id !== null) {
            try {
                $this->write_route_registry($registry);
            } catch (Throwable $error) {
                // Best-effort rollback of the first rename. Even if this write
                // also fails, route_pointer() keeps intake/events fail-closed
                // instead of combining an artifact with another runtime.
                try {
                    $this->write_pointer($original_pointer);
                } catch (Throwable $restore_error) {
                    // Preserve the first observable storage error.
                }
                throw $error;
            }
        }
        return $pointer;
    }

    public function clear_manual_hold()
    {
        $pointer = $this->pointer();
        if (!empty($pointer['manual_hold'])) {
            $pointer['manual_hold'] = false;
            $pointer['resumed_at'] = gmdate('c');
            $this->write_pointer($pointer);
        }
    }

    /**
     * Persists a newer signed runtime for an already active immutable release.
     * This keeps the server-side form scope/HMAC paired with the exact artifact
     * without exposing either value in HTML, and lets a later local rollback
     * restore the corresponding last-known-good runtime.
     */
    public function update_active_runtime(array $runtime_configuration)
    {
        $pointer = $this->pointer();
        $active_hash = (string) ($pointer['active_hash'] ?? '');
        if (
            ($pointer['status'] ?? '') !== 'active'
            || !preg_match('/^[a-f0-9]{64}$/', $active_hash)
            || !hash_equals($active_hash, (string) ($runtime_configuration['desired_artifact_hash'] ?? ''))
            || (string) ($runtime_configuration['status'] ?? '') !== 'active'
        ) {
            throw new CCW_Error('ccw_runtime_pointer_mismatch', 'La configuración firmada no corresponde a la publicación activa.');
        }
        $pointer['runtime_configuration'] = $runtime_configuration;
        $pointer['runtime_updated_at'] = gmdate('c');
        $this->write_pointer($pointer);
        return $pointer;
    }

    /** @return array<string,mixed> */
    public function pointer()
    {
        $this->assert_storage_safe();
        $path = $this->root . '/active.json';
        if (!is_file($path) || filesize($path) > 1048576) {
            return array();
        }
        $decoded = json_decode((string) file_get_contents($path), true);
        if (!is_array($decoded) || (int) ($decoded['schema_version'] ?? 0) !== 1) {
            return array();
        }
        $configured_id = CCW_Config::installation_id();
        if ($configured_id !== '' && !hash_equals($configured_id, (string) ($decoded['installation_id'] ?? ''))) {
            return array();
        }
        return $decoded;
    }

    /** @return array<string,mixed> */
    public function route_registry()
    {
        $this->assert_storage_safe();
        $path = $this->root . '/routes.json';
        if (!is_file($path) || filesize($path) > 1048576) {
            return array('schema_version' => 2, 'installation_id' => CCW_Config::installation_id(), 'sequence' => 0, 'routes' => array());
        }
        $decoded = json_decode((string) file_get_contents($path), true);
        if (
            !is_array($decoded)
            || (int) ($decoded['schema_version'] ?? 0) !== 2
            || !hash_equals(CCW_Config::installation_id(), (string) ($decoded['installation_id'] ?? ''))
            || !is_array($decoded['routes'] ?? null)
            || count($decoded['routes']) > 20
        ) {
            throw new CCW_Error('ccw_route_registry_invalid', 'El registro local de publicaciones no es válido.');
        }
        return $decoded;
    }

    public function reset_route_registry()
    {
        $this->write_route_registry(array(
            'schema_version' => 2,
            'installation_id' => CCW_Config::installation_id(),
            'sequence' => 0,
            'routes' => array(),
        ));
    }

    public function has_coherent_local_state($schema_version)
    {
        if ((int) $schema_version === 2) {
            try {
                $registry = $this->route_registry();
            } catch (CCW_Error $error) {
                return false;
            }
            if (
                (int) ($registry['sequence'] ?? 0) < 1
                || !preg_match('/^[a-f0-9]{64}$/', (string) ($registry['signed_registry_hash'] ?? ''))
            ) {
                return false;
            }
            foreach ($registry['routes'] as $publication_id => $entry) {
                $prefix = (string) ($entry['route_prefix'] ?? '');
                if (
                    (string) ($entry['publication_id'] ?? '') !== (string) $publication_id
                    || !preg_match('#^/cita/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/)?$#', $prefix)
                ) {
                    return false;
                }
                $pointer = $this->route_pointer($publication_id, $prefix);
                $status = (string) ($pointer['status'] ?? 'empty');
                if ($status === 'active' && !$this->pointer_is_coherent($pointer)) {
                    return false;
                }
                if (!in_array($status, array('active', 'retired', 'empty'), true)) {
                    return false;
                }
            }
            return true;
        }
        return $this->pointer_is_coherent($this->pointer(), true);
    }

    /**
     * Registers the legacy /cita/ pointer without touching active.json. This is
     * the upgrade bridge that keeps the real pilot byte-for-byte unchanged.
     */
    public function adopt_pilot_route($publication_id, $route_prefix, $desired_hash, array $runtime)
    {
        $pointer = $this->pointer();
        if (
            $route_prefix !== '/cita/'
            || ($pointer['status'] ?? '') !== 'active'
            || !hash_equals((string) ($pointer['active_hash'] ?? ''), (string) $desired_hash)
        ) {
            return null;
        }
        $registry = $this->route_registry();
        $registry['routes'][$publication_id] = array(
            'publication_id' => $publication_id,
            'route_prefix' => '/cita/',
            'legacy_pilot' => true,
            'runtime_configuration' => $runtime,
        );
        $this->write_route_registry($registry);
        return $this->route_pointer($publication_id, '/cita/');
    }

    /** @return array<string,mixed> */
    public function route_pointer($publication_id, $route_prefix = null)
    {
        $registry = $this->route_registry();
        $entry = is_array($registry['routes'][$publication_id] ?? null) ? $registry['routes'][$publication_id] : array();
        $prefix = $route_prefix ?: (string) ($entry['route_prefix'] ?? '');
        if ($prefix === '/cita/' && !empty($entry['legacy_pilot'])) {
            $pointer = $this->pointer();
            $route_runtime = is_array($entry['runtime_configuration'] ?? null)
                ? $entry['runtime_configuration'] : array();
            if (($pointer['status'] ?? '') !== 'active') {
                if ($route_runtime !== array()) $pointer['runtime_configuration'] = $route_runtime;
                return $pointer;
            }
            $active_hash = (string) ($pointer['active_hash'] ?? '');
            $pointer_runtime = is_array($pointer['runtime_configuration'] ?? null)
                ? $pointer['runtime_configuration'] : array();
            if (
                preg_match('/^[a-f0-9]{64}$/', $active_hash)
                && hash_equals($active_hash, (string) ($route_runtime['desired_artifact_hash'] ?? ''))
            ) {
                $pointer['runtime_configuration'] = $route_runtime;
            } elseif (
                !preg_match('/^[a-f0-9]{64}$/', $active_hash)
                || !hash_equals($active_hash, (string) ($pointer_runtime['desired_artifact_hash'] ?? ''))
            ) {
                // Never combine the active pilot artifact with a runtime from
                // another release. The bridges will fail closed until a signed
                // sync repairs the pair.
                $pointer['runtime_configuration'] = array();
            }
            return $pointer;
        }
        return is_array($entry['pointer'] ?? null) ? $entry['pointer'] : array();
    }

    /** @return array<string,mixed> */
    public function promote_route($publication_id, $route_prefix, $staging, array $manifest, array $runtime)
    {
        if ($route_prefix === '/cita/') {
            $pointer = $this->promote($staging, $manifest, $runtime);
            $registry = $this->route_registry();
            $registry['routes'][$publication_id] = array(
                'publication_id' => $publication_id,
                'route_prefix' => '/cita/',
                'legacy_pilot' => true,
                'runtime_configuration' => $runtime,
            );
            $this->write_route_registry($registry);
            return $pointer;
        }
        $artifact_hash = (string) $manifest['artifact_hash'];
        $release = $this->root . '/releases/' . $artifact_hash;
        $this->verify_directory($staging, $manifest, $runtime);
        if (is_dir($release)) {
            $this->verify_directory($release, $manifest, $runtime);
            $this->remove_tree($staging);
        } elseif (!rename($staging, $release)) {
            throw new CCW_Error('ccw_release_promote_failed', 'No se pudo promover el artefacto verificado.');
        }
        @chmod($release, 0750);
        $current = $this->route_pointer($publication_id, $route_prefix);
        $previous_hash = preg_match('/^[a-f0-9]{64}$/', (string) ($current['active_hash'] ?? ''))
            ? (string) $current['active_hash'] : null;
        $pointer = array(
            'schema_version' => 1,
            'installation_id' => CCW_Config::installation_id(),
            'status' => 'active',
            'active_hash' => $artifact_hash,
            'last_known_good_hash' => $previous_hash ?: $artifact_hash,
            'manifest' => $manifest,
            'runtime_configuration' => $runtime,
            'last_known_good_manifest' => $previous_hash && is_array($current['manifest'] ?? null) ? $current['manifest'] : $manifest,
            'last_known_good_runtime_configuration' => $previous_hash && is_array($current['runtime_configuration'] ?? null)
                ? $current['runtime_configuration'] : $runtime,
            'activated_at' => gmdate('c'),
            'manual_hold' => false,
        );
        $registry = $this->route_registry();
        $registry['routes'][$publication_id] = array(
            'publication_id' => $publication_id,
            'route_prefix' => $route_prefix,
            'legacy_pilot' => false,
            'pointer' => $pointer,
        );
        $this->write_route_registry($registry);
        return $pointer;
    }

    public function retire_route($publication_id, $route_prefix, array $runtime = array())
    {
        $registry = $this->route_registry();
        if ($route_prefix === '/cita/') {
            $pointer = $this->retire($runtime);
            $registry['routes'][$publication_id] = array(
                'publication_id' => $publication_id,
                'route_prefix' => '/cita/',
                'legacy_pilot' => true,
                'runtime_configuration' => $runtime,
            );
        } else {
            $pointer = $this->route_pointer($publication_id, $route_prefix);
            $pointer['schema_version'] = 1;
            $pointer['installation_id'] = CCW_Config::installation_id();
            $pointer['status'] = 'retired';
            $pointer['runtime_configuration'] = $runtime;
            $pointer['retired_at'] = gmdate('c');
            $registry['routes'][$publication_id] = array(
                'publication_id' => $publication_id,
                'route_prefix' => $route_prefix,
                'legacy_pilot' => false,
                'pointer' => $pointer,
            );
        }
        $this->write_route_registry($registry);
        return $pointer;
    }

    public function register_pending_route($publication_id, $route_prefix, array $runtime)
    {
        $registry = $this->route_registry();
        if ($route_prefix === '/cita/') {
            $entry = is_array($registry['routes'][$publication_id] ?? null) ? $registry['routes'][$publication_id] : array();
            $registry['routes'][$publication_id] = array_merge($entry, array(
                'publication_id' => $publication_id,
                'route_prefix' => '/cita/',
                'legacy_pilot' => true,
                'runtime_configuration' => $runtime,
            ));
        } elseif (!isset($registry['routes'][$publication_id])) {
            $registry['routes'][$publication_id] = array(
                'publication_id' => $publication_id,
                'route_prefix' => $route_prefix,
                'legacy_pilot' => false,
                'pointer' => array(
                    'schema_version' => 1,
                    'installation_id' => CCW_Config::installation_id(),
                    'status' => 'empty',
                    'runtime_configuration' => $runtime,
                    'manual_hold' => false,
                ),
            );
        }
        $this->write_route_registry($registry);
        return $this->route_pointer($publication_id, $route_prefix);
    }

    public function update_route_runtime($publication_id, $route_prefix, array $runtime)
    {
        $pointer = $this->route_pointer($publication_id, $route_prefix);
        $active_hash = (string) ($pointer['active_hash'] ?? '');
        if (($pointer['status'] ?? '') !== 'active' || !hash_equals($active_hash, (string) ($runtime['desired_artifact_hash'] ?? ''))) {
            throw new CCW_Error('ccw_runtime_pointer_mismatch', 'La configuración firmada no corresponde a la publicación activa.');
        }
        $registry = $this->route_registry();
        if ($route_prefix === '/cita/') {
            $entry = is_array($registry['routes'][$publication_id] ?? null) ? $registry['routes'][$publication_id] : array();
            $registry['routes'][$publication_id] = array_merge($entry, array(
                'publication_id' => $publication_id,
                'route_prefix' => '/cita/',
                'legacy_pilot' => true,
                'runtime_configuration' => $runtime,
            ));
        } else {
            $pointer['runtime_configuration'] = $runtime;
            $pointer['runtime_updated_at'] = gmdate('c');
            $registry['routes'][$publication_id]['pointer'] = $pointer;
        }
        $this->write_route_registry($registry);
        return $this->route_pointer($publication_id, $route_prefix);
    }

    public function set_registry_sequence($sequence, $registry_hash = null)
    {
        $registry = $this->route_registry();
        $registry['sequence'] = (int) $sequence;
        if (is_string($registry_hash) && preg_match('/^[a-f0-9]{64}$/', $registry_hash)) {
            $registry['signed_registry_hash'] = $registry_hash;
        }
        $this->write_route_registry($registry);
    }

    public function retain_registry_routes(array $publication_ids)
    {
        $allowed = array_fill_keys(array_map('strval', $publication_ids), true);
        $registry = $this->route_registry();
        $filtered = array_intersect_key($registry['routes'], $allowed);
        if (count($filtered) !== count($registry['routes'])) {
            $registry['routes'] = $filtered;
            $this->write_route_registry($registry);
        }
    }

    public function clear_route_manual_hold($publication_id, $route_prefix)
    {
        if ($route_prefix === '/cita/') {
            $this->clear_manual_hold();
            return;
        }
        $registry = $this->route_registry();
        $pointer = $this->route_pointer($publication_id, $route_prefix);
        if (!empty($pointer['manual_hold'])) {
            $pointer['manual_hold'] = false;
            $pointer['resumed_at'] = gmdate('c');
            $registry['routes'][$publication_id]['pointer'] = $pointer;
            $this->write_route_registry($registry);
        }
    }

    public function rollback_route($publication_id, $route_prefix)
    {
        if ($route_prefix === '/cita/') return $this->rollback_local();
        $registry = $this->route_registry();
        $pointer = $this->route_pointer($publication_id, $route_prefix);
        $active = (string) ($pointer['active_hash'] ?? '');
        $lkg = (string) ($pointer['last_known_good_hash'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $active) || !preg_match('/^[a-f0-9]{64}$/', $lkg) || $active === $lkg) {
            throw new CCW_Error('ccw_rollback_unavailable', 'No hay una versión anterior disponible para rollback.');
        }
        if (!is_dir($this->root . '/releases/' . $lkg)) {
            throw new CCW_Error('ccw_rollback_release_missing', 'La última versión válida ya no está en caché.');
        }
        $active_manifest = $pointer['manifest'] ?? null;
        $lkg_manifest = $pointer['last_known_good_manifest'] ?? null;
        if (!is_array($active_manifest) || !is_array($lkg_manifest)) {
            throw new CCW_Error('ccw_rollback_manifest_missing', 'Faltan los metadatos firmados de la versión anterior.');
        }
        $active_runtime = $pointer['runtime_configuration'] ?? array();
        $lkg_runtime = $pointer['last_known_good_runtime_configuration'] ?? array();
        $pointer['active_hash'] = $lkg;
        $pointer['last_known_good_hash'] = $active;
        $pointer['manifest'] = $lkg_manifest;
        $pointer['last_known_good_manifest'] = $active_manifest;
        $pointer['runtime_configuration'] = is_array($lkg_runtime) ? $lkg_runtime : array();
        $pointer['last_known_good_runtime_configuration'] = is_array($active_runtime) ? $active_runtime : array();
        $pointer['status'] = 'active';
        $pointer['manual_hold'] = true;
        $pointer['rolled_back_at'] = gmdate('c');
        $registry['routes'][$publication_id]['pointer'] = $pointer;
        $this->write_route_registry($registry);
        return $pointer;
    }

    /** @return array<string,array<string,mixed>> */
    public function route_report()
    {
        $registry = $this->route_registry();
        $result = array();
        foreach ($registry['routes'] as $publication_id => $entry) {
            $pointer = $this->route_pointer($publication_id, (string) ($entry['route_prefix'] ?? ''));
            $result[$publication_id] = array(
                'publication_id' => $publication_id,
                'route_prefix' => (string) ($entry['route_prefix'] ?? ''),
                'status' => (string) ($pointer['status'] ?? 'empty'),
                'active_artifact_hash' => ($pointer['status'] ?? '') === 'active' ? ($pointer['active_hash'] ?? null) : null,
            );
        }
        return $result;
    }

    /**
     * @return array{publication_id:string,route_prefix:string,relative_path:string,pointer:array<string,mixed>}|null
     */
    public function match_route($request_path)
    {
        $path = '/' . ltrim((string) $request_path, '/');
        $registry = $this->route_registry();
        $entries = array_values($registry['routes']);
        usort($entries, static function ($left, $right) {
            return strlen((string) ($right['route_prefix'] ?? '')) <=> strlen((string) ($left['route_prefix'] ?? ''));
        });
        foreach ($entries as $entry) {
            $prefix = (string) ($entry['route_prefix'] ?? '');
            $base = rtrim($prefix, '/');
            if ($prefix === '' || ($path !== $base && strpos($path, $prefix) !== 0)) continue;
            $relative = ltrim(substr($path, strlen($base)), '/');
            return array(
                'publication_id' => (string) $entry['publication_id'],
                'route_prefix' => $prefix,
                'relative_path' => $relative,
                'pointer' => $this->route_pointer((string) $entry['publication_id'], $prefix),
            );
        }
        return null;
    }

    public function resolve_pointer(array $pointer, $request_path)
    {
        $this->assert_storage_safe();
        if (($pointer['status'] ?? '') !== 'active') return null;
        $manifest = $pointer['manifest'] ?? null;
        if (!is_array($manifest) || !is_array($manifest['files'] ?? null)) return null;
        $path = CCW_Manifest::safe_path($request_path);
        if (!isset($manifest['files'][$path])) return null;
        $hash = (string) ($pointer['active_hash'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $hash)) return null;
        $release_root = realpath($this->root . '/releases/' . $hash);
        $file = realpath($this->root . '/releases/' . $hash . '/' . $path);
        if ($release_root === false || $file === false || strpos($file, $release_root . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) return null;
        $metadata = $manifest['files'][$path];
        if (filesize($file) !== (int) ($metadata['size_bytes'] ?? -1) || !hash_equals((string) ($metadata['sha256'] ?? ''), hash_file('sha256', $file))) return null;
        return array(
            'path' => $file,
            'content_type' => (string) $metadata['content_type'],
            'headers' => is_array($manifest['headers'] ?? null) ? $manifest['headers'] : array(),
            'artifact_hash' => $hash,
        );
    }

    /**
     * @return array{path:string,content_type:string,headers:array<string,string>,artifact_hash:string}|null
     */
    public function resolve($request_path)
    {
        return $this->resolve_pointer($this->pointer(), $request_path);
    }

    /**
     * Called only while sync.lock is held. Keeps every active and LKG release
     * referenced by the legacy pilot or any v2 route; stale immutable releases
     * are removed without touching staging.
     *
     * @return array<int,string>
     */
    public function prune_releases()
    {
        $keep = array();
        $pointers = array($this->pointer());
        $registry = $this->route_registry();
        foreach ($registry['routes'] as $publication_id => $entry) {
            $pointers[] = $this->route_pointer($publication_id, (string) ($entry['route_prefix'] ?? ''));
        }
        foreach ($pointers as $pointer) {
            foreach (array('active_hash', 'last_known_good_hash') as $field) {
                $hash = (string) ($pointer[$field] ?? '');
                if (preg_match('/^[a-f0-9]{64}$/', $hash)) {
                    $keep[$hash] = true;
                }
            }
        }
        $removed = array();
        $release_root = $this->root . '/releases';
        foreach (is_dir($release_root) ? (scandir($release_root) ?: array()) : array() as $entry) {
            if (!preg_match('/^[a-f0-9]{64}$/', (string) $entry) || isset($keep[$entry])) continue;
            $path = $release_root . '/' . $entry;
            if (!is_dir($path) || is_link($path)) continue;
            $this->remove_tree($path);
            if (!is_dir($path)) $removed[] = $entry;
        }
        sort($removed, SORT_STRING);
        return $removed;
    }

    public function remove_tree($path)
    {
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
                $this->remove_tree($child);
            } else {
                @unlink($child);
            }
        }
        @rmdir($path);
    }

    private function pointer_is_coherent(array $pointer, $allow_retired = false)
    {
        $status = (string) ($pointer['status'] ?? '');
        if ($allow_retired && $status === 'retired') {
            return true;
        }
        if ($status !== 'active') {
            return false;
        }
        $hash = (string) ($pointer['active_hash'] ?? '');
        $manifest = $pointer['manifest'] ?? null;
        if (!preg_match('/^[a-f0-9]{64}$/', $hash) || !is_array($manifest) || !is_array($manifest['files'] ?? null)) {
            return false;
        }
        $release_root = realpath($this->root . '/releases/' . $hash);
        if ($release_root === false || !is_dir($release_root)) {
            return false;
        }
        foreach ($manifest['files'] as $path => $metadata) {
            try {
                $path = CCW_Manifest::safe_path($path);
            } catch (CCW_Error $error) {
                return false;
            }
            $file = realpath($this->root . '/releases/' . $hash . '/' . $path);
            if (
                $file === false
                || strpos($file, $release_root . DIRECTORY_SEPARATOR) !== 0
                || !is_file($file)
                || filesize($file) !== (int) ($metadata['size_bytes'] ?? -1)
                || !hash_equals((string) ($metadata['sha256'] ?? ''), (string) hash_file('sha256', $file))
            ) {
                return false;
            }
        }
        return true;
    }

    private function write_pointer(array $pointer)
    {
        $this->initialize();
        $temporary = $this->root . '/active.' . bin2hex(random_bytes(8)) . '.tmp';
        $json = CCW_JSON::canonical($pointer);
        if (file_put_contents($temporary, $json, LOCK_EX) !== strlen($json)) {
            @unlink($temporary);
            throw new CCW_Error('ccw_pointer_write_failed', 'No se pudo guardar el puntero de publicación.');
        }
        @chmod($temporary, 0600);
        if (!rename($temporary, $this->root . '/active.json')) {
            @unlink($temporary);
            throw new CCW_Error('ccw_pointer_switch_failed', 'No se pudo conmutar la publicación de forma atómica.');
        }
    }

    private function write_route_registry(array $registry)
    {
        $this->initialize();
        $registry['schema_version'] = 2;
        $registry['installation_id'] = CCW_Config::installation_id();
        ksort($registry['routes'], SORT_STRING);
        $temporary = $this->root . '/routes.' . bin2hex(random_bytes(8)) . '.tmp';
        $json = CCW_JSON::canonical($registry);
        if (file_put_contents($temporary, $json, LOCK_EX) !== strlen($json)) {
            @unlink($temporary);
            throw new CCW_Error('ccw_route_registry_write_failed', 'No se pudo guardar el registro de publicaciones.');
        }
        @chmod($temporary, 0600);
        if (!rename($temporary, $this->root . '/routes.json')) {
            @unlink($temporary);
            throw new CCW_Error('ccw_route_registry_switch_failed', 'No se pudo conmutar el registro de publicaciones.');
        }
    }

    private function verify_directory($directory, array $manifest, array $runtime_configuration = array())
    {
        foreach ($manifest['files'] as $path => $metadata) {
            $file = rtrim($directory, '/\\') . '/' . CCW_Manifest::safe_path($path);
            CCW_Manifest::inspect_file($path, $file, $metadata, $runtime_configuration, $manifest);
        }
    }

    private function write_protection_files()
    {
        $files = array(
            $this->root . '/index.php' => "<?php\nhttp_response_code(404);\nexit;\n",
            $this->root . '/.htaccess' => "Require all denied\nDeny from all\n",
            $this->root . '/web.config' => '<?xml version="1.0"?><configuration><system.webServer><authorization><deny users="*" /></authorization></system.webServer></configuration>',
        );
        foreach ($files as $path => $contents) {
            if (!is_file($path)) {
                @file_put_contents($path, $contents, LOCK_EX);
            }
        }
    }

    private function assert_storage_safe()
    {
        CCW_Config::assert_cache_storage_safe($this->root, $this->storage_context);
    }
}
