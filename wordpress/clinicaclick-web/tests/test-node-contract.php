<?php

require __DIR__ . '/bootstrap.php';

$wire = (string) stream_get_contents(STDIN);
$payload = json_decode($wire, true);
ccw_test_assert(is_array($payload), 'Node contract fixture is not JSON');
CCW_Trust_Store::import_configured_descriptor($payload['descriptor']);

$manifest = CCW_Manifest::verify(
    $payload['manifest'],
    $payload['manifest_envelope'],
    $payload['manifest']['artifact_hash'],
    array(),
    $payload['descriptor']['key_id']
);
ccw_test_assert($manifest['artifact_hash'] === str_repeat('a', 64), 'Node manifest signature was not accepted');

$runtime = CCW_Manifest::verify_runtime_configuration(
    $payload['runtime'],
    $payload['runtime_envelope'],
    'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    $payload['descriptor']['key_id']
);
ccw_test_assert($runtime['sequence'] === 1, 'Node runtime signature was not accepted');

echo "ok - Node backend Ed25519 contract is compatible with PHP plugin\n";

// Exercise Node serialization -> HTTP transport -> PHP decoding -> signature,
// including the empty object that associative JSON decoding otherwise loses.
update_option(CCW_Config::OPTION_INSTALLATION_ID, $payload['runtime']['installation_id']);
update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));
$url = CCW_Config::api_base() . '/api/marketing/web-installations/'
    . CCW_Config::installation_id() . '/desired-state';
$GLOBALS['ccw_test_http'][$url] = array('code' => 200, 'body' => '{"desired_state":' . $wire . '}');
$decoded = (new CCW_HTTP())->desired_state()['desired_state'];
$registry = CCW_Manifest::verify_registry_configuration(
    $decoded['registry_configuration'], $decoded['registry_configuration_envelope'],
    CCW_Config::installation_id(), $payload['descriptor']['key_id']
);
ccw_test_assert($registry['routes'] === array(), 'Node empty routes object was not accepted');
foreach (array('empty-list', 'sequence') as $mutation) {
    $tampered = json_decode($wire);
    if ($mutation === 'empty-list') $tampered->registry_configuration->routes = array();
    else $tampered->registry_configuration->sequence++;
    $GLOBALS['ccw_test_http'][$url]['body'] = json_encode(array('desired_state' => $tampered));
    $decoded = (new CCW_HTTP())->desired_state()['desired_state'];
    $rejected = false;
    try {
        CCW_Manifest::verify_registry_configuration(
            $decoded['registry_configuration'], $decoded['registry_configuration_envelope'],
            CCW_Config::installation_id(), $payload['descriptor']['key_id']
        );
    } catch (CCW_Error $error) {
        $rejected = $error->error_code() === 'ccw_registry_signature_invalid';
    }
    ccw_test_assert($rejected, 'Tampered Node registry was accepted: ' . $mutation);
}
echo "ok - Node empty registry survives HTTP decoding and rejects wire tampering\n";
