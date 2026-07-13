# Pruebas E2E controladas del intake y limpieza

Este procedimiento cubre pruebas del intake de Clinicaclick en entornos reales o
equivalentes. Toda prueba debe poder identificarse, auditarse y eliminarse sin
tocar leads ajenos.

## Preparar la prueba

1. Crear un marcador único, por ejemplo `CC-E2E-20260713-073000`.
2. Usar ese marcador exacto como nombre del lead y, si se crea una cita, dentro
   de su título o motivo. Usar solo email y teléfono controlados por el equipo.
3. Abrir una sesión privada nueva del navegador. Guardar el identificador de
   cada sesión antes de cerrar su pestaña:

   ```js
   sessionStorage.getItem('cc_session_id')
   ```

4. Guardar cada `LeadIntake.id` devuelto por `POST /api/intake/leads`. Si se crea
   una cita de prueba, guardar también su `CitasPacientes.id_cita`. La limpieza
   nunca descubre identificadores únicamente a partir de texto libre.
5. Cerrar todas las pestañas de prueba para que no emitan nuevos `WebEvents`
   durante la limpieza.
6. Si un lead contiene `gclid`, `gbraid` o `wbraid`, esperar a que cada
   `GoogleAdsConversionUploadAttempt` relacionado tenga diagnóstico terminal.
   Los estados `pending` y `accepted` bloquean la limpieza deliberadamente.

Las citas solo son eliminables si contienen el marcador y no tienen
`paciente_id`. No se debe crear un paciente real en esta prueba. QuickChat solo
se limpia si es una conversación aislada con exactamente un
`quickchat_summary` oculto; cualquier mensaje normal o saliente bloquea el
borrado.

## Verificar, simular y aplicar

Ejecutar desde el worktree del backend. El modo predeterminado es dry-run:

```bash
node scripts/cleanup-intake-e2e-run.js \
  --group-id=5 \
  --marker=CC-E2E-20260713-073000 \
  --lead-ids=7201,7202 \
  --session-ids=cc_session_one,cc_session_two
```

Si la prueba creó una cita, añadir su identificador explícito:

```text
--appointment-ids=9001
```

A continuación, ejecutar la transacción completa y revertirla:

```text
--simulate
```

Solo si la simulación devuelve `simulation_rolled_back`, sustituirlo por:

```text
--apply
```

El modo apply borra únicamente los identificadores cargados y validados dentro
de una transacción serializable. Después comprueba que queden cero filas para:

- `LeadIntakes` y sus filas de atribución, contacto y flujo en cascada;
- `Conversations`, `Messages` y `ConversationReads` aislados;
- `FormSubmissionEvents` vinculados;
- `WebEvents` de las sesiones exactas;
- `GoogleAdsConversionUploadAttempts` de los eventos exactos;
- citas de prueba marcadas explícitamente y sus holds vinculados.

Los intentos confirmados por Google aparecen en dry-run, pero bloquean
simulate/apply. El borrado local **no** revierte una conversión en Google. Si es
aceptable conservar fuera la conversión de prueba etiquetada, hay que reconocer
ese hecho explícitamente:

```text
--acknowledge-external-conversions-not-retracted
```

Si se necesita limpieza externa, primero debe utilizarse un ajuste o retractación
de conversión de Google y después borrar la auditoría local. El script no simula
que borrar una fila local produzca esa acción externa.

Los agregados `WebPageDaily`, `WebClickDaily` y `WebSessionDaily` se reconstruyen
cada 15 minutos desde los `WebEvents` restantes. No se borran por marcador; tras
la limpieza hay que esperar a la siguiente agregación y verificar el recálculo.

## Propdental `/pedir-hora`: exigir clínica

La opción `Sin preferencia` no está definida en la plantilla del tema. La
plantilla activa `pide-cita.php` solo renderiza el Contact Form 7 `77822`; la
opción vive en WordPress, en el post meta `_form` de ese CF7. Como el select ya
es `select*` y usa `first_as_label`, eliminar la opción ambigua obliga a elegir
una de las cinco clínicas sin cambiar la semántica de validación.

El parche operativo idempotente es:

```text
scripts/wordpress/patch-propdental-cf7-form-77822.php
```

Valida el id, el título, la estructura del select obligatorio y las cinco
clínicas. Ejecutado con `wp eval-file` es de solo lectura por defecto; exige
`CC_APPLY=1` para actualizar `_form`. Antes de aplicarlo en WordPress hay que
exportar el `_form` actual a un backup con fecha. Después se comprueba que el
HTML público de `/pedir-hora/` contiene exactamente las cinco clínicas, no
contiene `Sin preferencia` y conserva `aria-required="true"` en `clinica`.

Procedimiento operativo, únicamente cuando exista autorización para cambiar
WordPress:

```bash
scp -i ~/.ssh/id_ed25519 -P 4838 \
  scripts/wordpress/patch-propdental-cf7-form-77822.php \
  propdentalssh@93.93.69.102:/home/propdentalssh/

ssh -i ~/.ssh/id_ed25519 -p 4838 propdentalssh@93.93.69.102 \
  "sudo -n bash -lc 'cd /furanet/sites/propdental.es/web/htdocs && wp post meta get 77822 _form --allow-root'" \
  > /home/ubuntu/.codex/backups/propdental-cf7-77822-before.txt

# Dry-run: no modifica WordPress.
ssh -i ~/.ssh/id_ed25519 -p 4838 propdentalssh@93.93.69.102 \
  "sudo -n bash -lc 'cd /furanet/sites/propdental.es/web/htdocs && wp eval-file /home/propdentalssh/patch-propdental-cf7-form-77822.php --allow-root'"

# Aplicación explícita.
ssh -i ~/.ssh/id_ed25519 -p 4838 propdentalssh@93.93.69.102 \
  "sudo -n bash -lc 'cd /furanet/sites/propdental.es/web/htdocs && CC_APPLY=1 wp eval-file /home/propdentalssh/patch-propdental-cf7-form-77822.php --allow-root'"
```

La verificación final debe hacerse tanto con `wp post meta get 77822 _form`
como en Chromium: el placeholder `Elige una Clínica` no permite enviar, cada una
de las cinco sedes sí, y una prueba manipulada con `Sin preferencia` debe ser
rechazada por CF7 sin generar `wpcf7mailsent` ni `LeadIntake`.
