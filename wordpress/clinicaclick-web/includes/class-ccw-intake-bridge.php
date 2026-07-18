<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

/**
 * Same-origin, no-JavaScript bridge for forms embedded in signed landings.
 *
 * Scope, HMAC material, publication identity, redirect anchors and page paths
 * are taken exclusively from the locally active signed runtime/manifest. The
 * browser is never allowed to select an API URL, clinic, group or redirect.
 */
final class CCW_Intake_Bridge
{
    const QUERY_VAR = 'ccw_intake';
    const ENDPOINT_PATH = '/_clinicaclick/intake';
    const EVENT_QUERY_VAR = 'ccw_events';
    const EVENT_ENDPOINT_PATH = '/_clinicaclick/events';
    const MAX_BODY_BYTES = 16384;
    const MAX_FIELDS = 27;
    const IP_WINDOW_SECONDS = 600;
    const IP_LIMIT = 8;
    const INSTALLATION_WINDOW_SECONDS = 3600;
    const INSTALLATION_LIMIT = 120;

    /** @var CCW_Cache */
    private $cache;

    public function __construct(CCW_Cache $cache = null)
    {
        $this->cache = $cache ?: new CCW_Cache();
    }

    public function register()
    {
        add_action('init', array($this, 'rewrite_rules'));
        add_filter('query_vars', array($this, 'query_vars'));
        add_action('template_redirect', array($this, 'handle'), -2000);
    }

    public function rewrite_rules()
    {
        add_rewrite_rule('^_clinicaclick/intake/?$', 'index.php?' . self::QUERY_VAR . '=1', 'top');
        add_rewrite_rule('^_clinicaclick/events/?$', 'index.php?' . self::EVENT_QUERY_VAR . '=1', 'top');
    }

    public function query_vars($vars)
    {
        $vars[] = self::QUERY_VAR;
        $vars[] = self::EVENT_QUERY_VAR;
        return $vars;
    }

    public function handle()
    {
        if ((string) get_query_var(self::EVENT_QUERY_VAR, '') === '1') {
            try {
                $result = $this->process_event($_SERVER, (string) file_get_contents('php://input'));
                $this->emit_json((int) $result['status'], $result['body']);
            } catch (CCW_Error $error) {
                $details = $error->details();
                $status = isset($details['http_status']) ? (int) $details['http_status'] : 400;
                $this->emit_json($status, array('success' => false, 'error' => array('code' => $error->error_code())));
            } catch (Throwable $error) {
                $this->emit_json(503, array('success' => false, 'error' => array('code' => 'ccw_event_bridge_unavailable')));
            }
            return;
        }
        if ((string) get_query_var(self::QUERY_VAR, '') !== '1') {
            return;
        }

        try {
            $result = $this->process($_SERVER, (string) file_get_contents('php://input'));
            $this->emit_redirect($result['location']);
        } catch (CCW_Error $error) {
            $details = $error->details();
            $status = isset($details['http_status']) ? (int) $details['http_status'] : 400;
            $this->emit_error($status);
        } catch (Throwable $error) {
            $this->emit_error(503);
        }
    }

    /**
     * Validates and forwards one browser request. Kept side-effect-light and
     * public so the security boundary can be covered by adversarial PHP tests.
     *
     * @param array<string,mixed> $server
     * @return array{location:string,event_id:string,honeypot:bool}
     */
    public function process(array $server, $raw_body, $now = null)
    {
        $now = $now === null ? time() : (int) $now;
        $this->assert_request_envelope($server, $raw_body);
        $fields = $this->parse_form_body($raw_body);
        $context = $this->trusted_context($server, $fields);

        // Bots receive the same success navigation without consuming an API
        // request, a rate-limit slot, or disclosing that the trap fired.
        if (trim((string) ($fields['_cc_company'] ?? '')) !== '') {
            return array(
                'location' => $context['success_url'],
                'event_id' => 'honeypot',
                'honeypot' => true,
            );
        }

        $lead = $this->validate_lead_fields($fields, $context['form_contract']);
        $runtime = $context['runtime'];
        $measurement = $runtime['measurement'];
        $ip = $this->client_ip($server);
        $this->consume_rate_limit($ip, (string) $measurement['hmac_key'], $now);

        $event_id = $this->event_id($context, $lead, (string) $measurement['hmac_key'], $now);
        $payload = $this->build_payload($context, $lead, $server, $ip, $event_id, $now);
        $this->forward($payload, $event_id, (string) $measurement['hmac_key'], (string) $context['artifact_hash']);

        return array(
            'location' => $context['success_url'],
            'event_id' => $event_id,
            'honeypot' => false,
        );
    }

    /** @param array<string,mixed> $server */
    private function assert_request_envelope(array $server, $raw_body)
    {
        if (strtoupper((string) ($server['REQUEST_METHOD'] ?? '')) !== 'POST') {
            $this->fail('ccw_intake_method_not_allowed', 405);
        }
        $content_type = strtolower(trim(explode(';', (string) ($server['CONTENT_TYPE'] ?? ''))[0]));
        if ($content_type !== 'application/x-www-form-urlencoded') {
            $this->fail('ccw_intake_content_type_unsupported', 415);
        }
        $length = strlen((string) $raw_body);
        if ($length < 1 || $length > self::MAX_BODY_BYTES) {
            $this->fail('ccw_intake_body_too_large', $length > self::MAX_BODY_BYTES ? 413 : 400);
        }
        if (isset($server['CONTENT_LENGTH']) && (string) $server['CONTENT_LENGTH'] !== '') {
            $declared = (string) $server['CONTENT_LENGTH'];
            if (!preg_match('/^[0-9]{1,8}$/', $declared) || (int) $declared !== $length) {
                $this->fail('ccw_intake_content_length_invalid', 400);
            }
        }
    }

