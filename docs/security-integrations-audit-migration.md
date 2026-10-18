# Runbook: Migración Segura De Integraciones Y Auditoría

> Documento trasladado al manual central. Esta ruta conserva enlaces históricos; no añadir contenido nuevo aquí.

[Abrir el documento canónico](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md).

## Punto de partida operativo

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#punto-de-partida-operativo).

## Elegir el siguiente corte

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#elegir-el-siguiente-corte).

### Preparar la identidad WhatsApp de DEV

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#preparar-la-identidad-whatsapp-de-dev).

## Lista de ejecución por entrega

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#lista-de-ejecución-por-entrega).

## Esquema de seguridad y publicación entre entornos

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#esquema-de-seguridad-y-publicación-entre-entornos).

## Fuentes del contrato y registro

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#fuentes-del-contrato-y-registro).

### Columna fiscal propia de programas — corte acotado 04/10/2026

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#columna-fiscal-propia-de-programas--corte-acotado-04102026).

## 1. Entrada Y Limites

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#1-entrada-y-limites).

## 2. Inventario Local Y Puntos De Integracion

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#2-inventario-local-y-puntos-de-integracion).

## 3. Fases Y Puertas De Salida

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#3-fases-y-puertas-de-salida).

### A. Aceptar La Entrega Y Preparar El Cambio

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#a-aceptar-la-entrega-y-preparar-el-cambio).

### B. Implementar Y Probar Sin Credenciales Reales

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#b-implementar-y-probar-sin-credenciales-reales).

### C. Desplegar El Broker Con Ficticios

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#c-desplegar-el-broker-con-ficticios).

#### Writer HTTPS en la instancia de seguridad

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#writer-https-en-la-instancia-de-seguridad).

##### Autonomía temporal de instalación y diagnóstico

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#autonomía-temporal-de-instalación-y-diagnóstico).

#### Instalación con una única EC2 y roles por servicio

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#instalación-con-una-única-ec2-y-roles-por-servicio).

#### Recuperación limitada de dependencias

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#recuperación-limitada-de-dependencias).

#### Diagnóstico de un fallo posterior al configurar servicios

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#diagnóstico-de-un-fallo-posterior-al-configurar-servicios).

### D. Migracion Aprobada Por Cohortes

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#d-migracion-aprobada-por-cohortes).

### E. Auditoria Completa Y Cifrado De BD

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#e-auditoria-completa-y-cifrado-de-bd).

## 4. Matriz Minima De QA

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#4-matriz-minima-de-qa).

## 5. Commits Y Push Sin Arrastrar Publicidad

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#5-commits-y-push-sin-arrastrar-publicidad).

## 6. Despliegue Y Rollback

[Consultar esta sección](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/runbooks/seguridad/migracion-integraciones-y-auditoria.md#6-despliegue-y-rollback).
