# Google: publicación de consumidores en DEV

> **Tipo:** runbook de publicación, diagnóstico y recuperación.
> **Fuente de verdad:** alcance de la release Google aislada; no acredita migración clínica ni proveedor real.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [contrato backend](../../src/Documentacion/13-backend.md#consumidores-google-publicados-en-dev-con-activación-pendiente), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones), [esquema](google-schema-readiness.md).

## Estado publicado

Esta acta describe la publicación DEV de las 17:38–17:39 UTC. El esquema clínico
se aplicó después a las 18:04 UTC: [corte Google](google-clinical-cut.md). Los
consumidores públicos nuevos y la aceptación real siguen pendientes.

El 19/09 a las 17:38–17:39 UTC se publicaron solo en DEV backend
`aeb87ce46b33c064405522b738a0061e16beeb5b` y frontend
`95f55fe728803b781119901e216da9e80f6ee5b5`, en sendas ramas
`security/google-dev-candidate-20260919`. Se componen sobre las releases
realmente ejecutadas `d07e9c85` y `ddc84c5a`, no sobre toda la rama DEV.
Desarrollo/correcciones en DEV primero; ambas candidatas y fuentes están pusheadas.

Backend: 58 archivos de producto y 46 de QA. Frontend: 17 de producto y cuatro
de QA. Contrato de seguridad de 49 tablas compatible; las seis DDL Google DEV
ya se habían aplicado en el corte anterior y **no se repitieron**.
Configuración efectiva, MFA/sesiones enforce y pausas clínicas intactas. Cero
conexiones, mappings, intentos o recibos Google en DEV; ningún gate nuevo abierto.
CRM, gateway y las dos unidades WhatsApp conservan PID/inicio/entorno. El esquema
clínico conserva su digest y compatibilidad de 27 tablas, con 19 DDL Google aún
pendientes para el código futuro. Este corte no escribe en AWS ni en el proveedor.

## Verificación y límites

- Broker: 629 pruebas. HTTP/servicios de backend: 168 casos inicialmente correctos
  y 39 casos corregidos/repetidos correctamente; no se presenta como una sola
  ejecución íntegra de 207 casos.
- Ocho ensayos MySQL propios: 163 grupos, con apagado limpio. Cubren bootstrap,
  recibos, diagnóstico combinado, leads nativos, alta Ads, envío de conversiones,
  diario de acciones y diario de destinos. Google, AWS y sesión administrada son
  ficticios. SQL, transporte HTTPS firmado y persistencia del broker son reales
  dentro de la prueba; no se usan tokens operativos.
- 19 capturas de componentes candidatos con SQL/HTTPS aislados. Recorrido adicional
  de diálogos: 100 comprobaciones, 65 capturas, cero errores JavaScript o conexiones
  externas. Se revisan manualmente capturas representativas de escritorio/móvil:
  pausa Meta, aislamiento de clínica, respuesta incierta, retirada y resultado parcial.
- 65 pruebas frontend. Compilación completa correcta, build `9096565ecae30c27`,
  avisos Material/CommonJS existentes. Se compiló `641127af`; `95f55fe7` solo añade
  QA y conserva exactamente su árbol de producto. Se contrastan 677 archivos del
  build, índice y main/runtime/styles servidos. Los nombres estables de DEV llevan
  `no-cache`; el directorio anterior y assets con nombres distintos se conservan.
- Login anónimo real CRM/DEV a 1440/390 px: cuatro capturas, API sin sesión 401,
  formulario vacío bloqueado antes del POST, cero errores JS/5xx/desbordamiento.
  Contraste mínimo 5,90. **Falta sesión MFA autenticada y aceptación Google real.**

La observación SQL posterior se conserva en el acta. Solo mide el recorrido
inactivo y las tareas existentes; no demuestra capacidad bajo tráfico Google real.

## Incidencias de preparación resueltas

Tres fixtures OAuth estrictos no registraban las rutas Meta compartidas: se
añadieron sus dependencias ficticias opt-in, que siguen fallando si se usan fuera
del ensayo. No se relajó el cargador ni el control productivo. Las pruebas visuales
ahora admiten la ruta explícita del frontend candidato. Se añadió a EN el aviso de
pausa Meta ya presente en ES/CAT.

Los diarios SQL antiguos comparaban un contrato sin `GENERATION_EXPRESSION` con
la captura actual que sí lo incluye. La prueba ahora exige expresión vacía por
defecto; una expresión calculada inesperada sigue fallando. No cambió el contrato
ni se tocó SQL productivo para satisfacer la prueba.

Un preparado root anterior dejó una release **inactiva** `c886556f…-google-consumers`
al rechazar una ruta de salida relativa. La nueva preparación usa ruta absoluta y
la revisión final `aeb87ce4`. Otro preflight rechazó el prefijo de resultados Node
(`ℹ` en lugar de `#`); se corrigió la lectura anclada de contadores antes de detener
ningún servicio. Ambos intentos conservan evidencia; no se atribuyen a fallos del API.

## Diagnóstico y recuperación

Evidencia privada:
`/home/ubuntu/qa-evidence/security-resume-20260917/google-dev-candidate-20260919/`.
Acta sin secretos: [google-dev-consumers.json](google-dev-consumers.json).
Diario root **consumido**:
`/var/lib/clinicaclick-consumer-recovery/google-dev-20260919-aeb87ce4/`.
No volver a ejecutar los publicadores consumidos ni la preparación de esquema.

1. Inspeccionar `current`, estado de `clinicaclick-back-dev.service` y
   `clinicaclick-dev-security.service`, plan, `before/after/complete.json` y hashes.
   El estado actual debe corresponder al que se pretende recuperar; si otro corte
   lo sustituyó, usar su acta. No reiniciar nada por un error de preflight.
2. Para revertir este backend, conservar configuración y esquema, comprobar trabajo
   DEV en curso y detener únicamente esas dos unidades. Cambiar atómicamente
   `/opt/clinicaclick-dev/current` a
   `/opt/clinicaclick-dev/release-d07e9c8579bafc446a0f86a283ec52a8fc733c90-meta-consumers`.
   Arrancar API, verificar `/api/auth/me` sin sesión = 401 y arrancar worker;
   contrastar pausas, entorno y procesos públicos. No detener CRM/gateway/WhatsApp.
3. Para revertir frontend, si el enlace aún apunta a esta release, cambiarlo
   atómicamente al directorio retenido
   `/home/ubuntu/www/front-dev-release-ddc84c5a8dc93d98a87ba11c71560c96463ce413-meta`.
   Verificar índice/bundles HTTP y login. No borrar la release nueva durante sesiones
   abiertas ni copiar el frontend DEV sobre el directorio público.
4. No ejecutar `down`, reproducir intentos históricos ni regenerar claves. Las
   49 tablas son compatibles con el backend anterior. Una publicación futura exige
   plan nuevo, hashes frescos y pruebas del alcance elegido.

## Pendientes fuera de esta publicación

Composición staging/gateway, identidad compartida completa y migración de
credenciales/grants; el esquema clínico ya se aplicó en el acta posterior. Después, aceptación de proveedor y UI
autenticada; las pruebas ficticias no cierran esos puntos. AWS SSO requiere renovar
sesión cuando el operador esté disponible. El objetivo completo conserva WhatsApp,
Meta, IA, correo, auditoría y certificados; rotación aplazada y copias generales al
final. Sin nueva consulta Cost Explorer ni coste incremental facturado atribuible.
