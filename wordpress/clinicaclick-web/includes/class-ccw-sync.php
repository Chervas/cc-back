<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Sync
{
    const MAX_V2_UNIQUE_FILES = 400;
    const MAX_V2_DOWNLOAD_REQUESTS = 500;

    /** @var CCW_HTTP */
    private $http;

    /** @var CCW_Cache */
    private $cache;

    public function __construct(CCW_HTTP $http = null, CCW_Cache $cache = null)
    {
        $this->http = $http ?: new CCW_HTTP();
        $this->cache = $cache ?: new CCW_Cache();
    }

    /** @return array<string,mixed> */
    public function run($force = false)
    {
        $started = microtime(true);
        $staging = null;
        $lock = null;
        $request_id = null;
        $desired_hash = null;
        $is_v2 = false;
        $registry = null;
        $capability_handshake_acknowledged = false;

        try {
            if (!CCW_Config::is_configured()) {
                throw new CCW_Error('ccw_not_configured', 'Completa la configuración de ClinicaClick antes de sincronizar.');
            }
            $lock = $this->cache->acquire_lock();
            $pointer = $this->cache->pointer();
            try {
                $local_registry = $this->cache->route_registry();
            } catch (CCW_Error $error) {
                if ($error->error_code() !== 'ccw_route_registry_invalid') {
                    throw $error;
                }
                // A signed 200 response can rebuild this control file. Never
                // keep sending an ETag against a corrupt/missing local state.
                $this->cache->reset_route_registry();
                $local_registry = $this->cache->route_registry();
            }
            $bootstrap_state = CCW_Config::sync_state();
            $installation_id = CCW_Config::installation_id();
            $handshake_installation_id = (string) ($bootstrap_state['v2_capability_handshake_installation_id'] ?? '');
            if (
                (int) ($local_registry['sequence'] ?? 0) === 0
                && empty($local_registry['routes'])
                && (
                    empty($bootstrap_state['v2_capability_handshake_at'])
                    || !hash_equals($installation_id, $handshake_installation_id)
                )
            ) {
                $capability_handshake_acknowledged = $this->http->report(array(
                    'schema_version' => 2,
                    'event' => 'heartbeat',
                    'plugin_version' => CCW_VERSION,
                    'wordpress_version' => get_bloginfo('version'),
                    'php_version' => PHP_VERSION,
                    'site_hash' => hash('sha256', home_url('/')),
                    'capabilities' => array('multi_publication_v2' => true),
                    'registry_sequence' => 0,
                    'routes' => array(),
                    'duration_ms' => 0,
                    'reported_at' => gmdate('c'),
                ));
                if ($capability_handshake_acknowledged) {
                    $bootstrap_state['v2_capability_handshake_at'] = gmdate('c');
                    $bootstrap_state['v2_capability_handshake_installation_id'] = $installation_id;
                    CCW_Config::set_sync_state($bootstrap_state);
                }
            }
            if (!empty($pointer['manual_hold']) && empty($local_registry['routes']) && !$force) {
                $result = $this->success('manual_hold', $pointer, $started, null);
                $this->maybe_heartbeat($result);
                return $result;
            }

            $sync_state = CCW_Config::sync_state();
            $local_schema = (int) ($sync_state['schema_version'] ?? 0);
            if (!in_array($local_schema, array(1, 2), true)) {
                $local_schema = (int) ($local_registry['sequence'] ?? 0) > 0 ? 2 : 1;
            }
            $can_revalidate = !$force && $this->cache->has_coherent_local_state($local_schema);
            $response = $this->http->desired_state($can_revalidate ? (string) ($sync_state['etag'] ?? '') : '');
            if ($response === null) {
                $result = $this->success('not_modified', $pointer, $started, null);
                $sync_state['last_attempt_at'] = gmdate('c');
                $sync_state['last_result'] = 'not_modified';
                CCW_Config::set_sync_state($sync_state);
                if ((int) ($local_registry['sequence'] ?? 0) > 0) {
                    $this->maybe_heartbeat_v2($result);
                } else {
                    $this->maybe_heartbeat($result);
                }
                return $result;
            }
            $request_id = self::safe_request_id($response['request_id'] ?? null);
            if ((int) ($response['schema_version'] ?? 0) === 2) {
                $is_v2 = true;
                $result = $this->run_v2($response, $force, $started, $request_id);
                return $result;
            }
            if ($capability_handshake_acknowledged && !empty($pointer['active_hash'])) {
                throw new CCW_Error(
                    'ccw_capability_handshake_pending',
                    'La instalación está completando la actualización multi-publicación.'
                );
            }
            $desired = $this->validate_desired_state($response);
            $desired_hash = $desired['status'] === 'published' ? (string) $desired['artifact_hash'] : null;

            $accepted_signing_descriptor = CCW_Trust_Store::trust_remote_descriptor(
                $desired['signing_key_descriptor'],
                $desired['signing_key_descriptor_envelope']
            );
            $runtime = CCW_Manifest::verify_runtime_configuration(
                $desired['runtime_configuration'],
                $desired['runtime_configuration_envelope'],
                CCW_Config::installation_id(),
                $accepted_signing_descriptor['key_id']
            );
            $this->assert_runtime_sequence($runtime, CCW_Config::runtime_configuration());
            if ($runtime['status'] === 'active' && !hash_equals((string) $runtime['desired_artifact_hash'], (string) $desired_hash)) {
                throw new CCW_Error('ccw_desired_artifact_signature_mismatch', 'El artefacto deseado no coincide con la configuración firmada.');
            }
            if ($runtime['status'] === 'retired' && $desired['status'] !== 'retired') {
                throw new CCW_Error('ccw_desired_status_signature_mismatch', 'El estado deseado no coincide con la configuración firmada.');
            }

            if ($desired['status'] === 'retired') {
                $pointer = $this->cache->retire($runtime);
                CCW_Config::set_runtime_configuration($runtime);
                if ($force) {
                    $this->cache->clear_manual_hold();
                }
                CCW_Trust_Store::promote_remote_descriptor($accepted_signing_descriptor['key_id']);
                return $this->finish_and_report(
                    'retired',
                    $pointer,
                    $started,
                    $request_id,
                    $response['_http_etag'] ?? '',
                    $accepted_signing_descriptor['key_id'],
                    (int) $runtime['sequence']
                );
            }

            if (($pointer['status'] ?? '') === 'active' && hash_equals((string) ($pointer['active_hash'] ?? ''), $desired_hash)) {
                CCW_Manifest::assert_runtime_binding(
                    is_array($pointer['manifest'] ?? null) ? $pointer['manifest'] : array(),
                    $runtime
                );
                $pointer = $this->cache->update_active_runtime($runtime);
                CCW_Config::set_runtime_configuration($runtime);
                if ($force) {
                    $this->cache->clear_manual_hold();
                    $pointer = $this->cache->pointer();
                }
                CCW_Trust_Store::promote_remote_descriptor($accepted_signing_descriptor['key_id']);
                return $this->finish_and_report(
                    'already_current',
                    $pointer,
                    $started,
                    $request_id,
                    $response['_http_etag'] ?? '',
                    $accepted_signing_descriptor['key_id'],
                    (int) $runtime['sequence']
                );
            }

            $manifest = $this->http->get_json($desired['manifest_url'], 'ccw_manifest');
            $envelope = $this->http->get_json($desired['envelope_url'], 'ccw_manifest_envelope');
            $manifest = CCW_Manifest::verify(
                $manifest,
                $envelope,
                $desired_hash,
                $runtime,
                $accepted_signing_descriptor['key_id']
            );
            $this->assert_download_set($manifest, $desired['files'], $desired['manifest_url'], $desired['envelope_url']);

            $staging = $this->cache->create_staging_directory();
            $paths = array_keys($manifest['files']);
            sort($paths, SORT_STRING);
            foreach ($paths as $path) {
                $target = $this->cache->staging_file($staging, $path);
                $metadata = $manifest['files'][$path];
                $this->http->download_file($desired['files'][$path], $target, $metadata['size_bytes']);
                CCW_Manifest::inspect_file($path, $target, $metadata, $runtime, $manifest);
                @chmod($target, 0640);
            }

            $pointer = $this->cache->promote($staging, $manifest, $runtime);
            $staging = null;
            CCW_Config::set_runtime_configuration($runtime);
            if ($force) {
                $this->cache->clear_manual_hold();
                $pointer = $this->cache->pointer();
            }
            CCW_Trust_Store::promote_remote_descriptor($accepted_signing_descriptor['key_id']);
            return $this->finish_and_report(
                'activated',
                $pointer,
                $started,
                $request_id,
                $response['_http_etag'] ?? '',
                $accepted_signing_descriptor['key_id'],
                (int) $runtime['sequence']
            );
        } catch (CCW_Error $error) {
            if ($staging !== null) {
                $this->cache->remove_tree($staging);
            }
            $state = CCW_Config::sync_state();
            $state['last_attempt_at'] = gmdate('c');
            $state['last_result'] = 'failed';
            $state['last_error_code'] = $error->error_code();
            CCW_Config::set_sync_state($state);
            $this->http->report($is_v2
                ? $this->report_payload_v2('sync_failed', $started, $request_id, $registry, $error->error_code())
                : $this->report_payload('sync_failed', $started, $request_id, $desired_hash, $error->error_code()));
            throw $error;
        } catch (Throwable $error) {
            if ($staging !== null) {
                $this->cache->remove_tree($staging);
            }
            $wrapped = new CCW_Error('ccw_sync_internal_error', 'La sincronización no pudo completarse de forma segura.', array(), $error);
            $state = CCW_Config::sync_state();
            $state['last_attempt_at'] = gmdate('c');
            $state['last_result'] = 'failed';
            $state['last_error_code'] = $wrapped->error_code();
            CCW_Config::set_sync_state($state);
            $this->http->report($is_v2
                ? $this->report_payload_v2('sync_failed', $started, $request_id, $registry, $wrapped->error_code())
                : $this->report_payload('sync_failed', $started, $request_id, $desired_hash, $wrapped->error_code()));
            throw $wrapped;
        } finally {
            if ($lock !== null) {
                $this->cache->release_lock($lock);
            }
        }
    }

    /** @return array<string,mixed> */
    private function run_v2(array $response, $force, $started, $request_id)
    {
        $desired = $this->validate_desired_state_v2($response);
        $accepted_signing_descriptor = CCW_Trust_Store::trust_remote_descriptor(
            $desired['signing_key_descriptor'],
            $desired['signing_key_descriptor_envelope']
        );
        $registry = CCW_Manifest::verify_registry_configuration(
            $desired['registry_configuration'],
            $desired['registry_configuration_envelope'],
            CCW_Config::installation_id(),
            $accepted_signing_descriptor['key_id']
        );
        $expected_artifacts = array_values(array_unique(array_filter(array_map(static function ($route) {
            return $route['status'] === 'active' ? (string) $route['desired_artifact_hash'] : null;
        }, $registry['routes']))));
        $actual_artifacts = array_keys($desired['artifacts']);
        sort($expected_artifacts, SORT_STRING);
        sort($actual_artifacts, SORT_STRING);
        if ($expected_artifacts !== $actual_artifacts) {
            throw new CCW_Error('ccw_desired_artifact_set_mismatch', 'Los artefactos no coinciden con el registro firmado.');
        }
        $unique_files = 0;
        foreach ($desired['artifacts'] as $bundle) {
            $unique_files += count($bundle['files']);
        }
        $download_requests = 0;
        foreach ($registry['routes'] as $route) {
            if ($route['status'] !== 'active') continue;
            $hash = (string) $route['desired_artifact_hash'];
            $download_requests += count($desired['artifacts'][$hash]['files']) + 2;
        }
        if (
            $unique_files > self::MAX_V2_UNIQUE_FILES
            || $download_requests > self::MAX_V2_DOWNLOAD_REQUESTS
        ) {
            throw new CCW_Error(
                'ccw_transport_budget_exceeded',
                'Las publicaciones superan el presupuesto seguro de sincronización.'
            );
        }
        $local = $this->cache->route_registry();
        $registry_hash = hash('sha256', CCW_JSON::canonical($registry));
        $local_sequence = (int) ($local['sequence'] ?? 0);
        if ((int) $registry['sequence'] < $local_sequence) {
            throw new CCW_Error('ccw_registry_replay_blocked', 'Se ha rechazado un registro firmado anterior.');
        }
        if (
            (int) $registry['sequence'] === $local_sequence
            && !empty($local['signed_registry_hash'])
            && !hash_equals((string) $local['signed_registry_hash'], $registry_hash)
        ) {
            throw new CCW_Error('ccw_registry_sequence_conflict', 'La misma secuencia contiene un registro distinto.');
        }

        // Remove only signed-absent routes that are already locally retired,
        // before adding replacements. This keeps the on-disk registry within
        // the same 20-route cap during a 20 -> retire 1 + add 1 transition.
        $expected_route_ids = array_fill_keys(array_keys($registry['routes']), true);
        foreach ($local['routes'] as $local_publication_id => $local_entry) {
            if (isset($expected_route_ids[$local_publication_id])) continue;
            $local_pointer = $this->cache->route_pointer(
                $local_publication_id,
                (string) ($local_entry['route_prefix'] ?? '')
            );
            if (($local_pointer['status'] ?? '') !== 'retired') {
                throw new CCW_Error(
                    'ccw_registry_route_removal_unsafe',
                    'Una ruta activa no puede desaparecer del registro firmado sin retirarse primero.'
                );
            }
        }
        $this->cache->retain_registry_routes(array_keys($registry['routes']));
        $local = $this->cache->route_registry();

        $route_results = array();
        foreach ($registry['routes'] as $publication_id => $route) {
            $runtime = CCW_Manifest::route_runtime($registry, $route);
            $pointer = $route['route_prefix'] === '/cita/' && empty($local['routes'][$publication_id])
                ? $this->cache->pointer()
                : $this->cache->route_pointer($publication_id, $route['route_prefix']);
            try {
                if (!empty($pointer['manual_hold']) && !$force) {
                    $route_results[$publication_id] = array('result' => 'manual_hold', 'error_code' => null);
                    continue;
                }
                if ($route['status'] === 'pending') {
                    $this->cache->register_pending_route($publication_id, $route['route_prefix'], $runtime);
                    $route_results[$publication_id] = array('result' => 'pending', 'error_code' => null);
                    continue;
                }
                if ($route['status'] === 'retired') {
                    $this->cache->retire_route($publication_id, $route['route_prefix'], $runtime);
                    if ($force) $this->cache->clear_route_manual_hold($publication_id, $route['route_prefix']);
                    $route_results[$publication_id] = array('result' => 'retired', 'error_code' => null);
                    continue;
                }

                $desired_hash = (string) $route['desired_artifact_hash'];
                if (
                    $route['route_prefix'] === '/cita/'
                    && empty($local['routes'][$publication_id])
                    && ($pointer['status'] ?? '') === 'active'
                    && hash_equals((string) ($pointer['active_hash'] ?? ''), $desired_hash)
                ) {
                    CCW_Manifest::assert_runtime_binding(
                        is_array($pointer['manifest'] ?? null) ? $pointer['manifest'] : array(),
                        $runtime
                    );
                    $this->cache->adopt_pilot_route($publication_id, '/cita/', $desired_hash, $runtime);
                    $route_results[$publication_id] = array('result' => 'adopted_pilot', 'error_code' => null);
                    continue;
                }
                if (($pointer['status'] ?? '') === 'active' && hash_equals((string) ($pointer['active_hash'] ?? ''), $desired_hash)) {
                    CCW_Manifest::assert_runtime_binding(
                        is_array($pointer['manifest'] ?? null) ? $pointer['manifest'] : array(),
                        $runtime
                    );
                    $this->cache->update_route_runtime($publication_id, $route['route_prefix'], $runtime);
                    if ($force) $this->cache->clear_route_manual_hold($publication_id, $route['route_prefix']);
                    $route_results[$publication_id] = array('result' => 'already_current', 'error_code' => null);
                    continue;
                }
                $bundle = $desired['artifacts'][$desired_hash] ?? null;
                if (!is_array($bundle)) {
                    throw new CCW_Error('ccw_desired_artifact_missing', 'Falta el descriptor del artefacto deseado.');
                }
                $staging = null;
                try {
                    $manifest = $this->http->get_json($bundle['manifest_url'], 'ccw_manifest');
                    $envelope = $this->http->get_json($bundle['envelope_url'], 'ccw_manifest_envelope');
                    $manifest = CCW_Manifest::verify(
                        $manifest,
                        $envelope,
                        $desired_hash,
                        $runtime,
                        $accepted_signing_descriptor['key_id']
                    );
                    $this->assert_download_set($manifest, $bundle['files'], $bundle['manifest_url'], $bundle['envelope_url']);
                    $staging = $this->cache->create_staging_directory();
                    $paths = array_keys($manifest['files']);
                    sort($paths, SORT_STRING);
                    foreach ($paths as $path) {
                        $target = $this->cache->staging_file($staging, $path);
                        $metadata = $manifest['files'][$path];
                        $this->http->download_file($bundle['files'][$path], $target, $metadata['size_bytes']);
                        CCW_Manifest::inspect_file($path, $target, $metadata, $runtime, $manifest);
                        @chmod($target, 0640);
                    }
                    $this->cache->promote_route($publication_id, $route['route_prefix'], $staging, $manifest, $runtime);
                    $staging = null;
                    if ($force) $this->cache->clear_route_manual_hold($publication_id, $route['route_prefix']);
                    $route_results[$publication_id] = array('result' => 'activated', 'error_code' => null);
                } finally {
                    if ($staging !== null) $this->cache->remove_tree($staging);
                }
            } catch (CCW_Error $error) {
                $route_results[$publication_id] = array('result' => 'failed', 'error_code' => $error->error_code());
            }
        }
        $this->cache->set_registry_sequence($registry['sequence'], $registry_hash);
        CCW_Config::set_runtime_configuration($registry);
        $this->cache->prune_releases();
        $has_failures = false;
        foreach ($route_results as $route_result) {
            if (!empty($route_result['error_code'])) {
                $has_failures = true;
                break;
            }
        }
        $all_routes_terminal = $registry['routes'] !== array();
        foreach ($route_results as $route_result) {
            if (!in_array((string) ($route_result['result'] ?? ''), array(
                'activated', 'already_current', 'adopted_pilot', 'retired',
            ), true)) {
                $all_routes_terminal = false;
                break;
            }
        }
        if (!$has_failures && $all_routes_terminal) {
            CCW_Trust_Store::promote_remote_descriptor($accepted_signing_descriptor['key_id']);
        }
        $payload = $this->report_payload_v2(
            'sync_result',
            $started,
            $request_id,
            $registry,
            null,
            $route_results,
            CCW_Trust_Store::active_key_id(),
            (int) $registry['sequence']
        );
        $reported = $this->http->report($payload);
        $state = CCW_Config::sync_state();
        $state['schema_version'] = 2;
        $state['last_attempt_at'] = gmdate('c');
        if (!$has_failures && $reported) $state['last_success_at'] = gmdate('c');
        $state['last_result'] = $has_failures
            ? 'multi_partial_failed'
            : ($reported ? 'multi_synced' : 'multi_report_pending');
        $state['last_error_code'] = $has_failures
            ? 'ccw_route_sync_failed'
            : ($reported ? null : 'ccw_sync_report_pending');
        $state['etag'] = !$has_failures && $reported
            && is_string($response['_http_etag'] ?? null) && strlen($response['_http_etag']) <= 256
            ? $response['_http_etag'] : '';
        CCW_Config::set_sync_state($state);
        return array(
            'ok' => !$has_failures && $reported,
            'result' => $has_failures ? 'multi_partial_failed' : ($reported ? 'multi_synced' : 'multi_report_pending'),
            'report_pending' => !$has_failures && !$reported,
            'request_id' => $request_id,
            'registry_sequence' => (int) $registry['sequence'],
            'routes' => $payload['routes'],
            'duration_ms' => (int) round((microtime(true) - $started) * 1000),
        );
    }

    /** @return array<string,mixed> */
    private function validate_desired_state_v2(array $response)
    {
        if (
            (int) ($response['schema_version'] ?? 0) !== 2
            || !hash_equals(CCW_Config::installation_id(), (string) ($response['installation_id'] ?? ''))
            || !is_array($response['desired_state'] ?? null)
        ) {
            throw new CCW_Error('ccw_desired_state_contract_invalid', 'El estado deseado no corresponde a esta instalación.');
        }
        $desired = $response['desired_state'];
        foreach (array('signing_key_descriptor', 'signing_key_descriptor_envelope', 'registry_configuration', 'registry_configuration_envelope', 'artifacts') as $field) {
            if (!is_array($desired[$field] ?? null)) {
                throw new CCW_Error('ccw_desired_state_contract_invalid', 'Falta un documento firmado requerido.', array('field' => $field));
            }
        }
        if ((string) ($desired['status'] ?? '') !== 'multi' || count($desired['artifacts']) > 20) {
            throw new CCW_Error('ccw_desired_state_contract_invalid', 'El estado multi-publicación no es válido.');
        }
        foreach ($desired['artifacts'] as $hash => &$bundle) {
            if (!preg_match('/^[a-f0-9]{64}$/', (string) $hash) || !is_array($bundle) || (string) ($bundle['artifact_hash'] ?? '') !== $hash || !is_array($bundle['files'] ?? null)) {
                throw new CCW_Error('ccw_desired_artifact_invalid', 'El estado deseado no identifica un artefacto válido.');
            }
            $bundle['manifest_url'] = CCW_HTTP::safe_download_url($bundle['manifest_url'] ?? '');
            $bundle['envelope_url'] = CCW_HTTP::safe_download_url($bundle['envelope_url'] ?? '');
            foreach ($bundle['files'] as $path => $url) {
                CCW_Manifest::safe_path($path);
                $bundle['files'][$path] = CCW_HTTP::safe_download_url($url);
            }
        }
        unset($bundle);
        return $desired;
    }

    /** @return array<string,mixed> */
    private function validate_desired_state(array $response)
    {
        if (
            (int) ($response['schema_version'] ?? 0) !== 1
            || !hash_equals(CCW_Config::installation_id(), (string) ($response['installation_id'] ?? ''))
            || !is_array($response['desired_state'] ?? null)
        ) {
            throw new CCW_Error('ccw_desired_state_contract_invalid', 'El estado deseado no corresponde a esta instalación.');
        }
        $desired = $response['desired_state'];
        $status = (string) ($desired['status'] ?? '');
        if (!in_array($status, array('published', 'retired'), true)) {
            throw new CCW_Error('ccw_desired_status_invalid', 'El estado de publicación no es compatible.');
        }
        foreach (array('signing_key_descriptor', 'signing_key_descriptor_envelope', 'runtime_configuration', 'runtime_configuration_envelope') as $field) {
            if (!is_array($desired[$field] ?? null)) {
                throw new CCW_Error('ccw_desired_state_contract_invalid', 'Falta un documento firmado requerido.', array('field' => $field));
            }
        }
        if ($status === 'published') {
            if (
                !preg_match('/^[a-f0-9]{64}$/', (string) ($desired['artifact_hash'] ?? ''))
                || !is_array($desired['files'] ?? null)
            ) {
                throw new CCW_Error('ccw_desired_artifact_invalid', 'El estado deseado no identifica un artefacto válido.');
            }
            $desired['manifest_url'] = CCW_HTTP::safe_download_url($desired['manifest_url'] ?? '');
            $desired['envelope_url'] = CCW_HTTP::safe_download_url($desired['envelope_url'] ?? '');
        }
        $desired['status'] = $status;
        return $desired;
    }

    private function assert_runtime_sequence(array $next, array $current)
    {
        $next_sequence = (int) $next['sequence'];
        $current_sequence = (int) ($current['sequence'] ?? 0);
        if ($next_sequence < $current_sequence) {
            throw new CCW_Error('ccw_runtime_replay_blocked', 'Se ha rechazado una configuración firmada anterior.');
        }
        if ($next_sequence === $current_sequence && $current !== array()
            && !hash_equals(hash('sha256', CCW_JSON::canonical($current)), hash('sha256', CCW_JSON::canonical($next)))) {
            throw new CCW_Error('ccw_runtime_sequence_conflict', 'La misma secuencia firmada contiene una configuración distinta.');
        }
    }

    private function assert_download_set(array $manifest, array $files, $manifest_url, $envelope_url)
    {
        $manifest_paths = array_keys($manifest['files']);
        $download_paths = array_keys($files);
        sort($manifest_paths, SORT_STRING);
        sort($download_paths, SORT_STRING);
        if ($manifest_paths !== $download_paths) {
            throw new CCW_Error('ccw_download_set_mismatch', 'Las descargas no coinciden con los ficheros firmados.');
        }
        $origin = self::url_origin($manifest_url);
        if ($origin !== self::url_origin($envelope_url)) {
            throw new CCW_Error('ccw_download_origin_mismatch', 'Manifest y firma deben proceder del mismo origen HTTPS.');
        }
        foreach ($files as $path => $url) {
            CCW_Manifest::safe_path($path);
            $url = CCW_HTTP::safe_download_url($url);
            if ($origin !== self::url_origin($url)) {
                throw new CCW_Error('ccw_download_origin_mismatch', 'Todos los ficheros deben proceder del origen firmado del artefacto.');
            }
        }
    }

    private static function url_origin($url)
    {
        $parts = parse_url((string) $url);
        $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
        return strtolower((string) ($parts['scheme'] ?? '')) . '://' . strtolower((string) ($parts['host'] ?? '')) . $port;
    }

    /** @return array<string,mixed> */
    private function finish_and_report(
        $result,
        array $pointer,
        $started,
        $request_id,
        $etag,
        $signing_key_id,
        $configuration_sequence
    )
    {
        $this->cache->prune_releases();
        $summary = $this->success($result, $pointer, $started, $request_id);
        $reported_desired = ($pointer['status'] ?? '') === 'retired' ? null : $summary['active_artifact_hash'];
        $reported = $this->http->report($this->report_payload(
            'sync_result',
            $started,
            $request_id,
            $reported_desired,
            null,
            $result,
            $signing_key_id,
            $configuration_sequence
        ));
        $state = CCW_Config::sync_state();
        $state['schema_version'] = 1;
        $state['last_attempt_at'] = gmdate('c');
        if ($reported) $state['last_success_at'] = gmdate('c');
        $state['last_result'] = $reported ? $result : $result . '_report_pending';
        $state['last_error_code'] = $reported ? null : 'ccw_sync_report_pending';
        $state['etag'] = $reported && is_string($etag) && strlen($etag) <= 256 ? $etag : '';
        CCW_Config::set_sync_state($state);
        if (!$reported) {
            $summary['ok'] = false;
            $summary['report_pending'] = true;
        }
        return $summary;
    }

    /** @return array<string,mixed> */
    private function success($result, array $pointer, $started, $request_id)
    {
        return array(
            'ok' => true,
            'result' => $result,
            'request_id' => $request_id,
            'status' => (string) ($pointer['status'] ?? 'empty'),
            'active_artifact_hash' => $pointer['active_hash'] ?? null,
            'duration_ms' => (int) round((microtime(true) - $started) * 1000),
        );
    }

    /** @return array<string,mixed> */
    private function report_payload(
        $event,
        $started,
        $request_id,
        $desired_hash,
        $error_code = null,
        $result = null,
        $signing_key_id = null,
        $configuration_sequence = null
    )
    {
        $pointer = $this->cache->pointer();
        return array_filter(array(
            'schema_version' => 1,
            'event' => $event,
            'request_id' => $request_id,
            'plugin_version' => CCW_VERSION,
            'wordpress_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
            'site_hash' => hash('sha256', home_url('/')),
            'status' => $pointer['status'] ?? 'empty',
            'active_artifact_hash' => $pointer['active_hash'] ?? null,
            'desired_artifact_hash' => $desired_hash,
            'result' => $result,
            'error_code' => $error_code,
            'signing_key_id' => $signing_key_id,
            'configuration_sequence' => $configuration_sequence,
            'duration_ms' => (int) round((microtime(true) - $started) * 1000),
            'reported_at' => gmdate('c'),
        ), static function ($value) {
            return $value !== null;
        });
    }

    /** @return array<string,mixed> */
    private function report_payload_v2(
        $event,
        $started,
        $request_id,
        $registry = null,
        $error_code = null,
        array $results = array(),
        $signing_key_id = null,
        $configuration_sequence = null
    )
    {
        $local = $this->cache->route_registry();
        $routes = array();
        $has_signed_registry = is_array($registry) && array_key_exists('routes', $registry) && is_array($registry['routes']);
        $expected = $has_signed_registry ? $registry['routes'] : array();
        if (!$has_signed_registry) {
            foreach ($local['routes'] as $publication_id => $entry) {
                $expected[$publication_id] = array(
                    'publication_id' => $publication_id,
                    'route_prefix' => (string) ($entry['route_prefix'] ?? ''),
                    'status' => 'pending',
                    'desired_artifact_hash' => null,
                );
            }
        }
        foreach ($expected as $publication_id => $route) {
            $pointer = $this->cache->route_pointer($publication_id, (string) $route['route_prefix']);
            $route_result = is_array($results[$publication_id] ?? null) ? $results[$publication_id] : array();
            $routes[$publication_id] = array_filter(array(
                'publication_id' => $publication_id,
                'route_prefix' => (string) $route['route_prefix'],
                'status' => (string) ($pointer['status'] ?? 'empty'),
                'active_artifact_hash' => ($pointer['status'] ?? '') === 'active' ? ($pointer['active_hash'] ?? null) : null,
                'desired_artifact_hash' => ($pointer['status'] ?? '') === 'active'
                    ? ($route['desired_artifact_hash'] ?? null)
                    : null,
                'result' => $route_result['result'] ?? null,
                'error_code' => $route_result['error_code'] ?? null,
            ), static function ($value) { return $value !== null; });
        }
        ksort($routes, SORT_STRING);
        return array_filter(array(
            'schema_version' => 2,
            'event' => $event,
            'request_id' => $request_id,
            'plugin_version' => CCW_VERSION,
            'wordpress_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
            'site_hash' => hash('sha256', home_url('/')),
            'capabilities' => array('multi_publication_v2' => true),
            'registry_sequence' => is_array($registry) ? (int) ($registry['sequence'] ?? 0) : (int) ($local['sequence'] ?? 0),
            'routes' => $routes,
            'error_code' => $error_code,
            'signing_key_id' => $signing_key_id,
            'configuration_sequence' => $configuration_sequence,
            'duration_ms' => (int) round((microtime(true) - $started) * 1000),
            'reported_at' => gmdate('c'),
        ), static function ($value) { return $value !== null; });
    }

    private function maybe_heartbeat(array $summary)
    {
        $state = CCW_Config::sync_state();
        $last = isset($state['last_heartbeat_at']) ? strtotime((string) $state['last_heartbeat_at']) : false;
        if ($last !== false && $last > time() - DAY_IN_SECONDS) {
            return;
        }
        if ($this->http->report($this->report_payload('heartbeat', microtime(true), null, $summary['active_artifact_hash'] ?? null))) {
            $state['last_heartbeat_at'] = gmdate('c');
            CCW_Config::set_sync_state($state);
        }
    }

    private function maybe_heartbeat_v2(array $summary)
    {
        $state = CCW_Config::sync_state();
        $last = isset($state['last_heartbeat_at']) ? strtotime((string) $state['last_heartbeat_at']) : false;
        if ($last !== false && $last > time() - DAY_IN_SECONDS) return;
        if ($this->http->report($this->report_payload_v2('heartbeat', microtime(true), null))) {
            $state['last_heartbeat_at'] = gmdate('c');
            CCW_Config::set_sync_state($state);
        }
    }

    private static function safe_request_id($value)
    {
        $value = trim((string) $value);
        return $value !== '' && strlen($value) <= 128 && preg_match('/^[A-Za-z0-9._:-]+$/', $value) ? $value : null;
    }
}
