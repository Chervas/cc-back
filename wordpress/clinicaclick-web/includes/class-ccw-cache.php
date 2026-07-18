<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Cache
{
    /** @var string */
    private $root;

    public function __construct($root = null)
    {
        $this->root = rtrim((string) ($root ?: CCW_Config::cache_root()), '/\\');
    }

    public function root()
    {
        return $this->root;
    }

    public function initialize()
    {
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
        $this->write_pointer($pointer);
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

    /**
     * @return array{path:string,content_type:string,headers:array<string,string>,artifact_hash:string}|null
     */
    public function resolve($request_path)
    {
        $pointer = $this->pointer();
        if (($pointer['status'] ?? '') !== 'active') {
            return null;
        }
        $manifest = $pointer['manifest'] ?? null;
        if (!is_array($manifest) || !is_array($manifest['files'] ?? null)) {
            return null;
        }
        $path = CCW_Manifest::safe_path($request_path);
        if (!isset($manifest['files'][$path])) {
            return null;
        }
        $hash = (string) ($pointer['active_hash'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $hash)) {
            return null;
        }
        $release_root = realpath($this->root . '/releases/' . $hash);
        $file = realpath($this->root . '/releases/' . $hash . '/' . $path);
        if ($release_root === false || $file === false || strpos($file, $release_root . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) {
            return null;
        }
        $metadata = $manifest['files'][$path];
        if (filesize($file) !== (int) ($metadata['size_bytes'] ?? -1) || !hash_equals((string) ($metadata['sha256'] ?? ''), hash_file('sha256', $file))) {
            return null;
        }
        return array(
            'path' => $file,
            'content_type' => (string) $metadata['content_type'],
            'headers' => is_array($manifest['headers'] ?? null) ? $manifest['headers'] : array(),
            'artifact_hash' => $hash,
        );
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
}
