<?php

require __DIR__ . '/bootstrap.php';

$payload = json_decode((string) stream_get_contents(STDIN), true);
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
