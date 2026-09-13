# Seguridad: entregas por prioridad

Estado 13/09/2026. Esta organización responde a la petición de avanzar por capas
sin bloquear el desarrollo de otras áreas. Mantiene completo el encargo de
integraciones, auditoría, costes y cifrado. Terminar una entrega de código no
acredita su instalación ni la migración de cuentas reales.

## Prioridad vigente: reconexión de WhatsApp y acceso de ClinicaClick

Aclaración expresa del usuario: **OPS es un consumidor externo de datos para
paneles; ClinicaClick no depende de él**. Puede permanecer apagado. Las referencias
históricas a «OPS aplazado» no significan que haya que esperar a ese producto
para desplegar o validar las protecciones de ClinicaClick.

Orden de trabajo: **WhatsApp API y login con código por correo primero; cuentas
publicitarias después**. Las lecturas de contadores Facebook/Instagram quedan
pospuestas. El destino operativo confirmado es staging/gateway; DEV queda
fuera. La separación de procesos, colas, usuarios del sistema y grants SQL se
valora en el documento de reconexión antes de preparar el corte. Se conserva su borrador local fuera del corte publicado.

El criterio actual es comprobar las condiciones de reconexión de WhatsApp, no
solo terminar código de contención. Estado y obstáculos concretos:
[whatsapp-reconnection-readiness.md](whatsapp-reconnection-readiness.md).
Aún no hay visto bueno de reconexión: faltan aislamiento del token WABA,
consumidores y validación del entorno real, incluida exigencia efectiva del
código por correo. No se promete que cambiar tokens elimine el vector del
incidente. Las pruebas locales no autorizan llamadas reales ni una apertura.

## Motor WhatsApp: siguiente integración

Añadido transporte privado de canje con app/URI fijas y prueba de pertenencia
WABA/número por endpoint y cursor acotados. 294 pruebas broker pasan, 31 nuevas;
46 afectadas repetidas tras el último refuerzo. Aún sin operación de alta,
persistencia de candidata, rutas o configuración instaladas. Próximo bloque:
unir estado MFA, lifecycle durable en broker y Secrets Manager; después conectar
gateway/UI. [Transporte y límites](whatsapp-oauth-transport.md).

Nuevo avance: estado de autorización durable ligado a sesión con correo MFA y
conjunto exacto de clínicas, con reclamación única, cancelación y auditoría v15.
Probado en MySQL ficticio; todavía sin rutas ni canje. Nueva DDL 20260913150000
pendiente de corte aprobado. La siguiente pieza sigue siendo el canje en broker
y su registro seguro, junto con sustituir el requisito de MetaConnection general.
La independencia WhatsApp/Ads/leads debe verificarse en los grants de Meta.
[Contrato del estado](whatsapp-authorization-state.md).

Avance posterior al primer motor: inspección de credenciales antes de uso,
comparando respuesta Meta con identidad, scopes y WABA fijados. 263 tests broker,
80 WhatsApp, todos ficticios. Granularidad/campos y cuota diagnóstica real por
verificar; sin alta Meta, consumidores ni configuración activados. Continúan
estado/código de un uso, canje en broker y registro como siguiente trabajo.

Requisito confirmado por el usuario: cubrir **también la conexión previa de
Meta y Embedded Signup**. El flujo actual exige MetaConnection general y pide
permisos adicionales de páginas/publicidad/leads. Se sustituirá por autorización
Meta específica para WhatsApp, con correo MFA, estado/código de un uso, ámbito
validado y canje en broker. Registro público solo de referencias, sin token en
API/frontend/BD compartida. No se considera cerrada la reconexión con el motor
de envío solo; configuración/permisos reales y coexistencia siguen por validar.
La independencia se exige también en los grants/tokens de Meta, no solo en UI;
configuraciones de acceso frente a app dedicada quedan pendientes de evaluación.

Avance WhatsApp posterior: motor aislado y cliente staging probados, con texto,
plantillas textuales autorizadas, versiones de secretos fijadas y recibo durable
sin reenvío ante incertidumbre. 232 tests broker + 59 backend. Sin nueva DDL ni UI,
proveedores reales o despliegue. Siguiente paso: registro de bindings/aprobaciones,
consumidores y recepción durable gateway → cola → staging, preservando pausas.
Después, aislamiento real y lote MFA/canary. No hay visto bueno de reconexión.
[Contrato del corte](whatsapp-broker-messaging.md).

## Entrega anterior: primera etapa de contención y acceso

Actualizado por indicación expresa del usuario: **cerrar una primera entrega de
protecciones centrada en Meta y doble factor de acceso a ClinicaClick**, con
código, pruebas aisladas, documentación, commits propios y un lote de activación
revisable. El alta general Ads se aplaza después de conservar y cerrar el trabajo
ya probado. No esperar a completar todas las integraciones para esta entrega.