    /** @return array<string,string> */
    private function parse_form_body($raw_body)
    {
        $allowed = array_fill_keys(array(
            'first_name',
            'last_name',
            'email',
            'phone',
            'message',
            'preferred_contact',
            'privacy_consent',
            '_cc_ad_user_data',
            '_cc_ad_personalization',
            '_cc_company',
            'web_project_id',
            'web_revision_id',
            'web_page_id',
            'web_form_id',
            '_cc_attr_gclid',
            '_cc_attr_gbraid',
            '_cc_attr_wbraid',
            '_cc_attr_fbclid',
            '_cc_attr_ttclid',
            '_cc_attr_utm_source',
            '_cc_attr_utm_medium',
            '_cc_attr_utm_campaign',
            '_cc_attr_utm_content',
            '_cc_attr_utm_term',
            '_cc_attr_cc_gads_customer_id',
            '_cc_attr_cc_gads_campaign_id',
            '_cc_attr_landing_path',
        ), true);
        $fields = array();
        $pairs = explode('&', (string) $raw_body);
        if (count($pairs) > self::MAX_FIELDS) {
            $this->fail('ccw_intake_too_many_fields', 400);
        }
        foreach ($pairs as $pair) {
            if ($pair === '' || preg_match('/%(?![0-9a-f]{2})/i', $pair)) {
                $this->fail('ccw_intake_form_encoding_invalid', 400);
            }
            $separator = strpos($pair, '=');
            $encoded_key = $separator === false ? $pair : substr($pair, 0, $separator);
            $encoded_value = $separator === false ? '' : substr($pair, $separator + 1);
            $key = urldecode($encoded_key);
            $value = urldecode($encoded_value);
            if (
                !isset($allowed[$key])
                || isset($fields[$key])
                || strpos($key, '[') !== false
                || strpos($key, ']') !== false
                || strpos($value, "\0") !== false
            ) {
                $this->fail('ccw_intake_form_fields_invalid', 400);
            }
            if (function_exists('mb_check_encoding') && !mb_check_encoding($value, 'UTF-8')) {
                $this->fail('ccw_intake_form_encoding_invalid', 400);
            }
            $fields[$key] = $value;
        }
        foreach (array('web_project_id', 'web_revision_id', 'web_page_id', 'web_form_id', 'privacy_consent') as $required) {
            if (!isset($fields[$required])) {
                $this->fail('ccw_intake_required_field_missing', 422);
            }
        }
        return $fields;
    }

    /**
     * @param array<string,mixed> $server
     * @param array<string,string> $fields
     * @return array<string,mixed>
     */
    private function trusted_context(array $server, array $fields)
    {
        $pointer = $this->cache->pointer();
        $manifest = is_array($pointer['manifest'] ?? null) ? $pointer['manifest'] : array();
        $artifact_hash = (string) ($pointer['active_hash'] ?? '');
        if (($pointer['status'] ?? '') !== 'active' || !preg_match('/^[a-f0-9]{64}$/', $artifact_hash)) {
            $this->fail('ccw_intake_publication_unavailable', 503);
        }

        $runtime = is_array($pointer['runtime_configuration'] ?? null)
            ? $pointer['runtime_configuration']
            : CCW_Config::runtime_configuration();
        $measurement = is_array($runtime['measurement'] ?? null) ? $runtime['measurement'] : array();
        if (
            (string) ($runtime['status'] ?? '') !== 'active'
            || !hash_equals($artifact_hash, (string) ($runtime['desired_artifact_hash'] ?? ''))
            || empty($measurement['enabled'])
            || !in_array((string) ($measurement['scope_type'] ?? ''), array('clinic', 'group'), true)
            || (int) ($measurement['scope_id'] ?? 0) < 1
            || strlen((string) ($measurement['hmac_key'] ?? '')) < 16
        ) {
            $this->fail('ccw_intake_runtime_unavailable', 503);
        }

        $project_id = $this->uuid($fields['web_project_id'], 'ccw_intake_project_invalid');
        $revision_id = $this->uuid($fields['web_revision_id'], 'ccw_intake_revision_invalid');
        $page_id = $this->uuid($fields['web_page_id'], 'ccw_intake_page_invalid');
        $form_id = $this->form_id($fields['web_form_id']);
        if (
            !hash_equals(strtolower((string) ($manifest['project_id'] ?? '')), $project_id)
            || !hash_equals(strtolower((string) ($manifest['revision_id'] ?? '')), $revision_id)
            || !is_array($manifest['intake_forms'] ?? null)
            || !is_array($manifest['intake_forms'][$form_id] ?? null)
        ) {
            $this->fail('ccw_intake_signed_form_mismatch', 409);
        }
        $form = $manifest['intake_forms'][$form_id];
        if (!hash_equals(strtolower((string) ($form['page_id'] ?? '')), $page_id)) {
            $this->fail('ccw_intake_signed_form_mismatch', 409);
        }

        $referer = $this->validated_referer($server, (string) ($form['page_path'] ?? ''));
        $attribution = array_merge(
            $this->attribution_from_fields($fields),
            $this->attribution_from_query((string) ($referer['query'] ?? ''))
        );
        $page_url = $this->canonical_page_url((string) ($form['page_path'] ?? ''), $attribution);
        $landing_page_path = $this->validated_landing_page_path($fields, $manifest, (string) ($form['page_path'] ?? ''));
        $landing_url = $this->canonical_page_url($landing_page_path, $attribution);
        if (isset($server['HTTP_ORIGIN']) && trim((string) $server['HTTP_ORIGIN']) !== '') {
            $origin = parse_url(trim((string) $server['HTTP_ORIGIN']));
            if (
                !is_array($origin)
                || !empty($origin['query'])
                || !empty($origin['fragment'])
                || !in_array((string) ($origin['path'] ?? ''), array('', '/'), true)
                || !$this->same_origin((string) $server['HTTP_ORIGIN'], home_url('/'))
            ) {
                $this->fail('ccw_intake_origin_invalid', 403);
            }
        }

        return array(
            'pointer' => $pointer,
            'manifest' => $manifest,
            'runtime' => $runtime,
            'artifact_hash' => $artifact_hash,
            'project_id' => $project_id,
            'revision_id' => $revision_id,
            'page_id' => $page_id,
            'form_id' => $form_id,
            'form_contract' => $form,
            'page_path' => (string) $form['page_path'],
            'page_url' => $page_url,
            'landing_url' => $landing_url,
            'attribution' => $attribution,
            'success_url' => $page_url . '#' . rawurlencode((string) $form['success_anchor']),
            'error_url' => $page_url . '#' . rawurlencode((string) $form['error_anchor']),
        );
    }

    /** @param array<string,mixed> $server */
    private function validated_referer(array $server, $page_path)
    {
        $referer_value = trim((string) ($server['HTTP_REFERER'] ?? ''));
        if ($referer_value === '' || !$this->same_origin($referer_value, home_url('/'))) {
            $this->fail('ccw_intake_referer_invalid', 403);
        }
        $referer = parse_url($referer_value);
        $expected = parse_url(home_url('/cita' . $page_path));
        if (!is_array($referer) || !is_array($expected)) {
            $this->fail('ccw_intake_referer_invalid', 403);
        }
        $actual_path = (string) ($referer['path'] ?? '');
        $expected_path = (string) ($expected['path'] ?? '');
        if (!$this->safe_url_path($actual_path) || !hash_equals($expected_path, $actual_path)) {
            $this->fail('ccw_intake_referer_path_invalid', 403);
        }
        return $referer;
    }

