#!/usr/bin/env python3
"""Проверка Store-пакета и релизного каталога xDrive Offroad Pro (только стандартная библиотека).

    python3 -I native/scripts/verify_store_package.py package <id@ver.tgz> --spec <app.json>
    python3 -I native/scripts/verify_store_package.py release <native/release> --spec <app.json> [--repository o/r --tag t]

package: архив без обхода путей, ссылок и спецфайлов; без node_modules/oap-sdk, бинарников и GPL;
package.json (id, x.y.z, mguHmi, requires, без автозапуска); настоящие main/kit/RHMI (33 языка),
русская локаль и кириллица, уведомления шрифтов и лицензий; SOME/IP-манифест = платформа сборщика +
сигналы app.json, у сигналов только r/s.
release: объединённый выпуск — приложение, наборы xop-camera-bridge и xop-camrx (release_tools.verify_kit:
формат deploy, sha256 файлов, юнит, Node 8, ELF), исходники xop-camrx (GPL), catalog.json (schema 2: три компонента,
цепочка app -> bridge -> camrx, mgu-render >= 0.6.21), mgu-store.json, icon.png, SHA256SUMS — размеры и sha256 совпадают.
Печатает JSON-сводку; при проблемах — их список и код 1.
"""
import argparse
import ast
import hashlib
import io
import json
import os
import posixpath
import re
import struct
import sys
import tarfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import release_tools as rt  # noqa: E402  (tool kits, ELF policy, source archive, catalog graph)

PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
DEFAULT_BUILDER = os.path.join(PROJECT, 'vendor', 'idrive7-apps', 'kit', 'tools', 'build.py')

SEMVER = re.compile(r'^\d+\.\d+\.\d+$')
# Минимальные версии установленного профиля: рендерер, с которым говорит приложение, и deploy с линковкой SDK от донора.
MIN_REQUIRES = {'mgu-render': '0.6.21', 'mgu-deploy': '0.8.19'}
MAX_ARCHIVE = 32 << 20
MAX_ICON = 128 << 10
CYRILLIC = re.compile('[Ѐ-ӿ]')
ROOT_PREFIX = 'package'