Criterios de cierre de esta primera etapa:

1. Conservar el hotfix de estadísticas e inventariar los recorridos Meta que
   pueden exponer, reutilizar o sustituir credenciales; corregir las brechas de
   autorización/serialización identificadas en el corte y probarlas con secretos
   centinela. Identificar expresamente cualquier consumidor aún no cubierto.
2. Preparar controles persistentes que impidan reabrir una conexión Meta bloqueada
   mediante borrado/recreación, fallback o alta alternativa desde la aplicación;
   comprobar clínicas compartidas y activos primarios antes de modificar nada.
3. Entregar el recorrido de doble factor de login **con códigos por correo,
   elegido expresamente por el usuario**: verificación de contraseña y correo,
   límite de intentos/reenvíos, caducidad, consumo único, recuperación protegida,
   UI y auditoría. Implementado y probado en el corte descrito abajo. Las
   sesiones no pueden obtener acceso completo antes de completar el segundo paso
   cuando este sea exigible.
4. Probar los recorridos completos con HTTP, persistencia e interfaz aislados;
   documentar dependencias, alcance obligatorio del segundo factor, recuperación,
   despliegue y rollback seguros. Publicar solo los commits propios revisados.

El doble factor protege el acceso a ClinicaClick; no invalida tokens Meta ya
copiados ni demuestra el vector exacto del incidente. Se mantiene el bloqueo
reportado y no se reactivan proveedores. El corte con datos reales permanece
fuera de la entrega local hasta aprobar el lote concreto de activación de ClinicaClick.

## Entrega preparada de la primera etapa

Implementados contención Meta, registro independiente de bloqueos, primarios de
grupos, ACL de métricas y código por correo con recuperación y auditoría. Alcance
exacto y lote de activación en [meta-email-stage1.md](meta-email-stage1.md).
La cuarentena global de los transportes inventariados conserva Meta cerrado
hasta otro corte del broker; las credenciales reales aún no están aisladas.

QA: 505 pruebas Node (441 backend, 53 auditoría, 11 front), 83 checks en ocho
MySQL propios con apagado 0, build Angular y 18 escenarios Chromium. La
publicación propia de este corte se acredita en el acta `meta-email-stage1-*`.
No hay activación, correo real ni cambios OPS. La siguiente entrega local es
la capa 2 centrada en Meta; el alta general Ads continúa aplazada. Esta primera
entrega no cierra ni reemplaza el objetivo completo de seguridad.

## Entregas y criterios de cierre

| Capa | Prioridad y alcance | Cierre de la entrega local | Validación real pendiente |
| --- | --- | --- | --- |
| 1. Protecciones | Crítica: Meta y doble factor según el objetivo anterior; hotfix, permisos sobre todos los afectados, bloqueos independientes y desconexiones sin cambios parciales. | Contratos y dependencias documentados; QA de borrado/recreación, grupos, primarios, concurrencia, login y rollback; commits propios revisados. | Instalar el lote autorizado y comprobar los controles efectivos sobre la cohorte elegida. |
| 2. Credenciales aisladas | Alta: broker y consumidores existentes, una integración y operaciones de lectura por corte; Meta tiene prioridad por indicación del usuario. | Protocolo cerrado, identidad por operación/activo, secreto fuera de API general, exclusión del origen antiguo, auditoría y pruebas de extremo a extremo con ficticios. | IAM/red/secretos verificados, única fuente activa y canary autorizado. Elegir la cohorte exacta al preparar ese lote, sin reactivar Meta en esta etapa. |
| 3. Auditoría | Alta: accesos, permisos y cambios de integraciones primero; completar después lecturas, escrituras y exportaciones restantes. | Matriz de cobertura por evento/ruta, cola durable, visor restringido y evidencia de fallo/reintento/conciliación. Cada nueva mutación crítica incluye su auditoría en su propia entrega. | Identidades writer/reader, entrega externa y alarmas efectivas; retención acordada con el DPD. |
| 4. BD y recuperación | Alta y en una línea independiente, sin esperar al alta Ads: verificar cifrado, TLS, backups y recuperación. | Diagnóstico con sus límites, cambios preparados y restauración ficticia comprobada; lote de corte con ventana, coste y rollback. | Cifrado efectivo de datos/volúmenes/backups y restauración real acreditados tras aprobación. El diagnóstico actual es parcial. |
| 5. Altas y gestión avanzada | Posterior al cierre de las protecciones: incorporación general Ads, primera identidad, conciliación, cambios de propietario y Ajustes. | Recorridos completos con permisos/sesión originales, estados pendientes veraces y auditoría humana; HTTP/MySQL/UI aislados. | Piloto autorizado. Las piezas de alta ya preparadas no bastan para habilitarlo. |
| 6. Costes en Ajustes | Cierre de la integración ya preparada: colector, caché, panel, gasto/presupuesto/estimación separados. | QA de ACL, paginación, datos atrasados, moneda y ausencia de doble conteo; migración y job documentados. | Cost Explorer, etiquetas, rol, Budget y cifras conciliados. La conciliación del Budget es requisito del corte AWS que dependa de él, aunque el panel se entregue después. |

