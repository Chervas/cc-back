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

## Evidencia de limpieza Enhanced controlada (2026-07-13)

Los leads controlados `#7207`, `#7209` y `#7210` y sus artefactos se retiraron
siguiendo exactamente `dry-run -> simulate -> apply`, con
`--acknowledge-external-conversions-not-retracted`. El postcheck devolvió cero
restos para esos IDs. Los leads reales `#7184/#7193/#7194` permanecieron intactos.

Esta limpieza no convierte los resultados del proveedor en éxitos: los intentos
`#19/#21/#22` habían terminado `FAILURE/INVALID_GCLID` porque usaban click IDs
sintéticos. El intento `#22` sí acreditó el transporte controlado de dos hashes,
un registro recibido y cero warnings, pero no una conversión atribuida.

`LeadIntake #7208` no se ha limpiado. Su intento `#20`, request ID
`6b1d7941-d6d2-4668-8b15-8e93be8748de`, seguía `PROCESSING` en la lectura
`JobRequest #23745` / `SyncLog #65219` de las `22:00:12 UTC`, con `checked=1`,
`processing=1`, `record_count=0` y cero errors/warnings. Conserva intactas una fila
de atribución y el intento local para que el scheduler pueda completar la
auditoría. Solo después de un terminal puede repetirse este procedimiento y
documentar su postcheck; borrar antes incumpliría la guarda de diagnóstico
terminal definida en **Preparar la prueba**.

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

## Cierre Propdental del 2026-07-13

El parche se aplicó sobre el CF7 `77822` después de guardar el backup
`/home/propdentalssh/backups/propdental-cf7-77822-before-20260713-0720.txt`.
WordPress sirve desde entonces el placeholder más las cinco sedes concretas y
ya no contiene `Sin preferencia`.

El primer E2E controlado descubrió un fallo real: la etiqueta
`Propdental Sant Martí` no coincidía con el nombre público configurado y el
fallback de grupo la enviaba a Sants. Ese lead y sus eventos se eliminaron antes
de desplegar la corrección. El contrato corregido es:

- `IntakeConfig.config.locations` es la lista autoritativa de IDs admitidos;
- las etiquetas `label`/`public_label` y el nombre actual de la clínica solo
  aportan aliases para esos IDs configurados;
- el sentinel técnico `clinica_id=0` del runtime no se interpreta como nombre y
  no oculta `form_submission.fields.clinica`;
- un alias desconocido, ambiguo, inactivo o fuera del grupo responde `422
  invalid_form_location` antes del fallback, de crear el lead o de emitir
  eventos;
- `Propdental Sant Martí` y `Barcelona - Sant Martí` resuelven a la clínica
  canónica `56`; las otras cuatro sedes resuelven a `19`, `35`, `58` y `59`.

Después del despliegue se ejecutaron tres E2E públicos separados, siempre en una
sesión nueva, sin `gclid`/`gbraid`/`wbraid` y con Marketing desmarcado:

1. CF7 creó un único lead `web_form` en `clinic_id=56`, con
   `clinic_match_source=configured_location_label`, un `FormSubmissionEvent` y
   cero intentos Google.
2. Chat seleccionó `Barcelona - Sant Martí`, creó un único lead `chatbot` en
   `56`, deduplicó el segundo POST y materializó una conversación QuickChat con
   un único `quickchat_summary` oculto al paciente.
3. El modal del enlace `tel:602480829` creó un único lead `tel_modal` en `56`,
   guardó consentimiento de contacto sin reactivar Marketing y registró
   `CallInitiated` enlazado al lead.

Cada ejecución pasó por dry-run, simulación con rollback y aplicación del script
de limpieza. El postcheck final dejó cero leads, formularios, conversaciones,
mensajes, eventos web o intentos de conversión sintéticos. El grupo `5` volvió a
su baseline de cuatro leads reales, con máximo `7186`; los IDs sintéticos
`7187`-`7190` no conservan filas asociadas.
