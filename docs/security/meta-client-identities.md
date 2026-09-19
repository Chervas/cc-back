# Identidades cliente Meta y acceso de red DEV

> **Tipo:** runbook de preparación local y recuperación.
> **Fuente de verdad:** claves de firma cliente y permiso de salida local; no acredita autorización clínica ni permisos AWS.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [publicación de consumidores](meta-clinical-publication.md), [contrato backend](../../src/Documentacion/13-backend.md#identidades-cliente-meta-y-acceso-de-red-dev), [arquitectura](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/31-roadmap-arquitectura-entornos-gateway.md).

## Estado verificado

Fuente DEV `06e4ccee`: `ops/security/prepare-meta-client-identities.cjs` prepara
o verifica `/etc/clinicaclick-meta-clients-v1`. Primera instalación realizada;
no repetir una generación ni sustituir estas claves para retomar la tarea.
La acción `verify` no modifica nada. Si encuentra un estado parcial o alterado,
falla conservándolo: inspeccionar antes de recuperar. No es una rotación de
tokens de proveedor ni lee la clave privada de la CA.

Hay ocho principales Ed25519 diferentes, cuatro por entorno:

| Principal por entorno | Finalidad | Copias DEV |
| --- | --- | --- |
| `{environment}:meta-marketing` | Lecturas | API, UID 998 |
| `gateway:{environment}:meta-marketing-oauth` | OAuth y preparación/activación | API 998 y worker 996 |
| `control:{environment}:meta-marketing-oauth` | Consulta y retirada OAuth/alta | API 998 y worker 996 |
| `control:{environment}:meta-marketing` | Retirada de activos | Worker 996 |

En staging las cuatro claves pertenecen a UID 1000. Staging y gateway comparten
ese UID: no hay aislamiento de archivos entre ambos. Las dos copias DEV de cada
clave OAuth son el mismo principal; no constituyen identidades independientes.
En total hay diez archivos privados para ocho claves, no diez servicios.

Los directorios son root 0711, las claves y copias de CA 0600 del UID consumidor;
manifest y borradores root 0600, con `drafts/` root 0700. La CA se comprueba contra
la huella del registro de certificados. El verificador comprueba firmas reales,
ocho claves distintas, propietarios, modos, enlaces, copias y borradores exactos.
No hay secretos en Git ni en los manifiestos de evidencia publicados.

Los tres `.env.pending` son borradores privados, **no EnvironmentFiles activos**.
Mantienen los nueve gates Meta en false y solo contienen referencias a archivos,
origen, audiencia e identificadores. No copiarlos a los runtimes en esta fase.
Las claves públicas aún no están admitidas por AWS. Instalar identidades en la
política vacía sería incompatible con su modo standby; requiere el corte real
con ámbito, app/slots y permisos exactos revisados.

## Red y comprobaciones efectivas

El firewall persistente se actualizó con la fuente versionada. A las 16:50:37 UTC
se añadió en caliente una sola regla: UID 998 puede conectar por TCP a
`13.39.100.55:8453`. Se conservan loopback MySQL 3306, Redis DEV 6384 y broker
WhatsApp 8447. Puerto Meta staging 8454 y demás destinos siguen rechazados.
No se vació la cadena, no hubo reinicio y no cambiaron OUTPUT ni IPv6.

La restricción de salida corresponde a la API UID 998. El worker UID 996 conserva
su conectividad existente de correo/auditoría; **no** tiene esa misma cadena.
Su separación se acredita aquí por archivos/identidades, no por bloqueo de red
hacia staging. Tampoco se afirma aislamiento frente a root o al operador.

- Seis pruebas con claves/CA ficticias, criptografía y UIDs reales pasan:
  instalación/idempotencia, exclusión entre UIDs, preservación parcial y rechazo
  de cambios de clave, modo, enlaces, CA, gates o identidad compartida.
- Sondas con UID y namespaces de montaje/red de los procesos activos leen las
  diez copias mediante el cliente firmado real. TLS valida la CA y ambos puertos
  responden `invalid_signature`: las claves nuevas no están autorizadas.
  Se usa una lectura con referencias ficticias sin ámbito. El servidor autentica
  antes de aceptar nonce o ejecutar operaciones. No prueba permisos OAuth/control
  ni acceso al proveedor; no hay una nueva inspección de SQLite AWS en este corte.
- API DEV: antes 8453 no accesible; después TLS verificado. 8454 sigue rechazado;
  también Redis público 6379 y una salida externa de prueba. Los tres UIDs reciben
  EACCES al leer claves ajenas y borradores. Esas sondas entran en los namespaces,
  pero no reproducen todos los controles de cgroup/seccomp de las unidades.
- PID, entorno inicial del proceso y archivos de configuración se conservan
  por comparación de huellas. Cero variables Meta configuradas, gates OFF;
  MFA y las pausas clínicas conservadas, sin SQL, DDL ni replays.
- Login anónimo real CRM/DEV en 1440/390px: cuatro capturas, API sin mocks,
  auth/me 401, cero POST del formulario vacío, errores JS/5xx o desbordamientos.
  Revisadas visualmente CRM móvil y DEV escritorio. No acredita MFA autenticado
  ni Ajustes/OAuth con un titular real.

Acta verificable: [meta-client-identities.json](meta-client-identities.json).
Evidencia privada: `qa-evidence/security-resume-20260917/meta-client-identities-20260919/`.

## Recuperación

Recibo root 0700: `/var/lib/clinicaclick-consumer-recovery/meta-client-20260919/`.
Contiene reglas previas, script previo y confirmación final. No ejecutar otra vez
el aplicador puntual `apply-egress.py`: rechaza un recibo existente deliberadamente.

Para comprobar claves sin regenerar:

```sh
sudo /usr/bin/node /home/ubuntu/wt/back-dev/ops/security/prepare-meta-client-identities.cjs verify
```

Si se necesita retirar este permiso, comprobar primero que el script vivo y las
reglas siguen iguales al acta y que nadie ha activado Meta después. Eliminar solo
la regla TCP 8453 de `CC_DEV_EGRESS_V1` y restaurar atómicamente `firewall.before`
como root 0700 en `/usr/local/sbin/clinicaclick-dev-firewall`. No ejecutar un flush
general ni retirar 8447/3306/6384. Comprobar IPv6, OUTPUT y login después.
Conservar claves y manifiesto inactivos para no perder identidad de una futura
petición incierta; este rollback no restaura BD, permisos ni diarios anteriores.

## Pendientes y coste

AWS SSO del operador sigue caducado según STS 16:52 UTC; el acceso de los servicios
no depende de esa sesión. Pendientes: ámbito y titular Meta, app/slots/IAM exactos,
alta de principales, corte coordinado de configuración y recorrido público real
de autorización/selección/retirada. No se infiere el ámbito de WhatsApp.
No hay nuevas máquinas, compras, secretos de proveedor AWS ni consulta Cost
Explorer. El coste incremental facturado sigue sin atribución (`null`); se
conserva el snapshot etiquetado estimado 4,6195124129 USD del 1–18/09. Los rechazos
TLS no miden capacidad de proveedor. Las copias generales siguen al final.