Las capas no obligan a ejecutar seis despliegues consecutivos. Auditoría esencial
acompaña cada operación que se entrega; la preparación de BD puede avanzar de
forma independiente. Meta/WhatsApp continúan fuera de cualquier activación: los
tokens WABA fueron reportados como revocados por el usuario y no se han probado.

## Checkpoint previo publicado: fundamento de altas Ads

El motor del broker del corte anterior ya prepara/activa cuentas bajo un ámbito
aprobado. Esta entrega añade cancelación incluso antes de preparar, tablas de
ámbitos/solicitudes, validación de permisos y cliente interno tipado. Las guardas
globales Google consultan los dos registros nuevos por conexión y sujeto. El
historial sobrevive al borrado de asignaciones, mappings y conexiones originales.

QA actual: 574 pruebas Node (391 backend y 183 broker), 141 comprobaciones en
nueve MySQL privados, todos cerrados con código 0. Los proveedores y datos son
ficticios. No hay cambios de interfaz que requieran un nuevo build/capturas en
este corte. Evidencia privada: `ads-enrollment-app-*` en
`/home/ubuntu/qa-evidence/security-migration-20260912`.

Faltan el escritor de intenciones, su conciliador, la integración con las bajas,
API/Ajustes y auditoría humana del alta. Se entregan los fundamentos probados;
el recorrido de alta general queda en la capa 5 y no se presenta como terminado.
Este cierre conserva el trabajo existente antes de continuar con Meta y doble
factor; por sí solo no cierra la primera etapa actualizada.

La migración `20260913120000-create-google-ads-enrollment.js` debe preceder al
código correspondiente **incluso con el gate de altas apagado**. Una tabla ausente
cierra la carga de credenciales Google. Sus dependencias siguen descritas en
[el contrato de aplicación](google-ads-enrollment-application.md) y en la matriz
`google-ads-broker-consumers.json`; no es un lote autónomo para una BD sin las
migraciones anteriores. No ejecutar todas las migraciones pendientes.

## Contrato para continuar con otras áreas

- La primera etapa añade las rutas de código por correo descritas en la fuente
  `src/Documentacion/13-backend.md`. Las asignaciones Ads gestionadas siguen
  admitiendo solo cuentas previamente registradas; el alta general queda pendiente.
- Los consumidores usan DTO de negocio y estados de disponibilidad; nunca
  reciben claves, referencias de Secrets Manager ni tokens. No sustituir una
  función pendiente por credenciales antiguas o una respuesta de éxito ficticia.
- El trabajo de publicidad conserva su propietario. Antes de editar archivos
  compartidos, coordinar el siguiente corte; cada push revisa todo el rango desde
  `origin/dev`, conserva el hotfix y contiene solo cambios propios/dependencias
  autorizadas. Un commit separado no elimina dependencias de esquema.
- Cada entrega indica: implementado, probado con ficticios, verificado real,
  publicado y desplegado; incluye commits, migraciones concretas, rollback y
  pendientes. No sumar recuentos históricos como si fueran una sola ejecución.

## Producto OPS y activación de ClinicaClick

El producto OPS permanece fuera del foco y puede estar apagado. No es un
requisito ni el responsable de aprobar la activación de ClinicaClick. Los cortes
sobre servicios usados, secretos reales o BD compartida siguen requiriendo el
lote concreto acordado con su propietario. Estos commits no ejecutan ese corte.
No se deduce que el apagado de OPS implique el del broker de integraciones.

Antes de cada activación se presentará un lote concreto y revisable: recursos,
principales/permisos, consumidores, commits, DDL exacta, respaldo, coste, ventana,
canary y rollback. Se requiere aprobación para ese lote según el
[prompt autorizado](../security-integrations-migration-codex-prompt.md) y el
[runbook](../security-integrations-audit-migration.md#6-despliegue-y-rollback).

Persisten los pendientes de acceso SSO mínimo, IAM/red, retención (seis meses no
equivale automáticamente a 183 días), Cost Explorer/etiquetas, Budget frente a
CloudFormation y cifrado/corte BD. La instancia, los secretos, claves, bucket y
stack ya reportados no deben recrearse. El objetivo completo sigue abierto.