    private function same_origin($left, $right)
    {
        $a = parse_url(trim((string) $left));
        $b = parse_url(trim((string) $right));
        if (!is_array($a) || !is_array($b)) {
            return false;
        }
        if (strtolower((string) ($a['scheme'] ?? '')) !== 'https' || strtolower((string) ($b['scheme'] ?? '')) !== 'https') {
            return false;
        }
        if (isset($a['user']) || isset($a['pass']) || isset($b['user']) || isset($b['pass'])) {
            return false;
        }
        $a_port = isset($a['port']) ? (int) $a['port'] : 443;
        $b_port = isset($b['port']) ? (int) $b['port'] : 443;
        return strtolower((string) ($a['host'] ?? '')) === strtolower((string) ($b['host'] ?? '')) && $a_port === $b_port;
    }

    private function safe_url_path($path)
    {
        if ($path === '' || strlen($path) > 512 || preg_match('/%(?![0-9a-f]{2})/i', $path)) {
            return false;
        }
        $decoded = rawurldecode($path);
        return strpos($decoded, "\0") === false
            && strpos($decoded, '\\') === false
            && !preg_match('#(?:^|/)\.\.?(/|$)#', $decoded)
            && !preg_match('#/{2,}#', $decoded);
    }

    /** @return array<string,string> */
    private function attribution_from_query($query)
    {
        if ($query === '') {
            return array();
        }
        $allowed = array(
            'gclid' => array('gclid', 256),
            'gbraid' => array('gbraid', 256),
            'wbraid' => array('wbraid', 256),
            'fbclid' => array('fbclid', 512),
            'ttclid' => array('ttclid', 512),
            'utm_source' => array('utm_source', 200),
            'utm_medium' => array('utm_medium', 200),
            'utm_campaign' => array('utm_campaign', 300),
            'utm_content' => array('utm_content', 300),
            'utm_term' => array('utm_term', 300),
            'cc_gads_customer_id' => array('google_ads_customer_id', 10),
            'cc_gads_campaign_id' => array('google_ads_campaign_id', 32),
        );
        $result = array();
        $seen = array();
        $duplicates = array();
        foreach (explode('&', (string) $query) as $pair) {
            if ($pair === '' || preg_match('/%(?![0-9a-f]{2})/i', $pair)) {
                continue;
            }
            $separator = strpos($pair, '=');
            $key = urldecode($separator === false ? $pair : substr($pair, 0, $separator));
            if (!isset($allowed[$key])) {
                continue;
            }
            $canonical_key = $allowed[$key][0];
            $maximum = $allowed[$key][1];
            if (isset($seen[$canonical_key])) {
                $duplicates[$canonical_key] = true;
                unset($result[$canonical_key]);
                continue;
            }
            $seen[$canonical_key] = true;
            $value = trim(urldecode($separator === false ? '' : substr($pair, $separator + 1)));
            if ($value === '' || $this->text_length($value) > $maximum) {
                continue;
            }
            if (in_array($canonical_key, array('gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid'), true)) {
                if (!preg_match('/^[A-Za-z0-9._~-]+$/', $value)) {
                    continue;
                }
            } elseif ($canonical_key === 'google_ads_customer_id') {
                if (!preg_match('/^\d{10}$/', $value)) {
                    continue;
                }
            } elseif ($canonical_key === 'google_ads_campaign_id') {
                if (!preg_match('/^[1-9]\d{0,31}$/', $value)) {
                    continue;
                }
            } else {
                $value = $this->clean_text($value, $maximum, false);
            }
            if ($value !== '') {
                $result[$canonical_key] = $value;
            }
        }
        foreach ($duplicates as $key => $_duplicate) {
            unset($result[$key]);
        }
        return $result;
    }

    /** @param array<string,string> $fields @return array<string,string> */
    private function attribution_from_fields(array $fields)
    {
        $field_map = array(
            '_cc_attr_gclid' => 'gclid',
            '_cc_attr_gbraid' => 'gbraid',
            '_cc_attr_wbraid' => 'wbraid',
            '_cc_attr_fbclid' => 'fbclid',
            '_cc_attr_ttclid' => 'ttclid',
            '_cc_attr_utm_source' => 'utm_source',
            '_cc_attr_utm_medium' => 'utm_medium',
            '_cc_attr_utm_campaign' => 'utm_campaign',
            '_cc_attr_utm_content' => 'utm_content',
            '_cc_attr_utm_term' => 'utm_term',
            '_cc_attr_cc_gads_customer_id' => 'google_ads_customer_id',
            '_cc_attr_cc_gads_campaign_id' => 'google_ads_campaign_id',
        );
        $limits = array(
            'gclid' => 256,
            'gbraid' => 256,
            'wbraid' => 256,
            'fbclid' => 512,
            'ttclid' => 512,
            'utm_source' => 200,
            'utm_medium' => 200,
            'utm_campaign' => 300,
            'utm_content' => 300,
            'utm_term' => 300,
            'google_ads_customer_id' => 10,
            'google_ads_campaign_id' => 32,
        );
        $result = array();
        foreach ($field_map as $browser_name => $canonical_name) {
            if (!isset($fields[$browser_name]) || $fields[$browser_name] === '') {
                continue;
            }
            $value = trim((string) $fields[$browser_name]);
            if (
                $value === ''
                || $this->text_length($value) > $limits[$canonical_name]
                || preg_match('/[\x00-\x1f\x7f]/', $value)
                || (in_array($canonical_name, array('gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid'), true)
                    && !preg_match('/^[A-Za-z0-9._~-]+$/', $value))
                || ($canonical_name === 'google_ads_customer_id' && !preg_match('/^\d{10}$/', $value))
                || ($canonical_name === 'google_ads_campaign_id' && !preg_match('/^[1-9]\d{0,31}$/', $value))
            ) {
                $this->fail('ccw_intake_attribution_invalid', 422);
            }
            $result[$canonical_name] = $value;
        }
        return $result;
    }

