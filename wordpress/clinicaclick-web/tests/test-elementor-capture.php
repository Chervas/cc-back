<?php
require __DIR__ . '/bootstrap.php';
define('CCW_ELEMENTOR_CAPTURE', true);

function wp_get_referer() { return $GLOBALS['elementor_referer']; }
function sanitize_textarea_field($value) { return trim(strip_tags($value)); }
function sanitize_text_field($value) { return trim(strip_tags($value)); }
function sanitize_email($value) { return filter_var($value, FILTER_VALIDATE_EMAIL) ?: ''; }
function sanitize_key($value) { return preg_replace('/[^a-z0-9_-]/', '', strtolower($value)); }
function wp_unslash($value) { return stripslashes($value); }
function wp_generate_uuid4() { return '9d29153b-0879-4fc5-aec6-2fd455f25dbe'; }
function wp_salt($name) { return 'fictitious-worker-only-salt'; }
function add_option($key, $value, $_deprecated, $autoload) {
    if (get_option($key) !== false) return false;
    return update_option($key, $value, $autoload);
}
function wp_schedule_single_event($at, $hook, $args) { $GLOBALS['elementor_scheduled'][] = [$at, $hook, $args]; }
function wp_clear_scheduled_hook($hook, $args) { $GLOBALS['elementor_unscheduled'][] = [$hook, $args]; }

function check($condition, $message) {
    if (!$condition) throw new RuntimeException($message);
}
final class ElementorTestRecord {
    public function get($key) {
        return [
            'name' => ['type' => 'text', 'title' => 'Tu nombre', 'value' => 'Persona ficticia'],
            'email' => ['type' => 'email', 'value' => 'qa@example.test'],
            'field_tel' => ['type' => 'tel', 'value' => '600111222'],
            'captcha' => ['type' => 'recaptcha', 'value' => 'never-transmit'],
        ];
    }
    public function get_form_settings($key) { return ['id' => 'test1', 'form_name' => 'Formulario ficticio'][$key]; }
}
$installation = '37b7858a-4819-4e19-837f-bee4598f5945';
$api = 'https://api.example.test';
$secret = 'fictional-measurement-secret-for-tests';
update_option(CCW_Config::OPTION_INSTALLATION_ID, $installation, false);
update_option(CCW_Config::OPTION_API_BASE, $api, false);
update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 32), false);
CCW_Config::set_runtime_configuration(['installation_id' => $installation,
    'measurement' => ['enabled' => true, 'scope_type' => 'clinic', 'scope_id' => 72, 'hmac_key' => $secret]]);
$GLOBALS['elementor_referer'] = 'https://cliente.example.test/portada/?gclid=blocked';
$GLOBALS['elementor_scheduled'] = [];
$event = wp_generate_uuid4();
$_POST['ccw_form_context'] = addslashes(json_encode(['event_id' => $event, 'gclid' => 'blocked',
    'consent' => ['ad_storage' => 'denied', 'ad_user_data' => 'denied']]));
$bridge = new CCW_Intake_Bridge();
$bridge->capture_elementor(new ElementorTestRecord());
$bridge->capture_elementor(new ElementorTestRecord());
$key = CCW_Intake_Bridge::ELEMENTOR_OUTBOX . $event;
check(count($GLOBALS['elementor_scheduled']) === 1, 'stable event queued once before redirect');
check(strpos(json_encode(get_option($key)), 'qa@example.test') === false && is_array(get_option($key)), 'outbox is encrypted');
check(count($GLOBALS['ccw_test_posts']) === 0, 'browser redirect is independent of network delivery');
$GLOBALS['ccw_test_http'][$api . '/api/intake/leads'] = ['code' => 503];
$bridge->retry_elementor($event);
check(get_option($key)['attempt'] === 1, 'temporary failure retained');
$GLOBALS['ccw_test_http'][$api . '/api/intake/leads'] = ['code' => 409];
$bridge->retry_elementor($event);
check(get_option($key) === false, 'duplicate acknowledgement clears persisted data');
foreach ($GLOBALS['ccw_test_posts'] as $request) {
    $args = $request['args'];
    $payload = json_decode($args['body'], true);
    check($payload['clinic_id'] === 72 && $payload['external_id'] === $event, 'signed installation scope and stable id');
    check($args['headers']['X-CC-Signature'] === hash_hmac('sha256', $args['body'], $secret), 'request is signed server-side');
    check($payload['page_url'] === 'https://cliente.example.test/portada/' && !isset($payload['gclid']), 'advertising consent respected');
    check($payload['form_submission']['fields']['field_tel'] === '600111222' && !isset($payload['form_submission']['fields']['captcha']), 'contact fields preserved without anti-spam secret');
}
$GLOBALS['elementor_referer'] = 'https://different.example.test/';
$bridge->capture_elementor(new ElementorTestRecord());
check(get_option($key) === false, 'cross-origin source rejected');
echo "Elementor capture and retries passed.\n";
