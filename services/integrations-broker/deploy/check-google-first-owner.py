#!/usr/bin/python3
"""Deployment-only non-secret JSON/path fence. Never opens TLS/credential/state contents."""
import ipaddress
import json
import os
import stat
import sys


def need(value):
    if not value:
        raise ValueError('GOOGLE_FIRST_DEPLOYMENT_CONTRACT_INVALID')


def validate(config, environment):
    need(environment in ('dev', 'staging') and isinstance(config, dict))
    directory = '/etc/clinicaclick-google-first-owner-' + environment
    need(config.get('environment') == environment and config.get('enabled') is True
         and config.get('cohort') == 'google-first-oauth-v1' and config.get('purpose') == 'google-first-identity-only-v1')
    need(config.get('stateFile') == '/var/lib/clinicaclick-google-first-owner-' + environment + '/owner.sqlite')
    address = ipaddress.ip_address(config.get('listenAddress', ''))
    allowed = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128']
    need(any(address.version == ipaddress.ip_network(network).version and address in ipaddress.ip_network(network) for network in allowed))
    need(type(config.get('port')) is int and 1024 <= config['port'] <= 65535)
    certificate = '/server-cert.crt' if environment == 'staging' else '/server-cert.pem'
    need(config.get('tlsCertFile') == directory + certificate and config.get('tlsKeyFile') == directory + '/server-key.pem')
    need(isinstance(config.get('tlsRenewal'), dict) and config['tlsRenewal'].get('issuerCaFile') == directory + '/issuer-ca.pem')
    readers = {
        'search_console': ('searchConsoleReaderPrincipal', 'searchConsoleCursorKeyFile', 'sc', 'cursor.key'),
        'analytics': ('analyticsReaderPrincipal', 'analyticsCursorKeyFile', 'ga4', 'analytics-cursor.key'),
    }
    scopes, slots, resources = config.get('scopes'), config.get('slots'), config.get('publicationResources')
    need(isinstance(scopes, list) and scopes and all(
        isinstance(row, dict) and isinstance(row.get('services'), list) and row['services']
        and all(service in readers for service in row['services']) and len(row['services']) == len(set(row['services']))
        for row in scopes))
    enabled_services = {service for row in scopes for service in row['services']}
    for rows in (slots, resources):
        need(isinstance(rows, list) and rows and all(isinstance(row, dict) and row.get('service') in readers for row in rows))
        need({row['service'] for row in rows} == enabled_services)
    for service, (principal, cursor, role, filename) in readers.items():
        if service in enabled_services:
            need(config.get(cursor) == directory + '/' + filename)
            need(config.get(principal, {}).get('id') == 'crm:' + environment + ':google-first-' + role + '-reader')
        else:
            need(principal not in config and cursor not in config)
    policy = config.get('policy', {})
    need(policy.get('audience') == 'clinicaclick:google-first-oauth:' + environment + ':v1'
         and policy.get('version') == 'google-first-oauth:' + environment + ':v1'
         and policy.get('connections') == [] and policy.get('grants') == [])
    principals = policy.get('principals')
    need(isinstance(principals, list) and len(principals) == 1
         and principals[0].get('id') == 'crm:' + environment + ':google-first-oauth')


def main():
    need(len(sys.argv) == 2 and sys.argv[1] in ('dev', 'staging'))
    environment = sys.argv[1]
    filename = '/etc/clinicaclick-google-first-owner-' + environment + '/config.json'
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(fd)
        need(stat.S_ISREG(metadata.st_mode) and stat.S_IMODE(metadata.st_mode) == 0o600
             and metadata.st_nlink == 1 and metadata.st_uid in (0, os.geteuid()) and 0 < metadata.st_size <= 262144)
        data = os.read(fd, 262145)
        need(len(data) == metadata.st_size)
        validate(json.loads(data), environment)
    finally:
        os.close(fd)
    print('GOOGLE_FIRST_DEPLOYMENT_CONTRACT_OK')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('GOOGLE_FIRST_DEPLOYMENT_CONTRACT_INVALID', file=sys.stderr)
        sys.exit(1)