    /** @param array<string,string> $fields @param array<string,mixed> $manifest */
    private function validated_landing_page_path(array $fields, array $manifest, $fallback_page_path)
    {
        $requested = trim((string) ($fields['_cc_attr_landing_path'] ?? ''));
        if ($requested === '') {
            return $fallback_page_path;
        }
        if (!$this->safe_url_path($requested)) {
            $this->fail('ccw_intake_landing_path_invalid', 422);
        }
        $requested = '/' . trim($requested, '/') . '/';
        if ($requested === '//') {
            $requested = '/';
        }
        $routes = is_array($manifest['page_routes'] ?? null) ? $manifest['page_routes'] : array();
        foreach ($routes as $contract) {
            if (!is_array($contract)) {
                continue;
            }
            $page_path = (string) ($contract['page_path'] ?? '');
            $expected_url = parse_url($this->canonical_page_url($page_path, array()));
            $expected_path = is_array($expected_url) ? (string) ($expected_url['path'] ?? '') : '';
            $expected_path = '/' . trim($expected_path, '/') . '/';
            if ($expected_path === '//') {
                $expected_path = '/';
            }
            if ($expected_path !== '' && hash_equals($expected_path, $requested)) {
                return $page_path;
            }
        }
        $this->fail('ccw_intake_landing_path_mismatch', 409);
    }

    /** @param array<string,string> $attribution */
    private function canonical_page_url($page_path, array $attribution)
    {
        $url = home_url('/cita' . $page_path);
        if ($attribution !== array()) {
            $query = array();
            foreach ($attribution as $key => $value) {
                if ($key === 'google_ads_customer_id') {
                    $query['cc_gads_customer_id'] = $value;
                } elseif ($key === 'google_ads_campaign_id') {
                    $query['cc_gads_campaign_id'] = $value;
                } else {
                    $query[$key] = $value;
                }
            }
            $url .= '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        }
        return $url;
    }

    /**
     * @param array<string,string> $fields
     * @return array<string,string>
     */
    private function validate_lead_fields(array $fields, array $form_contract)
    {
        if ((string) $fields['privacy_consent'] !== '1') {
            $this->fail('ccw_intake_privacy_consent_required', 422);
        }
        $first_name = $this->clean_text($fields['first_name'] ?? '', 100, false);
        $last_name = $this->clean_text($fields['last_name'] ?? '', 100, false);
        $message = $this->clean_text($fields['message'] ?? '', 2000, true);
        $email = strtolower(trim((string) ($fields['email'] ?? '')));
        if ($email !== '' && (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL))) {
            $this->fail('ccw_intake_email_invalid', 422);
        }
        $phone = $this->normalize_phone($fields['phone'] ?? '');
        if ($email === '' && $phone === '') {
            $this->fail('ccw_intake_contact_required', 422);
        }
        $preferred = trim((string) ($fields['preferred_contact'] ?? ''));
        if ($preferred !== '' && !in_array($preferred, array('telefono', 'whatsapp', 'email'), true)) {
            $this->fail('ccw_intake_preferred_contact_invalid', 422);
        }
        $ad_user_data = $this->optional_google_consent($fields['_cc_ad_user_data'] ?? '');
        $ad_personalization = $this->optional_google_consent($fields['_cc_ad_personalization'] ?? '');
        $lead = array(
            'first_name' => $first_name,
            'last_name' => $last_name,
            'email' => $email,
            'phone' => $phone,
            'message' => $message,
            'preferred_contact' => $preferred,
            'privacy_consent' => '1',
            '_cc_ad_user_data' => $ad_user_data,
            '_cc_ad_personalization' => $ad_personalization,
        );
        foreach ((array) ($form_contract['fields'] ?? array()) as $field) {
            $name = (string) ($field['name'] ?? '');
            if (!empty($field['required']) && (!isset($lead[$name]) || $lead[$name] === '')) {
                $this->fail('ccw_intake_required_field_missing', 422);
            }
        }
        return $lead;
    }

    private function optional_google_consent($value)
    {
        $value = trim((string) $value);
        if ($value !== '' && !in_array($value, array('granted', 'denied'), true)) {
            $this->fail('ccw_intake_google_consent_invalid', 422);
        }
        return $value;
    }

    private function normalize_phone($value)
    {
        $value = trim((string) $value);
        if ($value === '') {
            return '';
        }
        if (strlen($value) > 40 || !preg_match('/^\+?[0-9\s().-]+$/', $value)) {
            $this->fail('ccw_intake_phone_invalid', 422);
        }
        $has_plus = isset($value[0]) && $value[0] === '+';
        $digits = preg_replace('/\D+/', '', $value);
        if (!is_string($digits) || strlen($digits) < 7 || strlen($digits) > 15) {
            $this->fail('ccw_intake_phone_invalid', 422);
        }
        return ($has_plus ? '+' : '') . $digits;
    }

