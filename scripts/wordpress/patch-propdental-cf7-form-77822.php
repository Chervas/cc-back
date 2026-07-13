<?php

/**
 * Remove the ambiguous "Sin preferencia" recipient from Propdental's general
 * appointment form. The select is already required, so after this change a
 * real clinic must be selected before Contact Form 7 accepts the submission.
 *
 * Dry-run (default):
 *   wp eval-file patch-propdental-cf7-form-77822.php
 *
 * Apply after reviewing the dry-run:
 *   CC_APPLY=1 wp eval-file patch-propdental-cf7-form-77822.php
 */

const CC_PROPDENTAL_CF7_FORM_ID = 77822;

/**
 * Pure transformation kept separate so it can be tested without WordPress.
 *
 * @return array{form:string,status:string,removed:int}
 */
function cc_patch_propdental_cf7_clinic_choice(string $form): array
{
    $requiredNeedles = [
        '[select* clinica',
        'first_as_label "Elige una Clínica"',
        '"Propdental Sants|',
        '"Propdental Sant Martí|',
        '"Propdental Nou Barris|',
        '"Propdental Badalona|',
        '"Propdental Hospitalet de Llobregat|',
    ];

    foreach ($requiredNeedles as $needle) {
        if (substr_count($form, $needle) !== 1) {
            throw new RuntimeException(sprintf(
                'CF7 form 77822 does not match the expected structure (%s)',
                $needle
            ));
        }
    }

    $occurrences = substr_count($form, '"Sin preferencia|');
    if ($occurrences === 0) {
        return ['form' => $form, 'status' => 'already_patched', 'removed' => 0];
    }
    if ($occurrences !== 1) {
        throw new RuntimeException(sprintf(
            'Expected one "Sin preferencia" option, found %d',
            $occurrences
        ));
    }

    $pattern = '/^[\h]*"Sin preferencia\|[^"\r\n]*"[\h]*(?:\r?\n|$)/m';
    $updated = preg_replace($pattern, '', $form, -1, $removed);
    if (!is_string($updated) || $removed !== 1 || strpos($updated, 'Sin preferencia') !== false) {
        throw new RuntimeException('Could not remove the ambiguous clinic option safely');
    }

    return ['form' => $updated, 'status' => 'ready_to_apply', 'removed' => $removed];
}

// Unit tests can load the pure function without bootstrapping WP-CLI.
if (defined('CC_CF7_PATCH_LIBRARY_ONLY') && CC_CF7_PATCH_LIBRARY_ONLY) {
    return;
}

if (!defined('WP_CLI') || !WP_CLI) {
    throw new RuntimeException('Run this file with wp eval-file');
}

$post = get_post(CC_PROPDENTAL_CF7_FORM_ID);
if (!$post || $post->post_type !== 'wpcf7_contact_form') {
    WP_CLI::error('Contact Form 7 form 77822 was not found');
}
if (trim((string) $post->post_title) !== 'Formulario pedir cita general PRINCIPAL') {
    WP_CLI::error(sprintf('Unexpected form title: %s', (string) $post->post_title));
}

$current = (string) get_post_meta(CC_PROPDENTAL_CF7_FORM_ID, '_form', true);
try {
    $result = cc_patch_propdental_cf7_clinic_choice($current);
} catch (Throwable $error) {
    WP_CLI::error($error->getMessage());
}

$summary = [
    'form_id' => CC_PROPDENTAL_CF7_FORM_ID,
    'status' => $result['status'],
    'removed_options' => $result['removed'],
    'before_sha256' => hash('sha256', $current),
    'after_sha256' => hash('sha256', $result['form']),
    'apply_requested' => getenv('CC_APPLY') === '1',
];
WP_CLI::line((string) wp_json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

if ($result['status'] === 'already_patched') {
    WP_CLI::success('The form already requires a concrete clinic');
    return;
}

if (getenv('CC_APPLY') !== '1') {
    WP_CLI::success('Dry-run complete; no WordPress data changed');
    return;
}

$updated = update_post_meta(CC_PROPDENTAL_CF7_FORM_ID, '_form', $result['form']);
if ($updated === false) {
    WP_CLI::error('WordPress did not persist the corrected form');
}

clean_post_cache(CC_PROPDENTAL_CF7_FORM_ID);
$stored = (string) get_post_meta(CC_PROPDENTAL_CF7_FORM_ID, '_form', true);
if (!hash_equals(hash('sha256', $result['form']), hash('sha256', $stored))) {
    WP_CLI::error('Post-update verification failed');
}

WP_CLI::success('Form 77822 now requires one of the five concrete clinics');