# Уведомления для атласов шрифтов: подстрока поля "source" атласа -> (файл рядом, обязательная строка в нём)
FONT_NOTICES = (
    ('Ubuntu', 'UFL-Ubuntu.txt', 'UBUNTU FONT LICENCE Version 1.0'),
    ('Noto Sans SC', 'OFL-NotoSansSC.txt', 'SIL OPEN FONT LICENSE'),
    ('Barlow', 'OFL-Barlow.txt', 'SIL OPEN FONT LICENSE'),
)
MIT_MARKERS = ('MIT License', 'Permission is hereby granted, free of charge')
BINARY_MAGIC = (b'\x7fELF', b'\x00asm', b'MZ', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe')
BANNED_SUFFIXES = ('.wasm', '.wad', '.so', '.node', '.mgu', '.tgz', '.dll', '.exe', '.pem', '.key')
BANNED_SEGMENTS = ('node_modules', 'oap-sdk', 'renderd', 'emu', 'doom', 'oapgen')


class Problems(list):
    def check(self, ok, msg):
        if not ok:
            self.append(msg)
        return ok


def semver(v):
    return tuple(int(n) for n in v.split('.')) if isinstance(v, str) and SEMVER.match(v) else None


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def builder_constants(path):
    """PLATFORM_PROXIES, PLATFORM_SERVICES, LANGS из сборщика — через ast, без выполнения."""
    if not os.path.isfile(path):
        raise SystemExit('builder not found: %s (run npm run native:vendor)' % path)
    tree = ast.parse(open(path, encoding='utf-8').read(), path)
    want = {'PLATFORM_PROXIES', 'PLATFORM_SERVICES', 'LANGS'}
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in want:
                out[node.targets[0].id] = ast.literal_eval(node.value)
    missing = want - set(out)
    if missing:
        raise SystemExit('builder %s lacks %s' % (path, ', '.join(sorted(missing))))
    return out


def safe_name(name):
    if not name or '\x00' in name or '\\' in name or name.startswith('/'):
        return False
    n = name.rstrip('/')
    return posixpath.normpath(n) == n and '..' not in n.split('/') and n.split('/')[0] == ROOT_PREFIX


def png_size(b):
    if len(b) < 24 or b[:8] != b'\x89PNG\r\n\x1a\n' or b[12:16] != b'IHDR':
        return None
    return struct.unpack('>II', b[16:24])


def read_archive(path, problems):
    """Файлы архива {путь без package/: bytes}; проверки безопасности членов tar."""
    files = {}
    if not problems.check(os.path.isfile(path), 'package not found: %s' % path):
        return files
    problems.check(os.path.getsize(path) <= MAX_ARCHIVE, 'package is over %d MiB' % (MAX_ARCHIVE >> 20))
    try:
        tf = tarfile.open(path, mode='r:gz')
    except (tarfile.TarError, OSError) as e:
        problems.append('not a gzip tar: %s' % e)
        return files
    seen = set()
    total = 0
    with tf:
        for m in tf:
            name = m.name
            if not problems.check(safe_name(name), 'unsafe or foreign path in archive: %r' % name):
                continue
            key = name.rstrip('/')
            problems.check(key not in seen, 'duplicate archive entry: %s' % key)
            seen.add(key)
            if m.issym() or m.islnk():
                problems.append('link in archive: %s -> %s' % (name, m.linkname))
                continue
            if not (m.isfile() or m.isdir()):
                problems.append('special file in archive: %s' % name)
                continue
            problems.check(not (m.mode & 0o7000), 'setuid/setgid/sticky mode on %s' % name)
            if m.isfile():
                total += m.size
                if not problems.check(total <= 4 * MAX_ARCHIVE, 'archive expands past %d MiB' % (4 * MAX_ARCHIVE >> 20)):
                    break
                files[key[len(ROOT_PREFIX) + 1:]] = tf.extractfile(m).read()
    return files


def load_json(files, rel, problems):
    if not problems.check(rel in files, 'missing %s' % rel):
        return None
    try:
        return json.loads(files[rel].decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        problems.append('%s does not parse: %s' % (rel, e))
        return None


def text(files, rel):
    try:
        return files.get(rel, b'').decode('utf-8')
    except UnicodeDecodeError:
        return ''


def check_contents(files, problems):
    for rel, data in files.items():
        segs = rel.split('/')
        for s in BANNED_SEGMENTS:
            problems.check(s not in segs, 'forbidden path segment %r: %s' % (s, rel))
        problems.check(not rel.endswith(BANNED_SUFFIXES), 'forbidden file type: %s' % rel)
        problems.check(not data.startswith(BINARY_MAGIC), 'binary executable or module: %s' % rel)
        problems.check(b'GNU GENERAL PUBLIC LICENSE' not in data, 'GPL licence text in %s' % rel)
    problems.check('meta.json' not in files, 'meta.json (the .mgu layout) in a store package')


# The one diagnostic transport the app may declare (read-only use is enforced in native/src/vehicle/uds/tasu.ts):
# the head unit's InternalTasu, exactly as the MIT idrive7-apps car_vitals / zf8hp apps declare it.
TASU_IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'
TASU_ENTRY = {'instances': 'SystemFunctionsInternalTasuInst1', 'methods': ['sendTasuRequest'], 'broadcasts': ['sendTasuResponse']}
# Live cameras (native/src/camera/request.ts): the camera unit's state plus an ordinary view request and its release.
ICAM2_IFACE = 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy'
ICAM2_ENTRY = {'instances': '1', 'attributes': {'currentState': 'rs'}, 'methods': ['changeState', 'clientAttach', 'clientDetach']}


def check_signals(manifest, spec, consts, problems):
    proxies = manifest.get('proxies') if isinstance(manifest, dict) else None
    if not problems.check(isinstance(proxies, dict), 'manifest.json has no proxies'):
        return
    problems.check(manifest.get('services') == consts['PLATFORM_SERVICES'], 'manifest.json services differ from the builder platform services')
    signals = spec.get('signals') or {}
    expected = set(consts['PLATFORM_PROXIES']) | set(signals)
    for iface in sorted(set(proxies) - expected):
        problems.append('manifest.json interface not in app.json signals or the builder platform set: %s' % iface)
    for iface in sorted(expected - set(proxies)):
        problems.append('manifest.json lacks %s' % iface)
    for iface, entry in proxies.items():
        if iface in signals:
            continue
        if iface in consts['PLATFORM_PROXIES']:
            problems.check(entry == consts['PLATFORM_PROXIES'][iface], 'platform interface %s differs from the builder' % iface)
    for iface, fields in signals.items():
        entry = proxies.get(iface)
        if not isinstance(entry, dict):
            problems.append('candidate %s is not a field list in manifest.json' % iface)
            continue
        if iface == TASU_IFACE:
            problems.check(entry == TASU_ENTRY, 'diagnostic transport %s is %r, expected exactly %r' % (iface, entry, TASU_ENTRY))
            continue
        if iface == ICAM2_IFACE:
            problems.check(entry == ICAM2_ENTRY, 'camera interface %s is %r, expected exactly %r' % (iface, entry, ICAM2_ENTRY))
            continue
        want = {k: v for k, v in fields.items() if not k.startswith('_')}
        attrs = entry.get('attributes') or {}
        problems.check(attrs == want, 'candidate %s attributes %r differ from app.json %r' % (iface, attrs, want))
        for name, mode in attrs.items():
            problems.check(isinstance(mode, str) and mode and set(mode) <= set('rs'),
                           'candidate %s.%s access %r is not read/subscribe only' % (iface, name, mode))
        problems.check(not entry.get('methods') and not entry.get('broadcasts'), 'candidate %s has methods or broadcasts' % iface)
        problems.check(entry.get('instances') == '1', 'candidate %s instances %r' % (iface, entry.get('instances')))
    for iface, entry in proxies.items():
        for name, mode in ((entry.get('attributes') or {}) if isinstance(entry, dict) else {}).items():
            problems.check('w' not in str(mode), 'write access %s.%s=%r in manifest.json' % (iface, name, mode))


def check_rhmi(files, app_id, ver, consts, language, state_ids, problems):
    app = load_json(files, 'rhmiData/application.json', problems)
    if not app:
        return None
    a = app.get('application') or {}
    problems.check(a.get('name') == app_id, 'rhmiData application name %r' % a.get('name'))
    problems.check(a.get('version') == ver, 'rhmiData application version %r != %s' % (a.get('version'), ver))
    problems.check(a.get('type') == 'OnlineApp', 'rhmiData application type %r' % a.get('type'))
    eps = a.get('entryPoints') or []
    icon_rel = None
    if problems.check(len(eps) == 1, 'rhmiData has %d entry points' % len(eps)):
        icon_rel = 'rhmiData/variantGroups/Common/images/' + str(eps[0].get('icon'))
        problems.check(icon_rel in files, 'entry point icon missing: %s' % icon_rel)
    uis = {tuple(u.get('hmi') or []): u for u in a.get('uiDescriptions') or []}
    states = []
    if problems.check(('ID7',) in uis, 'rhmiData has no ID7 uiDescription'):
        u = uis[('ID7',)]
        appxml = posixpath.normpath(posixpath.join('rhmiData', u.get('applicationFilePath', '')))
        uidesc = posixpath.normpath(posixpath.join('rhmiData', u.get('uiDescriptionFilePath', '')))
        if problems.check(appxml in files, 'missing %s' % appxml):
            try:
                root = ET.fromstring(files[appxml])
                problems.check(root.tag == 'application', '%s root is %s' % (appxml, root.tag))
                states = sorted(int(c.get('id')) for c in root.iter('container') if c.get('type') == 'state')
                want = sorted(state_ids.values()) if isinstance(state_ids, dict) else None
                problems.check(bool(states) and states == want, 'ID7 states %r != app-spec.json stateIds %r' % (states, want))
            except ET.ParseError as e:
                problems.append('%s does not parse: %s' % (appxml, e))
        d = load_json(files, uidesc, problems)
        if isinstance(d, dict):
            problems.check(bool(d.get('containers')), '%s has no containers' % uidesc)
    texts = 'rhmiData/variantGroups/Common/texts/'
    langs = sorted(r[len(texts):-5] for r in files if r.startswith(texts) and r.endswith('.json'))
    problems.check(langs == sorted(consts['LANGS']), 'RHMI texts for %d locales, expected %d: %s' % (len(langs), len(consts['LANGS']), langs))
    bundles = [load_json(files, texts + l + '.json', problems) for l in langs]
    if bundles and all(isinstance(b, dict) for b in bundles):
        problems.check(all(b == bundles[0] for b in bundles), 'RHMI string bundles differ between locales')
        title = [v for k, v in bundles[0].items() if k.endswith('_TITLE')]
        problems.check(bool(title), 'RHMI strings have no title')
        if language == 'ru':
            problems.check(any(CYRILLIC.search(str(v)) for v in bundles[0].values()), 'RHMI strings have no Cyrillic text')
    return {'icon': icon_rel, 'locales': len(langs), 'states': states}


def check_fonts(files, problems):
    fonts = 'javascript/kit/fonts/'
    atlases = sorted(r for r in files if r.startswith(fonts) and r.endswith('.json'))
    problems.check(bool(atlases), 'no font atlases in javascript/kit/fonts')
    notices = set()
    for rel in atlases:
        try:
            source = str(json.loads(files[rel].decode('utf-8')).get('source', ''))
        except (UnicodeDecodeError, ValueError, AttributeError):
            problems.append('%s does not parse' % rel)
            continue
        hit = [n for n in FONT_NOTICES if n[0] in source]
        if problems.check(len(hit) == 1, '%s: no known licence for font source %r' % (rel, source)):
            notices.add(hit[0])
    for _, name, marker in sorted(notices):
        problems.check(marker in text(files, fonts + name), 'font notice %s missing or incomplete' % (fonts + name))
    return [n[1] for n in sorted(notices)]


def verify_package(path, spec, builder=DEFAULT_BUILDER, language='ru'):
    """Возвращает (сводка или None, проблемы, байты значка точки входа)."""
    consts = builder_constants(builder)
    problems = Problems()
    files = read_archive(path, problems)
    if not files:
        problems.check(False, 'package has no files')
        return None, problems, b''
    check_contents(files, problems)
    app_id = spec.get('id')
    pkg = load_json(files, 'package.json', problems) or {}
    ver = pkg.get('version')
    problems.check(pkg.get('name') == app_id, 'package.json name %r != %r' % (pkg.get('name'), app_id))
    problems.check(semver(ver) is not None, 'package.json version %r is not x.y.z (mgu-deploy refuses it)' % ver)
    # --store-package keeps app.json's base version for every language (no localize suffix)
    problems.check(ver == spec.get('version'), 'package.json version %r != app.json %r' % (ver, spec.get('version')))
    problems.check(os.path.basename(path) == '%s@%s.tgz' % (app_id, ver), 'file name %s is not <id>@<version>.tgz' % os.path.basename(path))
    problems.check(pkg.get('mguHmi') == spec.get('mguHmi') == ['ID7'], 'package.json mguHmi %r (app.json %r)' % (pkg.get('mguHmi'), spec.get('mguHmi')))
    req = pkg.get('requires') or {}
    for k, v in MIN_REQUIRES.items():
        problems.check(semver(req.get(k)) is not None and semver(req.get(k)) >= semver(v), 'package.json requires %s %r, at least %s' % (k, req.get(k), v))
    problems.check('mguAppStartType' not in pkg and not spec.get('autostart'), 'autostart is set')
    problems.check('mguService' not in pkg, 'package.json has mguService')
    problems.check(pkg.get('license') == 'UNLICENSED', 'package.json license %r (the app itself is UNLICENSED)' % pkg.get('license'))
    problems.check(pkg.get('main') == 'javascript/app.js', 'package.json main %r' % pkg.get('main'))
    oap = pkg.get('oapAppSettings') or {}
    problems.check(oap.get('loggingId') == spec.get('loggingId') and oap.get('someipManifest') == 'manifest.json', 'oapAppSettings %r' % oap)
    shrink = load_json(files, 'npm-shrinkwrap.json', problems) or {}
    problems.check(shrink.get('name') == app_id and shrink.get('version') == ver, 'npm-shrinkwrap.json names %r %r' % (shrink.get('name'), shrink.get('version')))
    problems.check(isinstance(load_json(files, 'permissions.json', problems), (dict, list)), 'permissions.json is empty')
    base = load_json(files, 'config/base.json', problems) or {}
    problems.check(base.get('rhmiLoadingEnabled') is True and base.get('entryPointLoadingEnabled') is True, 'config/base.json loading flags')

    main = text(files, 'javascript/app.js')
    problems.check(len(main) > 1000 and re.search(r'''require\(["']\./kit/mgu["']\)''', main) is not None, 'javascript/app.js is not the app bundle')
    problems.check(len(files.get('javascript/assets.js', b'')) > 1000, 'javascript/assets.js missing or empty')
    notice = text(files, 'javascript/NOTICE')
    problems.check(all(m in notice for m in MIT_MARKERS) and 'applies to those portions only' in notice,
                   'javascript/NOTICE lacks the MIT text or its scope (derived portions only)')
    problems.check(all(m in text(files, 'javascript/kit/LICENSE') for m in MIT_MARKERS), 'javascript/kit/LICENSE lacks the MIT text')
    for m in ('mgu.js', 'record.js', 'gauges.js', 'canvas.js', 'fonts.js'):
        problems.check(len(files.get('javascript/kit/' + m, b'')) > 0, 'kit runtime javascript/kit/%s missing' % m)
    rt = load_json(files, 'javascript/kit/app-spec.json', problems) or {}
    problems.check(rt.get('id') == app_id and rt.get('version') == ver, 'app-spec.json names %r %r' % (rt.get('id'), rt.get('version')))
    ds = [s for s in rt.get('settings') or [] if s.get('key') == 'dataSource']
    # 0.1.2: vehicle data by default; the data source is a hidden setting (demo only via XOP_DEV at launch, never stored)
    problems.check(len(ds) == 1 and ds[0].get('default') == 'vehicle' and ds[0].get('hidden') is True,
                   'data source is not a hidden setting defaulting to vehicle')
    loc = load_json(files, 'javascript/kit/locale.json', problems) or {}
    problems.check(loc.get('language') == language, 'locale.json language %r != %r' % (loc.get('language'), language))
    if language == 'ru':
        strings = loc.get('strings') or {}
        problems.check(len(strings) > 50 and any(CYRILLIC.search(str(v)) for v in strings.values()), 'locale.json has no Russian strings')
        cyr = load_json(files, 'javascript/kit/fonts/cyrillic.json', problems) or {}
        problems.check(cyr.get('family') == 'cyrillic' and bool(cyr.get('sizes')), 'javascript/kit/fonts/cyrillic.json is not the Cyrillic atlas')
        problems.check(main.startswith('// Translation by:'), 'javascript/app.js lacks the translation credit comment')
    font_notices = check_fonts(files, problems)
    manifest = load_json(files, 'manifest.json', problems) or {}
    check_signals(manifest, spec, consts, problems)
    rhmi = check_rhmi(files, app_id, ver, consts, language, rt.get('stateIds'), problems) or {}
    icon = files.get(rhmi.get('icon') or '', b'')
    size = png_size(icon)
    problems.check(size is not None and len(icon) <= MAX_ICON, 'entry point icon is not a PNG of at most 128 KiB')
    summary = {
        'file': os.path.basename(path), 'size': os.path.getsize(path), 'sha256': sha256(open(path, 'rb').read()),
        'id': app_id, 'version': ver, 'description': pkg.get('description'), 'mguHmi': pkg.get('mguHmi'), 'requires': req,
        'files': len(files), 'locales': rhmi.get('locales'), 'states': rhmi.get('states'), 'icon': rhmi.get('icon'),
        'iconSize': list(size) if size else None, 'fontNotices': font_notices,
        'candidateInterfaces': sorted((spec.get('signals') or {}).keys()),
    }
    return summary, problems, icon


def _tool_kits(names):
    return {tid: [n for n in names if n.startswith(tid + '@') and n.endswith('.tgz')] for tid in rt.TOOL_IDS}


def verify_release(directory, spec, builder=DEFAULT_BUILDER, repository=None, tag=None, language='ru', node8=None):
    """The combined release: the app, xop-camera-bridge and xop-camrx kits, the xop-camrx corresponding source,
    icon.png, catalog.json (schema 2, three components and their dependency chain), mgu-store.json, SHA256SUMS."""
    problems = Problems()
    if not os.path.isdir(directory):
        problems.append('release folder not found: %s' % directory)
        return None, problems
    names = sorted(os.listdir(directory))
    for n in names:
        p = os.path.join(directory, n)
        problems.check(os.path.isfile(p) and not os.path.islink(p), '%s is not a regular file' % n)
    app_id = spec.get('id')
    tgzs = [n for n in names if n.startswith(app_id + '@') and n.endswith('.tgz')]
    kits = _tool_kits(names)
    sources = [n for n in names if re.match(r'^xop-camrx-\d+\.\d+\.\d+-source\.tar\.gz$', n)]
    expected = {'catalog.json', 'mgu-store.json', 'icon.png', 'SHA256SUMS'}
    known = expected | set(tgzs) | set(sources) | {n for v in kits.values() for n in v}
    for n in sorted(set(names) - known):
        if n != '.gitkeep':
            copy = rt.conflict_copy_of(n, lambda b: b in known)
            problems.append('conflict copy of %s in release folder: %s' % (copy, n) if copy else 'unexpected file in release folder: %s' % n)
    for n in sorted(expected - set(names)):
        problems.append('missing %s' % n)
    problems.check(len(tgzs) == 1, 'expected exactly one %s@<version>.tgz, found %r' % (app_id, tgzs))
    for tid, found in kits.items():
        problems.check(len(found) == 1, 'expected exactly one %s@<version>.tgz, found %r' % (tid, found))
    problems.check(len(sources) == 1, 'expected exactly one xop-camrx-<version>-source.tar.gz, found %r' % sources)
    if problems:
        return None, problems
    pkg, pkg_problems, pkg_icon = verify_package(os.path.join(directory, tgzs[0]), spec, builder, language)
    problems.extend('package: ' + p for p in pkg_problems)
    tool = {}
    for tid in rt.TOOL_IDS:
        s, kp = rt.verify_kit(os.path.join(directory, kits[tid][0]), tid, node8 if tid == rt.BRIDGE_ID else None)
        problems.extend('%s: %s' % (tid, p) for p in kp)
        tool[tid] = s
    if not pkg or pkg_problems or not all(tool.values()) or problems:
        return None, problems

    def read(n):
        return open(os.path.join(directory, n), 'rb').read()

    camrx = tool[rt.CAMRX_ID]
    src = camrx.get('source') or {}
    problems.check(src.get('name') == sources[0], 'xop-camrx NOTICE names %r, the release has %s' % (src.get('name'), sources[0]))
    problems.check(src.get('sha256') == sha256(read(sources[0])), 'xop-camrx NOTICE source sha256 does not match %s' % sources[0])
    problems.check(sources[0] == 'xop-camrx-%s-source.tar.gz' % camrx['version'], 'source archive version differs from the xop-camrx kit')
    elf_sha = None
    with tarfile.open(os.path.join(directory, kits[rt.CAMRX_ID][0]), 'r:gz') as t:
        elf_sha = sha256(t.extractfile('files/xop-camrx').read())
    problems.extend(rt.verify_source_archive(os.path.join(directory, sources[0]), camrx['version'], elf_sha))

    icon = read('icon.png')
    problems.check(icon == pkg_icon, 'icon.png is not the package entry-point icon')
    problems.check(png_size(icon) is not None and len(icon) <= MAX_ICON, 'icon.png is not a PNG of at most 128 KiB')
    try:
        catalog = json.loads(read('catalog.json').decode('utf-8'))
        store = json.loads(read('mgu-store.json').decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        problems.append('catalog.json or mgu-store.json does not parse: %s' % e)
        return None, problems
    problems.check(catalog.get('schema') == 2, 'catalog.json schema %r' % catalog.get('schema'))
    comps = catalog.get('components') or []
    ids = [c.get('id') for c in comps]
    if not problems.check(sorted(ids) == sorted([app_id] + list(rt.TOOL_IDS)) and len(ids) == 3,
                          'catalog.json lists %r, expected %s, %s and %s' % (ids, app_id, rt.BRIDGE_ID, rt.CAMRX_ID)):
        return None, problems
    by_id = {c['id']: c for c in comps}
    artifacts = {app_id: pkg, rt.BRIDGE_ID: tool[rt.BRIDGE_ID], rt.CAMRX_ID: camrx}

    def url_of(name):
        return 'https://github.com/%s/releases/download/%s/%s' % (repository, tag or 'catalog', name) if repository else name

    for cid, s in artifacts.items():
        c = by_id[cid]
        kind = 'app' if cid == app_id else 'tool'
        problems.check(c.get('kind') == kind, '%s: catalog kind %r' % (cid, c.get('kind')))
        problems.check(c.get('version') == s['version'], '%s: catalog version %r != artifact %r' % (cid, c.get('version'), s['version']))
        problems.check('build' not in c, '%s: catalog entry has "build" (artifacts are built)' % cid)
        problems.check(c.get('mguHmi') == ['ID7'], '%s: catalog mguHmi %r' % (cid, c.get('mguHmi')))
        problems.check(c.get('uninstallable') is True, '%s: not uninstallable' % cid)
        problems.check('optional' not in c and 'mguProvides' not in c, '%s: optional/mguProvides set (installed as a requirement)' % cid)
        problems.check(bool(c.get('title')) and bool(c.get('description')), '%s: catalog title/description empty' % cid)
        art = c.get('artifact') or {}
        problems.check(art.get('name') == s['file'], '%s: artifact name %r != %r' % (cid, art.get('name'), s['file']))
        problems.check(art.get('size') == s['size'], '%s: artifact size %r != %r' % (cid, art.get('size'), s['size']))
        problems.check(art.get('sha256') == s['sha256'], '%s: artifact sha256 does not match the file' % cid)
        problems.check(art.get('url') == url_of(s['file']), '%s: artifact url %r != %r' % (cid, art.get('url'), url_of(s['file'])))
    app_req = by_id[app_id].get('requires') or {}
    problems.check({k: app_req.get(k) for k in pkg['requires']} == pkg['requires'], 'app catalog requires %r lack the package requires %r' % (app_req, pkg['requires']))
    rt.check_catalog_graph(comps, problems, app_id)
    c = by_id[app_id]
    problems.check(c.get('icon') == url_of('icon.png') and c.get('iconSha256') == sha256(icon), 'catalog icon / iconSha256')
    entry = (store.get('apps') or {}).get(app_id) or {}
    problems.check(list((store.get('apps') or {}).keys()) == [app_id], 'mgu-store.json apps %r' % list((store.get('apps') or {}).keys()))
    problems.check(entry.get('title') == c.get('title') and entry.get('description') == c.get('description'), 'mgu-store.json title/description differ from catalog')
    problems.check(entry.get('icon') == 'icon.png' and entry.get('iconSha256') == sha256(icon), 'mgu-store.json icon / iconSha256')
    sums = {}
    for line in read('SHA256SUMS').decode('utf-8').splitlines():
        m = re.match(r'^([0-9a-f]{64})  ([^/\\]+)$', line)
        if problems.check(m is not None, 'SHA256SUMS line %r' % line):
            sums[m.group(2)] = m.group(1)
    listed = sorted(set(names) - {'SHA256SUMS', '.gitkeep'})
    problems.check(sorted(sums) == listed, 'SHA256SUMS lists %r, expected %r' % (sorted(sums), listed))
    for n, h in sums.items():
        if n in names:
            problems.check(sha256(read(n)) == h, 'SHA256SUMS mismatch for %s' % n)
    url = by_id[app_id]['artifact']['url']
    return dict(pkg, catalogUrl=url, tools={k: {x: v[x] for x in ('file', 'size', 'sha256', 'version')} for k, v in tool.items()},
                source=sources[0], node8Check=tool[rt.BRIDGE_ID].get('node8Check'), elf=camrx.get('elf')), problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mode', choices=('package', 'release'))
    ap.add_argument('path')
    ap.add_argument('--spec', required=True, help='the generated app.json (native/dist/<id>/app.json)')
    ap.add_argument('--builder', default=DEFAULT_BUILDER)
    ap.add_argument('--language', default='ru')
    ap.add_argument('--repository')
    ap.add_argument('--tag')
    ap.add_argument('--node8', default=os.environ.get('XOP_NODE8', rt.NODE8_DEFAULT),
                    help='Node 8 binary for the bridge syntax check ("" skips it)')
    a = ap.parse_args(argv)
    if not os.path.isfile(a.spec):
        print('app.json not found: %s (run npm run native:build)' % a.spec, file=sys.stderr)
        return 2
    spec = json.load(open(a.spec, encoding='utf-8'))
    if a.mode == 'package':
        summary, problems, _icon = verify_package(a.path, spec, a.builder, a.language)
    else:
        summary, problems = verify_release(a.path, spec, a.builder, a.repository, a.tag, a.language, a.node8 or None)
    if problems:
        print('%s verification failed (%d problems):' % (a.mode, len(problems)), file=sys.stderr)
        for p in problems:
            print('  - ' + p, file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
