<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Sync
{
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

        try {
            if (!CCW_Config::is_configured()) {
                throw new CCW_Error('ccw_not_configured', 'Completa la configuración de ClinicaClick antes de sincronizar.');
            }
            $lock = $this->cache->acquire_lock();
            $pointer = $this->cache->pointer();
            if (!empty($pointer['manual_hold']) && !$force) {
                $result = $this->success('manual_hold', $pointer, $started, null);
                $this->maybe_heartbeat($result);
                return $result;
            }

            $sync_state = CCW_Config::sync_state();
            $response = $this->http->desired_state($force ? '' : (string) ($sync_state['etag'] ?? ''));
            if ($response === null) {
                $result = $this->success('not_modified', $pointer, $started, null);
                $sync_state['last_attempt_at'] = gmdate('c');
                $sync_state['last_result'] = 'not_modified';
                CCW_Config::set_sync_state($sync_state);
                $this->maybe_heartbeat($result);
                return $result;
            }
            $request_id = self::safe_request_id($response['request_id'] ?? null);
            $desired = $this->validate_desired_state($response);
            $desired_hash = $desired['status'] === 'published' ? (string) $desired['artifact_hash'] : null;

            CCW_Trust_Store::trust_remote_descriptor(
                $desired['signing_key_descriptor'],
                $desired['signing_key_descriptor_envelope']
            );
            $runtime = CCW_Manifest::verify_runtime_configuration(
                $desired['runtime_configuration'],
                $desired['runtime_configuration_envelope'],
                CCW_Config::installation_id()
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
                return $this->finish_and_report('retired', $pointer, $started, $request_id, $response['_http_etag'] ?? '');
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
                return $this->finish_and_report('already_current', $pointer, $started, $request_id, $response['_http_etag'] ?? '');
            }

            $manifest = $this->http->get_json($desired['manifest_url'], 'ccw_manifest');
            $envelope = $this->http->get_json($desired['envelope_url'], 'ccw_manifest_envelope');
            $manifest = CCW_Manifest::verify($manifest, $envelope, $desired_hash, $runtime);
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
            return $this->finish_and_report('activated', $pointer, $started, $request_id, $response['_http_etag'] ?? '');
        } catch (CCW_Error $error) {
            if ($staging !== null) {
                $this->cache->remove_tree($staging);
            }
            $state = CCW_Config::sync_state();
            $state['last_attempt_at'] = gmdate('c');
            $state['last_result'] = 'failed';
            $state['last_error_code'] = $error->error_code();
            CCW_Config::set_sync_state($state);
            $this->http->report($this->report_payload('sync_failed', $started, $request_id, $desired_hash, $error->error_code()));
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
            $this->http->report($this->report_payload('sync_failed', $started, $request_id, $desired_hash, $wrapped->error_code()));
            throw $wrapped;
        } finally {
            if ($lock !== null) {
                $this->cache->release_lock($lock);
            }
        }
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
    private function finish_and_report($result, array $pointer, $started, $request_id, $etag)
    {
        $summary = $this->success($result, $pointer, $started, $request_id);
        $state = CCW_Config::sync_state();
        $state['last_attempt_at'] = gmdate('c');
        $state['last_success_at'] = gmdate('c');
        $state['last_result'] = $result;
        $state['last_error_code'] = null;
        $state['etag'] = is_string($etag) && strlen($etag) <= 256 ? $etag : '';
        CCW_Config::set_sync_state($state);
        $reported_desired = ($pointer['status'] ?? '') === 'retired' ? null : $summary['active_artifact_hash'];
        $this->http->report($this->report_payload('sync_result', $started, $request_id, $reported_desired, null, $result));
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
    private function report_payload($event, $started, $request_id, $desired_hash, $error_code = null, $result = null)
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
            'duration_ms' => (int) round((microtime(true) - $started) * 1000),
            'reported_at' => gmdate('c'),
        ), static function ($value) {
            return $value !== null;
        });
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

    private static function safe_request_id($value)
    {
        $value = trim((string) $value);
        return $value !== '' && strlen($value) <= 128 && preg_match('/^[A-Za-z0-9._:-]+$/', $value) ? $value : null;
    }
}
