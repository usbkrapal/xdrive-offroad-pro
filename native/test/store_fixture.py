#!/usr/bin/env python3
"""Синтетическое приложение для тестов Store-упаковки: копия вендорного дерева во временной папке,
apps/store_fixture и настоящий запуск kit/tools/build.py. SDK нет ни в каком виде.

    python3 -I native/test/store_fixture.py <пустая папка> [--language en] [--mode store|preview]
печатает JSON {code, stdout, stderr, root, dist, tgz, spec, icon}.
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
VENDOR = os.path.join(PROJECT, 'vendor', 'idrive7-apps')
APP_ID = 'store_fixture'

SPEC = {
    'id': APP_ID, 'title': 'Store Fixture', 'description': 'Synthetic app for packaging tests', 'version': '1.2.3',
    'vendor': 'custom', 'loggingId': 'XFX1', 'iconGlyph': 'SF', 'mguHmi': ['ID7'], 'requires': {'mgu-render': '0.6.21'},
    'signals': {
        'de.bmw.infotainment.vehicle.Vehicle2': {'_optional': 'speed', 'statusCarSpeed2': 'rs'},
        'de.bmw.infrastructure.VehicleInformation': {'_optional': 'gear', 'statusGearboxDrive': 's'},
    },
    'screens': [{'name': 'MAIN', 'kind': 'canvas', 'title': 'Store Fixture', 'buttons': [['BTN_PAGE', 'Next'], ['BTN_SETTINGS', 'Settings']]}],
    'settings': [{'key': 'dataSource', 'label': 'Data source', 'type': 'choice', 'default': 'vehicle', 'hidden': True,
                  'options': [['demo', 'Demo'], ['vehicle', 'Vehicle']]}],
}


def make_app(root, spec):
    adir = os.path.join(root, 'apps', spec['id'])
    os.makedirs(adir)
    json.dump(spec, open(os.path.join(adir, 'app.json'), 'w', encoding='utf-8'), indent=1)
    pad = '// ' + 'fixture padding ' * 8 + '\n'
    with open(os.path.join(adir, 'main.js'), 'w', encoding='utf-8') as f:
        f.write("'use strict';\nconst mgu = require('./kit/mgu');\nconst assets = require('./assets');\n" + pad * 20)
    with open(os.path.join(adir, 'assets.js'), 'w', encoding='utf-8') as f:
        f.write("'use strict';\nmodule.exports = { format: 'fixture' };\n" + pad * 20)
    licence = open(os.path.join(root, 'LICENSE'), encoding='utf-8').read()
    with open(os.path.join(adir, 'NOTICE'), 'w', encoding='utf-8') as f:
        f.write('Fixture notice: the MIT License below applies to those portions only.\n\n' + licence)
    return adir


def make_fixture(workdir, language='en', mode='store', spec=None):
    spec = json.loads(json.dumps(spec or SPEC))
    root = os.path.join(workdir, 'v')
    shutil.copytree(VENDOR, root, ignore=shutil.ignore_patterns('apps', 'dist', '__pycache__'))
    make_app(root, spec)
    spec_file = os.path.join(workdir, 'app.json')
    json.dump(spec, open(spec_file, 'w', encoding='utf-8'), indent=1)
    flag = {'store': ['--store-package'], 'preview': ['--preview-only'], 'both': ['--store-package', '--preview-only'],
            'installable': []}[mode]
    r = subprocess.run([sys.executable, '-I', os.path.join('kit', 'tools', 'build.py'), '--language', language, *flag, spec['id']],
                       cwd=root, capture_output=True, text=True)
    dist = os.path.join(root, 'dist')
    tgz = os.path.join(dist, '%s@%s.tgz' % (spec['id'], spec['version']))
    icon = os.path.join(dist, spec['id'], 'source', 'rhmiData', 'variantGroups', 'Common', 'images', spec['id'] + '_icon.png')
    return {'code': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr, 'root': root, 'dist': dist,
            'tgz': tgz if os.path.exists(tgz) else None, 'spec': spec_file, 'icon': icon if os.path.exists(icon) else None}


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('workdir')
    ap.add_argument('--language', default='en')
    ap.add_argument('--mode', default='store')
    a = ap.parse_args()
    if os.listdir(a.workdir):
        raise SystemExit('workdir must be empty')
    print(json.dumps(make_fixture(a.workdir, a.language, a.mode)))
