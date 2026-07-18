<?php

define('CCW_TESTING', true);
define('ABSPATH', __DIR__ . '/wp/');
define('WP_CONTENT_DIR', __DIR__ . '/tmp/wp-content');
define('CCW_VERSION', '2.0.0-alpha.7');
define('DAY_IN_SECONDS', 86400);
define('MINUTE_IN_SECONDS', 60);

$GLOBALS['ccw_test_options'] = array();
$GLOBALS['ccw_test_http'] = array();
$GLOBALS['ccw_test_posts'] = array();
$GLOBALS['ccw_test_gets'] = array();

final class WP_Error
{
    public $message;
    public function __construct($message)
    {
        $this->message = $message;
    }
}

function get_option($key, $default = false)
{
    return array_key_exists($key, $GLOBALS['ccw_test_options']) ? $GLOBALS['ccw_test_options'][$key] : $default;
}

function update_option($key, $value, $autoload = null)
{
    $GLOBALS['ccw_test_options'][$key] = $value;
    return true;
}

function delete_option($key)
{
    unset($GLOBALS['ccw_test_options'][$key]);
    return true;
}

function wp_mkdir_p($path)
{
    return is_dir($path) || mkdir($path, 0750, true);
}

function home_url($path = '')
{
    return 'https://cliente.example.test' . $path;
}

function get_bloginfo($field)
{
    return $field === 'version' ? '6.6-test' : '';
}

function esc_attr($value)
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function wp_json_encode($value, $flags = 0)
{
    return json_encode($value, $flags);
}

function wp_http_validate_url($url)
{
    $parts = parse_url((string) $url);
    if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])) {
        return false;
    }
    $host = strtolower((string) $parts['host']);
    if ($host === 'localhost' || filter_var($host, FILTER_VALIDATE_IP)) {
        return false;
    }
    return true;
}

function is_wp_error($value)
{
    return $value instanceof WP_Error;
}

function wp_safe_remote_get($url, $args = array())
{
    $GLOBALS['ccw_test_gets'][] = array('url' => $url, 'args' => $args);
    if (!isset($GLOBALS['ccw_test_http'][$url])) {
        return new WP_Error('missing fixture');
    }
    $fixture = $GLOBALS['ccw_test_http'][$url];
    if (is_callable($fixture)) {
        $fixture = $fixture($url, $args);
    }
    if ($fixture instanceof WP_Error) {
        return $fixture;
    }
    $body = (string) ($fixture['body'] ?? '');
    if (!empty($args['stream'])) {
        if (file_put_contents((string) $args['filename'], $body) !== strlen($body)) {
            return new WP_Error('write failed');
        }
        $body = '';
    }
    return array(
        'response' => array('code' => (int) ($fixture['code'] ?? 200)),
        'headers' => $fixture['headers'] ?? array(),
        'body' => $body,
    );
}

function wp_safe_remote_post($url, $args = array())
{
    $GLOBALS['ccw_test_posts'][] = array('url' => $url, 'args' => $args);
    if (isset($GLOBALS['ccw_test_http'][$url])) {
        $fixture = $GLOBALS['ccw_test_http'][$url];
        if (is_callable($fixture)) {
            $fixture = $fixture($url, $args);
        }
        if ($fixture instanceof WP_Error) {
            return $fixture;
        }
        return array(
            'response' => array('code' => (int) ($fixture['code'] ?? 200)),
            'headers' => $fixture['headers'] ?? array(),
            'body' => (string) ($fixture['body'] ?? ''),
        );
    }
    return array('response' => array('code' => 202), 'headers' => array(), 'body' => '');
}

function wp_remote_retrieve_response_code($response)
{
    return (int) ($response['response']['code'] ?? 0);
}

function wp_remote_retrieve_body($response)
{
    return (string) ($response['body'] ?? '');
}

function wp_remote_retrieve_header($response, $name)
{
    $headers = $response['headers'] ?? array();
    foreach ($headers as $key => $value) {
        if (strtolower((string) $key) === strtolower((string) $name)) {
            return $value;
        }
    }
    return '';
}

$base = dirname(__DIR__) . '/includes/';
require_once $base . 'class-ccw-error.php';
require_once $base . 'class-ccw-json.php';
require_once $base . 'class-ccw-config.php';
require_once $base . 'class-ccw-trust-store.php';
require_once $base . 'class-ccw-manifest.php';
require_once $base . 'class-ccw-cache.php';
require_once $base . 'class-ccw-http.php';
require_once $base . 'class-ccw-sync.php';
require_once $base . 'class-ccw-intake-bridge.php';
require_once $base . 'class-ccw-router.php';

function ccw_test_assert($condition, $message)
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function ccw_test_throws($code, callable $callback)
{
    try {
        $callback();
    } catch (CCW_Error $error) {
        ccw_test_assert($error->error_code() === $code, 'Expected ' . $code . ', got ' . $error->error_code());
        return;
    }
    throw new RuntimeException('Expected exception ' . $code);
}

function ccw_test_remove_tree($path)
{
    if (!is_dir($path)) {
        return;
    }
    foreach (scandir($path) ?: array() as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }
        $child = $path . '/' . $item;
        if (is_dir($child) && !is_link($child)) {
            ccw_test_remove_tree($child);
        } else {
            unlink($child);
        }
    }
    rmdir($path);
}