    private function clean_text($value, $max_length, $preserve_newlines)
    {
        $value = strip_tags((string) $value);
        if (class_exists('Normalizer')) {
            $normalized = Normalizer::normalize($value, Normalizer::FORM_C);
            if (is_string($normalized)) {
                $value = $normalized;
            }
        }
        $value = str_replace(array("\r\n", "\r"), "\n", $value);
        $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value);
        if (!is_string($value)) {
            $this->fail('ccw_intake_text_invalid', 422);
        }
        if ($preserve_newlines) {
            $value = preg_replace('/[ \t]+/u', ' ', trim($value));
            $value = preg_replace('/\n{3,}/u', "\n\n", (string) $value);
        } else {
            $value = preg_replace('/\s+/u', ' ', trim($value));
        }
        if (!is_string($value) || $this->text_length($value) > $max_length) {
            $this->fail('ccw_intake_text_too_long', 422);
        }
        return $value;
    }

    private function text_length($value)
    {
        return function_exists('mb_strlen') ? mb_strlen((string) $value, 'UTF-8') : strlen((string) $value);
    }

    private function uuid($value, $code)
    {
        $value = strtolower(trim((string) $value));
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $value)) {
            $this->fail($code, 422);
        }
        return $value;
    }

    private function form_id($value)
    {
        $value = trim((string) $value);
        if (!preg_match('/^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9_-]{2,63})$/i', $value)) {
            $this->fail('ccw_intake_form_id_invalid', 422);
        }
        return $value;
    }

    private function client_ip(array $server)
    {
        $value = trim((string) ($server['REMOTE_ADDR'] ?? ''));
        return filter_var($value, FILTER_VALIDATE_IP) ? $value : 'unknown';
    }

    private function consume_rate_limit($ip, $secret, $now)
    {
        $this->cache->initialize();
        $path = $this->cache->root() . '/intake-rate-limit.json';
        $handle = fopen($path, 'c+');
        if (!is_resource($handle) || !flock($handle, LOCK_EX)) {
            if (is_resource($handle)) {
                fclose($handle);
            }
            $this->fail('ccw_intake_rate_limit_unavailable', 503);
        }
        try {
            $contents = stream_get_contents($handle);
            $state = $contents === false || $contents === '' ? array() : json_decode($contents, true);
            if (!is_array($state)) {
                $state = array();
            }
            $installation = array_values(array_filter((array) ($state['installation'] ?? array()), static function ($timestamp) use ($now) {
                return is_int($timestamp) && $timestamp > $now - self::INSTALLATION_WINDOW_SECONDS && $timestamp <= $now + 60;
            }));
            $ip_key = hash_hmac('sha256', (string) $ip, $secret);
            $ip_entries = array_values(array_filter((array) (($state['ip'] ?? array())[$ip_key] ?? array()), static function ($timestamp) use ($now) {
                return is_int($timestamp) && $timestamp > $now - self::IP_WINDOW_SECONDS && $timestamp <= $now + 60;
            }));
            if (count($installation) >= self::INSTALLATION_LIMIT || count($ip_entries) >= self::IP_LIMIT) {
                $this->fail('ccw_intake_rate_limited', 429);
            }
            $installation[] = $now;
            $ip_entries[] = $now;
            $ip_state = array();
            foreach ((array) ($state['ip'] ?? array()) as $key => $entries) {
                if (!preg_match('/^[a-f0-9]{64}$/', (string) $key)) {
                    continue;
                }
                $recent = array_values(array_filter((array) $entries, static function ($timestamp) use ($now) {
                    return is_int($timestamp) && $timestamp > $now - self::IP_WINDOW_SECONDS && $timestamp <= $now + 60;
                }));
                if ($recent !== array()) {
                    $ip_state[$key] = $recent;
                }
            }
            $ip_state[$ip_key] = $ip_entries;
            $next = wp_json_encode(array(
                'schema_version' => 1,
                'installation' => $installation,
                'ip' => $ip_state,
            ), JSON_UNESCAPED_SLASHES);
            if (!is_string($next)) {
                $this->fail('ccw_intake_rate_limit_unavailable', 503);
            }
            rewind($handle);
            if (!ftruncate($handle, 0) || fwrite($handle, $next) !== strlen($next) || !fflush($handle)) {
                $this->fail('ccw_intake_rate_limit_unavailable', 503);
            }
            @chmod($path, 0600);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** @param array<string,mixed> $context @param array<string,string> $lead */
    private function event_id(array $context, array $lead, $secret, $now)
    {
        $fingerprint = array(
            'artifact_hash' => $context['artifact_hash'],
            'project_id' => $context['project_id'],
            'revision_id' => $context['revision_id'],
            'page_id' => $context['page_id'],
            'form_id' => $context['form_id'],
            'email' => $lead['email'],
            'phone' => $lead['phone'],
            'bucket' => (int) floor($now / 300),
        );
        return 'ccw_' . hash_hmac('sha256', CCW_JSON::canonical($fingerprint), $secret);
    }

    /**
     * @param array<string,mixed> $context
     * @param array<string,string> $lead
     * @param array<string,mixed> $server
     * @return array<string,mixed>
     */
    private function build_payload(array $context, array $lead, array $server, $ip, $event_id, $now)
    {
        $attribution = $context['attribution'];
        $source = isset($attribution['gclid']) || isset($attribution['gbraid']) || isset($attribution['wbraid'])
            || (isset($attribution['google_ads_customer_id']) && isset($attribution['google_ads_campaign_id']))
            ? 'google_ads'
            : (isset($attribution['fbclid'])
                ? 'meta_ads'
                : (isset($attribution['ttclid']) ? 'tiktok_ads' : $this->source_from_utm($attribution['utm_source'] ?? '')));
        $paid = $source !== 'web' || preg_match('/^(?:cpc|ppc|paid|paid_search|paid_social|display|social_paid)$/i', (string) ($attribution['utm_medium'] ?? ''));
        $scope = $context['runtime']['measurement'];
        $name = trim($lead['first_name'] . ' ' . $lead['last_name']);
        $submitted_at = gmdate('c', $now);
        $consent = array(
            'contact' => 'granted',
            'captured_at' => $submitted_at,
            'source' => $context['page_url'],
            'version' => 'web-revision:' . $context['revision_id'],
        );
        if ($lead['_cc_ad_user_data'] !== '') {
            $consent['ad_user_data'] = $lead['_cc_ad_user_data'];
        }
        if ($lead['_cc_ad_personalization'] !== '') {
            $consent['ad_personalization'] = $lead['_cc_ad_personalization'];
        }
        $form_fields = array_filter(array(
            'first_name' => $lead['first_name'],
            'last_name' => $lead['last_name'],
            'email' => $lead['email'],
            'phone' => $lead['phone'],
            'message' => $lead['message'],
            'preferred_contact' => $lead['preferred_contact'],
            'privacy_consent' => true,
        ), static function ($value) {
            return $value !== '';
        });
        $payload = array(
            'event_id' => $event_id,
            'channel' => $paid ? 'paid' : 'organic',
            'source' => $source,
            'source_detail' => 'clinicaclick_web_landing',
            'external_source' => 'clinicaclick_web_landing',
            'page_url' => $context['page_url'],
            'landing_url' => $context['landing_url'],
            'attribution' => array_merge($attribution, array(
                'page_url' => $context['page_url'],
                'landing_url' => $context['landing_url'],
            )),
            'nombre' => $name !== '' ? $name : null,
            'email' => $lead['email'] !== '' ? $lead['email'] : null,
            'telefono' => $lead['phone'] !== '' ? $lead['phone'] : null,
            'notas' => $lead['message'] !== '' ? $lead['message'] : null,
            'lead_data' => array(
                'nombre' => $name !== '' ? $name : null,
                'email' => $lead['email'] !== '' ? $lead['email'] : null,
                'telefono' => $lead['phone'] !== '' ? $lead['phone'] : null,
                'notas' => $lead['message'] !== '' ? $lead['message'] : null,
            ),
            'consent' => $consent,
            'consentimiento_canal' => $consent,
            'web_project_id' => $context['project_id'],
            'web_revision_id' => $context['revision_id'],
            'web_page_id' => $context['page_id'],
            'web_form_id' => $context['form_id'],
            'form_submission' => array(
                'page_url' => $context['page_url'],
                'form_id' => $context['form_id'],
                'form_name' => 'clinicaclick_web_landing',
                'submitted_at' => $submitted_at,
                'fields' => $form_fields,
            ),
            'user_agent' => $this->safe_user_agent($server['HTTP_USER_AGENT'] ?? ''),
            'ip' => $ip === 'unknown' ? null : $ip,
        );
        if ((string) $scope['scope_type'] === 'clinic') {
            $payload['clinic_id'] = (int) $scope['scope_id'];
        } else {
            $payload['group_id'] = (int) $scope['scope_id'];
        }
        foreach ($attribution as $key => $value) {
            $payload[$key] = $value;
        }
        return $payload;
    }

    private function source_from_utm($value)
    {
        $value = strtolower(trim((string) $value));
        if (in_array($value, array('google', 'googleads', 'google_ads'), true)) {
            return 'google_ads';
        }
        if (in_array($value, array('facebook', 'instagram', 'meta', 'meta_ads'), true)) {
            return 'meta_ads';
        }
        if (in_array($value, array('tiktok', 'tiktok_ads'), true)) {
            return 'tiktok_ads';
        }
        return 'web';
    }

    private function safe_user_agent($value)
    {
        $value = preg_replace('/[\x00-\x1f\x7f]/', '', (string) $value);
        return is_string($value) && $value !== '' ? substr($value, 0, 512) : null;
    }

    /** @param array<string,mixed> $payload */
    private function forward(array $payload, $event_id, $secret, $artifact_hash)
    {
        $body = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($body) || strlen($body) > 32768) {
            $this->fail('ccw_intake_payload_invalid', 503);
        }
        $signature = hash_hmac('sha256', $body, $secret);
        $url = CCW_Config::api_base() . '/api/intake/leads';
        $response = wp_safe_remote_post($url, array(
            'headers' => array(
                'Accept' => 'application/json',
                'Content-Type' => 'application/json',
                'X-CC-Signature' => $signature,
                'X-CC-Event-Id' => $event_id,
                'X-Clinicaclick-Web-Artifact' => $artifact_hash,
                'X-Clinicaclick-Plugin-Version' => CCW_VERSION,
            ),
            'body' => $body,
            'timeout' => 10,
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
            'limit_response_size' => 16384,
            'user-agent' => 'ClinicaClick-Web/' . CCW_VERSION . '; WordPress/' . get_bloginfo('version'),
        ));
        if (is_wp_error($response)) {
            $this->fail('ccw_intake_upstream_unavailable', 503);
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        if (!in_array($status, array(200, 201, 409), true)) {
            $this->fail('ccw_intake_upstream_rejected', 503);
        }
        $decoded = json_decode((string) wp_remote_retrieve_body($response), true);
        if (!is_array($decoded) || !isset($decoded['id']) || !$this->safe_lead_id($decoded['id'])) {
            $this->fail('ccw_intake_upstream_response_invalid', 503);
        }
    }

    private function safe_lead_id($value)
    {
        if (is_int($value)) {
            return $value > 0;
        }
        return is_string($value) && preg_match('/^[A-Za-z0-9_-]{1,128}$/', $value);
    }

    /**
     * Same-origin relay for the JavaScript channels (chat, telephone,
     * WhatsApp and generic web events). Public JavaScript supplies no secret;
     * this method replaces its routing fields with the signed local runtime
     * and signs the exact canonical body sent upstream.
     *
     * @param array<string,mixed> $server
     * @return array{status:int,body:array<string,mixed>,event_id:string}
     */
    public function process_event(array $server, $raw_body, $now = null)
    {
        $now = $now === null ? time() : (int) $now;
        if (strtoupper((string) ($server['REQUEST_METHOD'] ?? '')) !== 'POST') {
            $this->fail('ccw_event_bridge_method_not_allowed', 405);
        }
        $content_type = strtolower(trim(explode(';', (string) ($server['CONTENT_TYPE'] ?? ''))[0]));
        if ($content_type !== 'application/json') {
            $this->fail('ccw_event_bridge_content_type_unsupported', 415);
        }
        $length = strlen((string) $raw_body);
        if ($length < 2 || $length > 65536) {
            $this->fail('ccw_event_bridge_body_too_large', $length > 65536 ? 413 : 400);
        }
        if (isset($server['CONTENT_LENGTH']) && (string) $server['CONTENT_LENGTH'] !== '') {
            $declared = (string) $server['CONTENT_LENGTH'];
            if (!preg_match('/^[0-9]{1,8}$/', $declared) || (int) $declared !== $length) {
                $this->fail('ccw_event_bridge_content_length_invalid', 400);
            }
        }
        $wrapper_object = json_decode((string) $raw_body);
        if (!is_object($wrapper_object) || !is_object($wrapper_object->payload ?? null)) {
            $this->fail('ccw_event_bridge_body_invalid', 422);
        }
        $wrapper = get_object_vars($wrapper_object);
        $keys = array_keys($wrapper);
        sort($keys, SORT_STRING);
        $allowed_keys = array('endpoint', 'payload', 'schema_version');
        foreach (array('web_page_id', 'web_project_id', 'web_revision_id') as $optional_key) {
            if (array_key_exists($optional_key, $wrapper)) {
                $allowed_keys[] = $optional_key;
            }
        }
        sort($allowed_keys, SORT_STRING);
        if ($keys !== $allowed_keys || (int) ($wrapper['schema_version'] ?? 0) !== 1) {
            $this->fail('ccw_event_bridge_contract_invalid', 422);
        }
        $endpoint = trim((string) ($wrapper['endpoint'] ?? ''));
        if (!in_array($endpoint, array('leads', 'events', 'whatsapp-origin'), true)) {
            $this->fail('ccw_event_bridge_endpoint_invalid', 422);
        }
        $payload = json_decode(wp_json_encode($wrapper_object->payload), true);
        if (!is_array($payload)) {
            $this->fail('ccw_event_bridge_payload_invalid', 422);
        }

        $pointer = $this->cache->pointer();
        $manifest = is_array($pointer['manifest'] ?? null) ? $pointer['manifest'] : array();
        $artifact_hash = (string) ($pointer['active_hash'] ?? '');
        $runtime = is_array($pointer['runtime_configuration'] ?? null)
            ? $pointer['runtime_configuration']
            : CCW_Config::runtime_configuration();
        $measurement = is_array($runtime['measurement'] ?? null) ? $runtime['measurement'] : array();
        $secret = (string) ($measurement['hmac_key'] ?? '');
        if (
            ($pointer['status'] ?? '') !== 'active'
            || !preg_match('/^[a-f0-9]{64}$/', $artifact_hash)
            || (string) ($runtime['status'] ?? '') !== 'active'
            || !hash_equals($artifact_hash, (string) ($runtime['desired_artifact_hash'] ?? ''))
            || empty($measurement['enabled'])
            || !in_array((string) ($measurement['scope_type'] ?? ''), array('clinic', 'group'), true)
            || (int) ($measurement['scope_id'] ?? 0) < 1
            || strlen($secret) < 16
        ) {
            $this->fail('ccw_event_bridge_runtime_unavailable', 503);
        }

        $referer_value = trim((string) ($server['HTTP_REFERER'] ?? ''));
        $referer = parse_url($referer_value);
        if (
            $referer_value === ''
            || !$this->same_origin($referer_value, home_url('/'))
            || !is_array($referer)
            || !$this->safe_url_path((string) ($referer['path'] ?? ''))
        ) {
            $this->fail('ccw_event_bridge_referer_invalid', 403);
        }
        if (isset($server['HTTP_ORIGIN']) && trim((string) $server['HTTP_ORIGIN']) !== '') {
            $origin_value = trim((string) $server['HTTP_ORIGIN']);
            $origin = parse_url($origin_value);
            if (
                !is_array($origin)
                || !empty($origin['query'])
                || !empty($origin['fragment'])
                || !in_array((string) ($origin['path'] ?? ''), array('', '/'), true)
                || !$this->same_origin($origin_value, home_url('/'))
            ) {
                $this->fail('ccw_event_bridge_origin_invalid', 403);
            }
        }
        $has_landing_identity = $this->assert_event_artifact_identity(
            $wrapper,
            $manifest,
            (string) ($referer['path'] ?? '')
        );

        $ip = $this->client_ip($server);
        $this->consume_event_rate_limit($ip, $secret, $now);
        $event_id = trim((string) ($payload['event_id'] ?? ''));
        if (!preg_match('/^[A-Za-z0-9._:-]{8,128}$/', $event_id)) {
            $event_id = 'ccw_evt_' . hash_hmac('sha256', $artifact_hash . '|' . $endpoint . '|' . $ip . '|' . (int) floor($now / 60), $secret);
            $payload['event_id'] = $event_id;
        }

        // A signed landing must reach the public control-plane bridge with its
        // complete identity. That service resolves the active publication,
        // canonicalizes scope/URLs and attaches webLandingEventAttribution
        // before signing the internal intake request. The browser never sees
        // or supplies the installation HMAC.
        if ($has_landing_identity) {
            $wrapper['payload'] = $payload;
            return $this->forward_landing_event(
                $wrapper,
                $event_id,
                $artifact_hash,
                $referer_value,
                trim((string) ($server['HTTP_ORIGIN'] ?? ''))
            );
        }

        $submitted_clinic = isset($payload['clinic_id']) && preg_match('/^[1-9][0-9]*$/', (string) $payload['clinic_id'])
            ? (int) $payload['clinic_id']
            : null;
        foreach (array(
            'clinic_id', 'clinica_id', 'clinicId', 'clinicaId',
            'group_id', 'grupo_clinica_id', 'groupId', 'grupoClinicaId',
            'domain', 'page_url', 'pageUrl', 'event_source_url', 'eventSourceUrl',
            'web_project_id', 'web_revision_id', 'web_page_id', 'web_form_id',
        ) as $field) {
            unset($payload[$field]);
        }
        if ((string) $measurement['scope_type'] === 'clinic') {
            $payload['clinic_id'] = (int) $measurement['scope_id'];
        } else {
            $payload['group_id'] = (int) $measurement['scope_id'];
            // Only group lead routing may retain a selected clinic; the API
            // revalidates it against the signed IntakeConfig.locations list.
            if ($endpoint === 'leads' && $submitted_clinic !== null) {
                $payload['clinic_id'] = $submitted_clinic;
            }
        }
        unset($referer['fragment']);
        $page_url = $this->unparse_url($referer);
        $payload['domain'] = strtolower((string) ($referer['host'] ?? ''));
        $payload['page_url'] = $page_url;
        if ($endpoint === 'events') {
            $payload['event_source_url'] = $page_url;
        }
        return $this->forward_event($endpoint, $payload, $event_id, $secret, $artifact_hash);
    }

    /**
     * @param array<string,mixed> $wrapper
     * @param array<string,mixed> $manifest
     * @return bool True only for a complete, locally verified landing identity.
     */
    private function assert_event_artifact_identity(array $wrapper, array $manifest, $referer_path)
    {
        $identity_keys = array('web_project_id', 'web_revision_id', 'web_page_id');
        $present = array_values(array_filter($identity_keys, static function ($key) use ($wrapper) {
            return array_key_exists($key, $wrapper);
        }));
        if ($present === array()) {
            return false; // Measurement on ordinary WordPress pages, outside /cita.
        }
        if (count($present) !== count($identity_keys)) {
            $this->fail('ccw_event_bridge_identity_incomplete', 422);
        }
        foreach ($identity_keys as $identity_key) {
            if (trim((string) $wrapper[$identity_key]) === '') {
                $this->fail('ccw_event_bridge_identity_incomplete', 422);
            }
        }
        $project_id = $this->uuid($wrapper['web_project_id'], 'ccw_event_bridge_project_invalid');
        $revision_id = $this->uuid($wrapper['web_revision_id'], 'ccw_event_bridge_revision_invalid');
        $page_id = $this->uuid($wrapper['web_page_id'], 'ccw_event_bridge_page_invalid');
        $route = is_array($manifest['page_routes'][$page_id] ?? null) ? $manifest['page_routes'][$page_id] : array();
        $expected = parse_url(home_url('/cita' . (string) ($route['page_path'] ?? '')));
        if (
            !hash_equals(strtolower((string) ($manifest['project_id'] ?? '')), $project_id)
            || !hash_equals(strtolower((string) ($manifest['revision_id'] ?? '')), $revision_id)
            || !is_array($expected)
            || !hash_equals((string) ($expected['path'] ?? ''), (string) $referer_path)
        ) {
            $this->fail('ccw_event_bridge_identity_mismatch', 409);
        }
        return true;
    }

    private function unparse_url(array $parts)
    {
        $scheme = isset($parts['scheme']) ? $parts['scheme'] . '://' : '';
        $host = (string) ($parts['host'] ?? '');
        $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
        $path = (string) ($parts['path'] ?? '/');
        $query = isset($parts['query']) && $parts['query'] !== '' ? '?' . $parts['query'] : '';
        return $scheme . $host . $port . $path . $query;
    }

    private function consume_event_rate_limit($ip, $secret, $now)
    {
        $this->cache->initialize();
        $path = $this->cache->root() . '/event-rate-limit.json';
        $handle = fopen($path, 'c+');
        if (!is_resource($handle) || !flock($handle, LOCK_EX)) {
            if (is_resource($handle)) fclose($handle);
            $this->fail('ccw_event_bridge_rate_limit_unavailable', 503);
        }
        try {
            $decoded = json_decode((string) stream_get_contents($handle), true);
            $state = is_array($decoded) ? $decoded : array();
            $key = hash_hmac('sha256', (string) $ip, $secret);
            $entries = array_values(array_filter((array) ($state[$key] ?? array()), static function ($timestamp) use ($now) {
                return is_int($timestamp) && $timestamp > $now - 600 && $timestamp <= $now + 60;
            }));
            if (count($entries) >= 300) {
                $this->fail('ccw_event_bridge_rate_limited', 429);
            }
            $entries[] = $now;
            $next = array($key => $entries);
            foreach ($state as $state_key => $timestamps) {
                if ($state_key === $key || !preg_match('/^[a-f0-9]{64}$/', (string) $state_key)) continue;
                $recent = array_values(array_filter((array) $timestamps, static function ($timestamp) use ($now) {
                    return is_int($timestamp) && $timestamp > $now - 600 && $timestamp <= $now + 60;
                }));
                if ($recent !== array()) $next[$state_key] = $recent;
                if (count($next) >= 1000) break;
            }
            $json = wp_json_encode($next, JSON_UNESCAPED_SLASHES);
            rewind($handle);
            if (!is_string($json) || !ftruncate($handle, 0) || fwrite($handle, $json) !== strlen($json) || !fflush($handle)) {
                $this->fail('ccw_event_bridge_rate_limit_unavailable', 503);
            }
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** @param array<string,mixed> $payload */
    private function forward_event($endpoint, array $payload, $event_id, $secret, $artifact_hash)
    {
        $body = wp_json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($body) || strlen($body) > 65536) {
            $this->fail('ccw_event_bridge_payload_invalid', 413);
        }
        $url = CCW_Config::api_base() . '/api/intake/' . $endpoint;
        $response = wp_safe_remote_post($url, array(
            'headers' => array(
                'Accept' => 'application/json',
                'Content-Type' => 'application/json',
                'X-CC-Signature' => hash_hmac('sha256', $body, $secret),
                'X-CC-Event-Id' => $event_id,
                'X-Clinicaclick-Web-Artifact' => $artifact_hash,
                'X-Clinicaclick-Plugin-Version' => CCW_VERSION,
            ),
            'body' => $body,
            'timeout' => 10,
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
            'limit_response_size' => 16384,
            'user-agent' => 'ClinicaClick-Web/' . CCW_VERSION . '; WordPress/' . get_bloginfo('version'),
        ));
        if (is_wp_error($response)) {
            $this->fail('ccw_event_bridge_upstream_unavailable', 503);
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        if (!in_array($status, array(200, 201, 409), true)) {
            $this->fail('ccw_event_bridge_upstream_rejected', 503);
        }
        $decoded = json_decode((string) wp_remote_retrieve_body($response), true);
        if (!is_array($decoded)) {
            $decoded = array('success' => true);
        }
        return array('status' => $status === 409 ? 200 : $status, 'body' => $decoded, 'event_id' => $event_id);
    }

    /** @param array<string,mixed> $wrapper */
    private function forward_landing_event(array $wrapper, $event_id, $artifact_hash, $referer, $origin)
    {
        $body = wp_json_encode($wrapper, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($body) || strlen($body) > 65536) {
            $this->fail('ccw_event_bridge_payload_invalid', 413);
        }
        $headers = array(
            'Accept' => 'application/json',
            'Content-Type' => 'application/json',
            'Referer' => (string) $referer,
            'X-CC-Event-Id' => $event_id,
            'X-Clinicaclick-Web-Artifact' => $artifact_hash,
            'X-Clinicaclick-Plugin-Version' => CCW_VERSION,
        );
        if ((string) $origin !== '') {
            $headers['Origin'] = (string) $origin;
        }
        $response = wp_safe_remote_post(CCW_Config::api_base() . self::EVENT_ENDPOINT_PATH, array(
            'headers' => $headers,
            'body' => $body,
            'timeout' => 10,
            'redirection' => 0,
            'blocking' => true,
            'data_format' => 'body',
            'limit_response_size' => 16384,
            'user-agent' => 'ClinicaClick-Web/' . CCW_VERSION . '; WordPress/' . get_bloginfo('version'),
        ));
        if (is_wp_error($response)) {
            $this->fail('ccw_event_bridge_upstream_unavailable', 503);
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        if (!in_array($status, array(200, 201, 409), true)) {
            $this->fail('ccw_event_bridge_upstream_rejected', 503);
        }
        $decoded = json_decode((string) wp_remote_retrieve_body($response), true);
        if (!is_array($decoded)) {
            $decoded = array('success' => true);
        }
        return array('status' => $status === 409 ? 200 : $status, 'body' => $decoded, 'event_id' => $event_id);
    }

    /** @param array<string,mixed> $body */
    private function emit_json($status, array $body)
    {
        $status = in_array((int) $status, array(200, 201, 400, 403, 405, 409, 413, 415, 422, 429, 503), true)
            ? (int) $status
            : 503;
        status_header($status);
        nocache_headers();
        if ($status === 405) header('Allow: POST');
        if ($status === 429) header('Retry-After: 600');
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Security-Policy: default-src \'none\'; frame-ancestors \'none\'; base-uri \'none\'');
        header('Referrer-Policy: no-referrer');
        header('X-Content-Type-Options: nosniff');
        echo wp_json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    private function emit_redirect($location)
    {
        status_header(303);
        nocache_headers();
        header('Location: ' . $location, true, 303);
        header('Referrer-Policy: no-referrer');
        header('X-Content-Type-Options: nosniff');
        exit;
    }

    private function emit_error($status)
    {
        $status = in_array((int) $status, array(400, 403, 405, 409, 413, 415, 422, 429, 503), true) ? (int) $status : 400;
        status_header($status);
        nocache_headers();
        if ($status === 405) {
            header('Allow: POST');
        }
        if ($status === 429) {
            header('Retry-After: 600');
        }
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Security-Policy: default-src \'none\'; frame-ancestors \'none\'; base-uri \'none\'');
        header('Referrer-Policy: no-referrer');
        header('X-Content-Type-Options: nosniff');
        if ($status === 429) {
            echo 'Has realizado demasiados intentos. Inténtalo de nuevo más tarde.';
        } elseif ($status === 413) {
            echo 'El formulario supera el tamaño permitido.';
        } elseif ($status === 503) {
            echo 'No hemos podido enviar el formulario. Inténtalo de nuevo.';
        } else {
            echo 'No hemos podido enviar el formulario. Revisa los datos e inténtalo de nuevo.';
        }
        exit;
    }

    private function fail($code, $http_status)
    {
        throw new CCW_Error((string) $code, 'La solicitud del formulario no es válida.', array(
            'http_status' => (int) $http_status,
        ));
    }
}
