<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Admin
{
    public function register()
    {
        add_action('admin_menu', array($this, 'menu'));
        add_action('admin_post_ccw_save_configuration', array($this, 'save_configuration'));
        add_action('admin_post_ccw_sync_now', array($this, 'sync_now'));
        add_action('admin_post_ccw_rollback_local', array($this, 'rollback_local'));
        add_action('admin_notices', array($this, 'notice'));
    }

    public function menu()
    {
        add_options_page(
            'ClinicaClick Web',
            'ClinicaClick Web',
            'manage_options',
            'clinicaclick-web',
            array($this, 'page')
        );
    }

    public function page()
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('No tienes permiso para gestionar esta instalación.', 'clinicaclick-web'));
        }
        $installation_id = '';
        $api_base = '';
        try {
            $installation_id = CCW_Config::installation_id();
            $api_base = CCW_Config::api_base();
        } catch (CCW_Error $error) {
            // Render the form without reflecting an invalid secret or payload.
        }
        $pointer = (new CCW_Cache())->pointer();
        $sync = CCW_Config::sync_state();
        $managed = defined('CLINICACLICK_WEB_INSTALLATION_ID') || defined('CLINICACLICK_WEB_API_BASE') || CCW_Config::provisioned() !== array();
        ?>
        <div class="wrap">
            <h1>ClinicaClick Web</h1>
            <p>Publica landings firmadas en <code>/cita/</code> y conserva localmente la última versión válida.</p>

            <h2>Estado</h2>
            <table class="widefat striped" style="max-width:900px">
                <tbody>
                    <tr><th>Plugin</th><td><?php echo esc_html(CCW_VERSION); ?></td></tr>
                    <tr><th>Configuración</th><td><?php echo CCW_Config::is_configured() ? 'Completa' : 'Pendiente'; ?></td></tr>
                    <tr><th>Publicación local</th><td><?php echo esc_html((string) ($pointer['status'] ?? 'Sin contenido')); ?></td></tr>
                    <tr><th>Artefacto activo</th><td><code><?php echo esc_html(self::short_hash($pointer['active_hash'] ?? null)); ?></code></td></tr>
                    <tr><th>Última sincronización correcta</th><td><?php echo esc_html((string) ($sync['last_success_at'] ?? 'Todavía no')); ?></td></tr>
                    <tr><th>Último resultado</th><td><code><?php echo esc_html((string) ($sync['last_result'] ?? 'pendiente')); ?></code></td></tr>
                </tbody>
            </table>

            <h2>Conexión</h2>
            <?php if ($managed) : ?>
                <p>Esta instalación está configurada mediante constantes del servidor.</p>
            <?php else : ?>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="max-width:900px">
                    <input type="hidden" name="action" value="ccw_save_configuration">
                    <?php wp_nonce_field('ccw_save_configuration'); ?>
                    <table class="form-table" role="presentation">
                        <tr>
                            <th><label for="ccw-installation-id">Installation ID</label></th>
                            <td><input id="ccw-installation-id" name="installation_id" class="regular-text code" value="<?php echo esc_attr($installation_id); ?>" autocomplete="off" required></td>
                        </tr>
                        <tr>
                            <th><label for="ccw-api-base">API base</label></th>
                            <td><input id="ccw-api-base" name="api_base" type="url" class="regular-text code" value="<?php echo esc_attr($api_base); ?>" placeholder="https://crm.clinicaclick.com" required></td>
                        </tr>
                        <tr>
                            <th><label for="ccw-token">Token opaco</label></th>
                            <td><input id="ccw-token" name="token" type="password" class="regular-text" value="" autocomplete="new-password" placeholder="<?php echo CCW_Config::has_token() ? 'Ya configurado; deja vacío para conservarlo' : 'Pega el token de instalación'; ?>"><p class="description">El token nunca se vuelve a mostrar ni se incluye en logs o reportes.</p></td>
                        </tr>
                        <tr>
                            <th><label for="ccw-key-descriptor">Descriptor público inicial</label></th>
                            <td><textarea id="ccw-key-descriptor" name="key_descriptor" class="large-text code" rows="6" placeholder='{"schema_version":1,"algorithm":"Ed25519","key_id":"…","public_key_base64":"…"}'></textarea><p class="description">Se pega una sola vez desde un canal confiable. Las rotaciones posteriores deben venir firmadas por una clave ya confiada. Nunca pegues una clave privada.</p></td>
                        </tr>
                    </table>
                    <?php submit_button('Guardar configuración'); ?>
                </form>
            <?php endif; ?>

            <h2>Operación</h2>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="ccw_sync_now">
                    <?php wp_nonce_field('ccw_sync_now'); ?>
                    <?php submit_button(!empty($pointer['manual_hold']) ? 'Reanudar y sincronizar' : 'Sincronizar ahora', 'primary', 'submit', false); ?>
                </form>
                <?php if (!empty($pointer['last_known_good_hash']) && ($pointer['last_known_good_hash'] ?? '') !== ($pointer['active_hash'] ?? '')) : ?>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" onsubmit="return confirm('¿Restaurar la versión local anterior y pausar la sincronización automática?');">
                        <input type="hidden" name="action" value="ccw_rollback_local">
                        <?php wp_nonce_field('ccw_rollback_local'); ?>
                        <?php submit_button('Rollback local', 'secondary', 'submit', false); ?>
                    </form>
                <?php endif; ?>
            </div>
            <p class="description">El rollback local activa una retención manual. “Reanudar y sincronizar” vuelve a aplicar el estado firmado más reciente.</p>
        </div>
        <?php
    }

    public function save_configuration()
    {
        $this->authorize('ccw_save_configuration');
        try {
            CCW_Config::save_admin_configuration(array(
                'installation_id' => sanitize_text_field(wp_unslash($_POST['installation_id'] ?? '')),
                'api_base' => esc_url_raw(wp_unslash($_POST['api_base'] ?? '')),
                'token' => trim((string) wp_unslash($_POST['token'] ?? '')),
            ));
            $descriptor = trim((string) wp_unslash($_POST['key_descriptor'] ?? ''));
            if ($descriptor !== '') {
                CCW_Trust_Store::import_configured_descriptor($descriptor);
            }
            $this->redirect_notice('success', 'Configuración guardada. Ya puedes sincronizar.');
        } catch (CCW_Error $error) {
            $this->redirect_notice('error', $error->getMessage());
        }
    }

    public function sync_now()
    {
        $this->authorize('ccw_sync_now');
        try {
            $result = (new CCW_Sync())->run(true);
            $this->redirect_notice('success', 'Sincronización completada: ' . (string) $result['result'] . '.');
        } catch (CCW_Error $error) {
            $this->redirect_notice('error', $error->getMessage() . ' [' . $error->error_code() . ']');
        }
    }

    public function rollback_local()
    {
        $this->authorize('ccw_rollback_local');
        try {
            $pointer = (new CCW_Cache())->rollback_local();
            (new CCW_HTTP())->report(array(
                'schema_version' => 1,
                'event' => 'local_rollback',
                'plugin_version' => CCW_VERSION,
                'wordpress_version' => get_bloginfo('version'),
                'php_version' => PHP_VERSION,
                'site_hash' => hash('sha256', home_url('/')),
                'status' => 'active',
                'active_artifact_hash' => $pointer['active_hash'],
                'result' => 'local_rollback',
                'duration_ms' => 0,
                'reported_at' => gmdate('c'),
            ));
            $this->redirect_notice('warning', 'Se ha restaurado la última versión válida. La sincronización automática queda pausada hasta que la reanudes.');
        } catch (CCW_Error $error) {
            $this->redirect_notice('error', $error->getMessage());
        }
    }

    public function notice()
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $key = 'ccw_admin_notice_' . get_current_user_id();
        $notice = get_transient($key);
        if (!is_array($notice)) {
            return;
        }
        delete_transient($key);
        $type = in_array($notice['type'] ?? '', array('success', 'error', 'warning', 'info'), true) ? $notice['type'] : 'info';
        echo '<div class="notice notice-' . esc_attr($type) . ' is-dismissible"><p>' . esc_html((string) ($notice['message'] ?? '')) . '</p></div>';
    }

    private function authorize($nonce_action)
    {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('No tienes permiso para realizar esta acción.', 'clinicaclick-web'));
        }
        check_admin_referer($nonce_action);
    }

    private function redirect_notice($type, $message)
    {
        set_transient('ccw_admin_notice_' . get_current_user_id(), array(
            'type' => $type,
            'message' => (string) $message,
        ), 60);
        wp_safe_redirect(admin_url('options-general.php?page=clinicaclick-web'));
        exit;
    }

    private static function short_hash($hash)
    {
        return is_string($hash) && preg_match('/^[a-f0-9]{64}$/', $hash)
            ? substr($hash, 0, 12) . '…'
            : '—';
    }
}
