<?php

declare(strict_types=1);

define('CC_CF7_PATCH_LIBRARY_ONLY', true);
require __DIR__ . '/../../../scripts/wordpress/patch-propdental-cf7-form-77822.php';

$fixture = <<<'FORM'
[select* clinica id:campoclinicas first_as_label "Elige una Clínica"
"Sin preferencia|all@example.test"
"Propdental Sants|sants@example.test"
"Propdental Sant Martí|santmarti@example.test"
"Propdental Nou Barris|noubarris@example.test"
"Propdental Badalona|badalona@example.test"
"Propdental Hospitalet de Llobregat|hospitalet@example.test"]
FORM;

$first = cc_patch_propdental_cf7_clinic_choice($fixture);
if ($first['status'] !== 'ready_to_apply' || $first['removed'] !== 1) {
    throw new RuntimeException('The ambiguous option was not removed');
}
if (strpos($first['form'], 'Sin preferencia') !== false) {
    throw new RuntimeException('The transformed form remains ambiguous');
}
if (substr_count($first['form'], 'Propdental ') !== 5) {
    throw new RuntimeException('The transformed form does not contain all five clinics');
}

$second = cc_patch_propdental_cf7_clinic_choice($first['form']);
if ($second['status'] !== 'already_patched' || $second['form'] !== $first['form']) {
    throw new RuntimeException('The patch is not idempotent');
}

$invalid = str_replace('"Propdental Badalona|badalona@example.test"', '', $fixture);
try {
    cc_patch_propdental_cf7_clinic_choice($invalid);
    throw new RuntimeException('An incomplete clinic list was accepted');
} catch (RuntimeException $error) {
    if (strpos($error->getMessage(), 'expected structure') === false) {
        throw $error;
    }
}

echo "propdental_cf7_clinic_choice.test.php OK\n";
