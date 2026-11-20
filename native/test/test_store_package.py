#!/usr/bin/env python3
"""Тесты Store-упаковки: настоящий RU-пакет из native/release (npm run native:package), подменённые архивы
и каталоги во временных папках, синтетическое приложение (store_fixture) для отказов и повторяемости сборки.

    python3 -I native/test/test_store_package.py
"""
import gzip
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path[:0] = [HERE, os.path.join(PROJECT, 'native', 'scripts')]

import store_fixture  # noqa: E402
import verify_store_package as v  # noqa: E402

import release_tools as rt  # noqa: E402

RELEASE = os.path.join(PROJECT, 'native', 'release')
SPEC_FILE = os.path.join(PROJECT, 'native', 'dist', 'xdrive_offroad_pro', 'app.json')


def release_tgz():
    """The app archive of a combined release in native/release (app + both tool kits), else None: an older
    app-only folder (or iCloud placeholders read as empty) is not a release these tests describe."""
    if not os.path.isdir(RELEASE):
        return None
    names = os.listdir(RELEASE)
    apps = [n for n in names if n.startswith('xdrive_offroad_pro@') and n.endswith('.tgz')]
    kits = [n for n in names if n.startswith(rt.TOOL_IDS) and n.endswith('.tgz')]
    if len(apps) != 1 or len(kits) != 2:
        return None
    path = os.path.join(RELEASE, apps[0])
    try:
        return path if os.path.getsize(path) > 0 and len(open(path, 'rb').read(64)) > 0 else None
    except OSError:
        return None


def read_members(path):
    with tarfile.open(path, 'r:gz') as t:
        return [(m, t.extractfile(m).read() if m.isfile() else None) for m in t.getmembers()]


def write_tgz(path, members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.PAX_FORMAT) as t:
        for m, data in members:
            t.addfile(m, io.BytesIO(data) if data is not None else None)
    with open(path, 'wb') as f:
        f.write(gzip.compress(buf.getvalue(), mtime=0))


def file_member(name, data):
    m = tarfile.TarInfo(name)
    m.size = len(data)
    m.mode = 0o644
    return m, data


@unittest.skipUnless(release_tgz() and os.path.isfile(SPEC_FILE), 'run npm run native:package first')
class RealRelease(unittest.TestCase):
    def setUp(self):
        self.spec = json.load(open(SPEC_FILE, encoding='utf-8'))
        self.tgz = release_tgz()
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def repack(self, edit):
        """Копия настоящего пакета с изменёнными записями; имя файла то же (<id>@<x.y.z>.tgz)."""
        out = os.path.join(self.tmp, os.path.basename(self.tgz))
        write_tgz(out, edit(read_members(self.tgz)))
        return out

    def test_ru_package_structure(self):
        summary, problems, icon = v.verify_package(self.tgz, self.spec)
        self.assertEqual(list(problems), [])
        self.assertEqual(summary['version'], self.spec['version'])
        self.assertRegex(summary['version'], r'^\d+\.\d+\.\d+$')
        self.assertTrue(summary['locales'] and summary['states'])
        files = dict((m.name, d) for m, d in read_members(self.tgz) if d is not None)
        pkg = json.loads(files['package/package.json'])
        self.assertNotIn('-ru', pkg['version'])
        self.assertTrue(any(v.CYRILLIC.search(d.decode('utf-8', 'ignore')) for n, d in files.items() if n.startswith('package/rhmiData/')))
        self.assertTrue(icon.startswith(b'\x89PNG'))

    def test_release_catalog_hashes_and_mismatch(self):
        with open(os.path.join(RELEASE, 'catalog.json'), encoding='utf-8') as f:
            cat = json.load(f)
        app = [c for c in cat['components'] if c['id'] == self.spec['id']][0]
        repo = tag = None
        url = app['artifact']['url']
        if url.startswith('https://github.com/'):
            repo = '/'.join(url.split('/')[3:5])
            tag = url.split('/')[7]
            self.assertEqual(app['icon'], url.rsplit('/', 1)[0] + '/icon.png')
        _summary, problems = v.verify_release(RELEASE, self.spec, repository=repo, tag=tag)
        self.assertEqual(list(problems), [])
        d = os.path.join(self.tmp, 'rel')
        shutil.copytree(RELEASE, d)
        app['artifact']['sha256'] = '0' * 64
        with open(os.path.join(d, 'catalog.json'), 'w', encoding='utf-8') as f:
            json.dump(cat, f)
        _summary, problems = v.verify_release(d, self.spec, repository=repo, tag=tag)
        self.assertTrue(any('sha256' in p for p in problems), problems)
        self.assertTrue(any('SHA256SUMS mismatch for catalog.json' in p for p in problems), problems)
        if repo:
            _summary, problems = v.verify_release(RELEASE, self.spec, repository=repo, tag='other')
            self.assertTrue(any('catalog icon' in p for p in problems), problems)

    def test_rejects_sdk_gpl_autostart_and_write_signals(self):
        def edit(members):
            out = []
            for m, d in members:
                if m.name == 'package/package.json':
                    p = json.loads(d)
                    p['mguAppStartType'] = 'autostart'
                    d = json.dumps(p).encode()
                    m.size = len(d)
                elif m.name == 'package/manifest.json':
                    d = d.replace(b'"rs"', b'"rws"', 1)
                    m.size = len(d)
                out.append((m, d))
            out.append(file_member('package/node_modules/oap-sdk/index.js', b'//'))
            out.append(file_member('package/COPYING', b'GNU GENERAL PUBLIC LICENSE'))
            return out
        _s, problems, _i = v.verify_package(self.repack(edit), self.spec)
        text = '\n'.join(problems)
        for want in ('node_modules', 'oap-sdk', 'GPL', 'autostart', 'write access'):
            self.assertIn(want, text)

    def test_rejects_traversal_and_symlink(self):
        def edit(members):
            link = tarfile.TarInfo('package/evil')
            link.type = tarfile.SYMTYPE
            link.linkname = '/etc/passwd'
            return members + [file_member('package/../escape.js', b'x'), (link, None)]
        _s, problems, _i = v.verify_package(self.repack(edit), self.spec)
        self.assertTrue(any('unsafe or foreign path' in p for p in problems), problems)
        self.assertTrue(any('link in archive' in p for p in problems), problems)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def build(self, name, spec=None, language='ru'):
        d = os.path.join(self.tmp, name)
        os.makedirs(d)
        return store_fixture.make_fixture(d, language, 'store', spec)

    def spec(self, **kw):
        s = json.loads(json.dumps(store_fixture.SPEC))
        s.update(kw)
        return s

    def test_missing_input_fails(self):
        self.assertEqual(v.main(['package', os.path.join(self.tmp, 'none.tgz'), '--spec', os.path.join(self.tmp, 'none.json')]), 2)
        _s, problems, _i = v.verify_package(os.path.join(self.tmp, 'none.tgz'), store_fixture.SPEC)
        self.assertTrue(any('package not found' in p for p in problems), problems)

    def test_wrong_hmi_and_strict_version_rejected(self):
        for name, spec, want in (('hmi', self.spec(mguHmi=['ID9']), 'mguHmi'),
                                 ('ver', self.spec(version='1.2.3-ru.1'), 'not x.y.z'),
                                 ('ver2', self.spec(version='1.2'), 'not x.y.z')):
            r = self.build(name, spec)
            self.assertNotEqual(r['code'], 0, name)
            self.assertIn(want, r['stderr'], name)
            self.assertIsNone(r['tgz'], name)

    def test_ru_store_build_keeps_base_version_and_is_deterministic(self):
        a, b = self.build('a'), self.build('b')
        self.assertEqual((a['code'], b['code']), (0, 0), a['stderr'] + b['stderr'])
        self.assertTrue(a['tgz'].endswith('store_fixture@1.2.3.tgz'))
        ha, hb = (hashlib.sha256(open(r['tgz'], 'rb').read()).hexdigest() for r in (a, b))
        self.assertEqual(ha, hb)
        files = dict((m.name, d) for m, d in read_members(a['tgz']) if d is not None)
        self.assertEqual(json.loads(files['package/package.json'])['version'], '1.2.3')
        self.assertFalse(any(n.startswith('package/node_modules') for n in files))


class DiagnosticTransportSignals(unittest.TestCase):
    """check_signals: InternalTasu is accepted exactly as declared; any other method/event/attribute is not."""

    CONSTS = {'PLATFORM_PROXIES': {}, 'PLATFORM_SERVICES': []}
    SPEC = {'signals': {v.TASU_IFACE: {'_optional': 'x', '_instances': 'SystemFunctionsInternalTasuInst1',
                                       '_methods': ['sendTasuRequest'], '_broadcasts': ['sendTasuResponse']}}}

    def problems(self, entry):
        p = v.Problems()
        v.check_signals({'proxies': {v.TASU_IFACE: entry}, 'services': []}, self.SPEC, self.CONSTS, p)
        return p

    def test_exact_entry_accepted(self):
        self.assertEqual(self.problems(dict(v.TASU_ENTRY)), [])

    def test_camera_entry_exact(self):
        spec = {'signals': {v.ICAM2_IFACE: {'_optional': 'x', 'currentState': 'rs', '_methods': ['changeState', 'clientAttach', 'clientDetach']}}}
        ok = v.Problems()
        v.check_signals({'proxies': {v.ICAM2_IFACE: dict(v.ICAM2_ENTRY)}, 'services': []}, spec, self.CONSTS, ok)
        self.assertEqual(ok, [])
        bad = v.Problems()
        v.check_signals({'proxies': {v.ICAM2_IFACE: dict(v.ICAM2_ENTRY, methods=['changeState', 'clientAttach', 'clientDetach', 'setConfiguration'])}, 'services': []}, spec, self.CONSTS, bad)
        self.assertTrue(bad)

    def test_extra_method_or_attribute_rejected(self):
        for bad in (dict(v.TASU_ENTRY, methods=['sendTasuRequest', 'clearDtc']),
                    dict(v.TASU_ENTRY, attributes={'x': 'rws'}),
                    dict(v.TASU_ENTRY, instances='1')):
            self.assertTrue(self.problems(bad), bad)


# ---------------------------------------------------------------- combined release: tool kits, helper, catalog

HELPER = os.path.join(PROJECT, 'native', 'camrx', 'build', 'target', 'xop-camrx')
# a small x86-64 Linux ELF built once with the same Zig target/flags as build.sh target (any glibc-2.27 PIE that imports
# MFXInit and ias_avbbridge_create_receiver from stub sonames will do); its interpreter is patched below
ZIG_FIXTURE = os.environ.get('XOP_ELF_FIXTURE', '/private/tmp/xop-toolchains/pkg-fixture/fixture-elf')
NODE8 = os.environ.get('XOP_NODE8', rt.NODE8_DEFAULT)


def set_interp(data, interp):
    e = rt.Elf(data)
    out = bytearray(data)
    for p in e.ph:
        if p[0] == 3:
            new = interp.encode() + b'\0'
            assert len(new) <= p[5]
            out[p[2]:p[2] + p[5]] = new.ljust(p[5], b'\0')
    return bytes(out)


def helper_elf():
    """(bytes, origin) of an ELF that should pass the head-unit policy, or (None, why)."""
    for path, patch in ((HELPER, False), (ZIG_FIXTURE, True)):
        try:
            data = rt.read_input(path)
        except rt.PackError:
            continue
        return (set_interp(data, rt.ELF_INTERP) if patch else data), path
    return None, 'no helper build (%s) and no ELF fixture (%s)' % (HELPER, ZIG_FIXTURE)


def synthetic_bridge_js():
    """Stands in for the bundle: Node 8 syntax, built-ins only, the helper root and the runtime directory."""
    body = ["'use strict';", 'var fs = require("fs");', 'var net = require("net");', 'var cp = require("child_process");',
            'var BRIDGE_ID = "xop-camera-bridge";', 'var CTL_DIR = "/run/".concat(BRIDGE_ID);',
            'var CAMRX_ROOT = "/var/opt/xop-camrx";', 'var CAMRX = CAMRX_ROOT + "/current/xop-camrx";']
    body += ['function f%d(a) { try { return fs.existsSync(a + "%d"); } catch (e) { return false; } }' % (i, i) for i in range(60)]
    return ('\n'.join(body) + '\n').encode()


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    return path


class ToolKits(unittest.TestCase):
    """Kits in the deploy tool's format: reproducible, every payload hashed, only what each component must hold."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bridge_js = write(os.path.join(self.tmp, 'in', 'bridge.js'), synthetic_bridge_js())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def bridge_kit(self, name='k'):
        m = rt.load_manifest(rt.BRIDGE_ID)
        fname, data, _km = rt.build_kit(m, overrides={'bridge.js': self.bridge_js})
        return write(os.path.join(self.tmp, name, fname), data), data

    def test_bridge_kit_is_reproducible_and_valid(self):
        a, da = self.bridge_kit('a')
        _b, db = self.bridge_kit('b')
        self.assertEqual(da, db)
        node8 = NODE8 if os.path.isfile(NODE8) else None
        s, p = rt.verify_kit(a, rt.BRIDGE_ID, node8)
        self.assertEqual(list(p), [])
        self.assertEqual(s['files'], ['NOTICE', 'bridge.js'])
        self.assertEqual(s['units'], ['xop-camera-bridge.service'])
        with tarfile.open(a, 'r:gz') as t:
            names = t.getnames()
            self.assertEqual(names, sorted(names))
            self.assertTrue(all(m.uid == 0 and m.gid == 0 and m.isfile() for m in t.getmembers()))
            c = json.loads(t.extractfile('component.json').read())
        self.assertNotIn('requires', c)     # catalog fields stay in the catalog
        self.assertNotIn('catalog', c)
        self.assertEqual(c['recmgr'], ['xop-camera-bridge'])
        self.assertEqual(c['restart'], ['xop-camera-bridge.service'])

    @unittest.skipUnless(os.path.isfile(NODE8), 'Node 8.16.2 not installed for the syntax check')
    def test_node8_rejects_newer_syntax(self):
        js = synthetic_bridge_js() + b'try { f0(1); } catch { }\nvar o = null; var q = o?.x;\n'
        p, s = rt.check_bridge_js(js, NODE8)
        self.assertTrue(any('does not parse on v8.' in x for x in p), p)
        self.assertEqual(s['node8Check'], 'failed')

    def test_bridge_js_rejects_npm_requires_and_private_paths(self):
        p, _s = rt.check_bridge_js(synthetic_bridge_js() + b'var r = require("react");\n// /Users/someone/x\n')
        self.assertTrue(any("requires 'react'" in x for x in p), p)
        self.assertTrue(any('build-machine path' in x for x in p), p)

    def tamper(self, src, edit):
        out = os.path.join(self.tmp, 'tampered', os.path.basename(src))
        members = read_members(src)
        write_tgz(write(out, b'x') and out, edit(members))
        return out

    def test_kit_tampering_rejected(self):
        src, _d = self.bridge_kit()

        def payload(members):
            out = []
            for m, d in members:
                if m.name == 'files/bridge.js':
                    d = d + b'\n// changed\n'
                    m.size = len(d)
                out.append((m, d))
            return out + [file_member('files/libmfxhw64.so', b'\x7fELF stub'), file_member('extra.txt', b'x')]
        _s, p = rt.verify_kit(self.tamper(src, payload), rt.BRIDGE_ID)
        text = '\n'.join(p)
        self.assertIn('sha256 mismatch for bridge.js', text)
        self.assertIn('unexpected entry extra.txt', text)
        self.assertIn('files/libmfxhw64.so is not listed', text)

    def test_unit_policy(self):
        good = open(os.path.join(rt.PACKAGING, rt.BRIDGE_ID, 'xop-camera-bridge.service'), encoding='utf-8').read()
        self.assertEqual(list(rt.check_unit(good)), [])
        bad = good.replace('[Service]', '[Service]\nDynamicUser=yes').replace('Restart=always', 'Restart=no')
        bad = bad.replace('/usr/bin/node /var/opt/xop-camera-bridge/current/bridge.js', '/usr/bin/node /tmp/bridge.js')
        text = '\n'.join(rt.check_unit(bad))
        for want in ('DynamicUser', 'Restart', 'ExecStart'):
            self.assertIn(want, text)

    def test_empty_or_missing_input_is_an_error(self):
        empty = write(os.path.join(self.tmp, 'empty.js'), b'')
        with self.assertRaises(rt.PackError):
            rt.read_input(empty)
        m = rt.load_manifest(rt.BRIDGE_ID)
        with self.assertRaises(rt.PackError):
            rt.build_kit(m, overrides={'bridge.js': empty})
        with self.assertRaises(rt.PackError):
            rt.build_kit(rt.load_manifest(rt.CAMRX_ID))   # NOTICE is generated by assemble only

    def test_conflict_copies(self):
        own = lambda n: rt.managed(n)  # noqa: E731
        self.assertEqual(rt.conflict_copy_of('catalog 2.json', own), 'catalog.json')
        self.assertEqual(rt.conflict_copy_of('SHA256SUMS 2', own), 'SHA256SUMS')
        self.assertEqual(rt.conflict_copy_of('xop-camrx@0.1.2 3.tgz', own), 'xop-camrx@0.1.2.tgz')
        self.assertIsNone(rt.conflict_copy_of('notes 2.txt', own))
        self.assertTrue(rt.managed('xop-camrx-0.1.2-source.tar.gz') and rt.managed('xdrive_offroad_pro@0.1.2.tgz'))
        self.assertFalse(rt.managed('xop-camrx@0.1.2.tgz.bak'))


class HelperElf(unittest.TestCase):
    def setUp(self):
        self.data, self.origin = helper_elf()
        if self.data is None:
            self.skipTest(self.origin)

    def test_policy_passes(self):
        p, s = rt.check_elf(self.data)
        self.assertEqual(list(p), [], self.origin)
        self.assertEqual(s['interp'], '/lib/ld-linux-x86-64.so.2')
        self.assertTrue(set(s['needed']) <= rt.ELF_NEEDED_ALLOWED)
        self.assertFalse([n for n in s['exports'] if rt.ELF_EXPORT_FORBIDDEN.match(n)])

    def test_policy_failures(self):
        cases = {
            'interpreter': set_interp(self.data, '/lib64/ld-linux-x86-64.so.2'),
            'build-machine path': self.data + b'/Users/someone/build',
            'not an ELF': b'\xcf\xfa\xed\xfe' + self.data[4:],
            'expected 64 KiB': self.data[:4096],
        }
        for want, data in cases.items():
            p, _s = rt.check_elf(data)
            self.assertTrue(any(want in x for x in p), (want, p))


def mini_project(root):
    """A copy of only what the helper's packaging reads: native/camrx (without build output), native/packaging/xop-camrx,
    native/scripts/release_tools.py."""
    ign = shutil.ignore_patterns('build', '__pycache__', '*.pyc')
    shutil.copytree(os.path.join(PROJECT, 'native', 'camrx'), os.path.join(root, 'native', 'camrx'), ignore=ign)
    shutil.copytree(os.path.join(rt.PACKAGING, 'xop-camrx'), os.path.join(root, 'native', 'packaging', 'xop-camrx'))
    os.makedirs(os.path.join(root, 'native', 'scripts'))
    shutil.copy(os.path.join(HERE, '..', 'scripts', 'release_tools.py'), os.path.join(root, 'native', 'scripts'))
    return root


class SourceArchive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_corresponding_source_is_complete_and_reproducible(self):
        n1, b1, p1 = rt.build_source_archive('0.1.2', 'a' * 64)
        n2, b2, _p2 = rt.build_source_archive('0.1.2', 'a' * 64)
        self.assertEqual(list(p1), [])
        self.assertEqual((n1, b1), (n2, b2))
        path = write(os.path.join(self.tmp, n1), b1)
        self.assertEqual(list(rt.verify_source_archive(path, '0.1.2', 'a' * 64)), [])
        with tarfile.open(path, 'r:gz') as t:
            names = t.getnames()
            prov = t.extractfile('xop-camrx-0.1.2/PROVENANCE.txt').read().decode()
        self.assertFalse([n for n in names if '/build/' in n or n.endswith(('.so', '.o'))])
        self.assertIn('8b1e59606a5e2933aaf4100de2452d77243999e2', prov)
        self.assertIn('identical  waze-on-cluster/src/nal_reader.cpp', prov)
        self.assertIn('modified   waze-on-cluster/src/decoder_msdk.cpp', prov)

    def test_modified_upstream_file_needs_a_notice(self):
        root = mini_project(os.path.join(self.tmp, 'p'))
        f = os.path.join(root, 'native/camrx/third_party/idrive-apps/waze-on-cluster/src/nal_reader.cpp')
        with open(f, 'ab') as h:
            h.write(b'\n// local change without a notice\n')
        extra = write(os.path.join(root, 'native/camrx/third_party/idrive-apps/waze-on-cluster/src/new_file.cpp'), b'// new\n')
        _text, p = rt.provenance(root)
        joined = '\n'.join(p)
        self.assertIn('without a modification notice at its top: waze-on-cluster/src/nal_reader.cpp', joined)
        self.assertIn('without upstream record: waze-on-cluster/src/new_file.cpp', joined)
        self.assertTrue(os.path.isfile(extra))


class CatalogGraph(unittest.TestCase):
    def comps(self):
        return [{'id': 'app_x', 'version': '1.0.0', 'requires': {'mgu-render': '0.6.21', 'mgu-deploy': '0.8.19', rt.BRIDGE_ID: '0.1.2'}},
                {'id': rt.BRIDGE_ID, 'version': '0.1.2', 'requires': {'mgu-deploy': '0.8.19', rt.CAMRX_ID: '0.1.2'}},
                {'id': rt.CAMRX_ID, 'version': '0.1.2', 'requires': {'mgu-deploy': '0.8.19'}}]

    def problems(self, comps):
        p = rt.Problems()
        rt.check_catalog_graph(comps, p, 'app_x')
        return '\n'.join(p)

    def test_valid_chain(self):
        self.assertEqual(self.problems(self.comps()), '')

    def test_broken_chains(self):
        c = self.comps()
        c[0]['requires']['mgu-render'] = '0.6.20'
        self.assertIn('mgu-render', self.problems(c))
        c = self.comps()
        del c[1]['requires'][rt.CAMRX_ID]
        self.assertIn('does not require xop-camrx', self.problems(c))
        c = self.comps()
        c[2]['requires'][rt.BRIDGE_ID] = '0.1.2'
        self.assertIn('dependency cycle', self.problems(c))
        c = self.comps()
        c[0]['requires'][rt.BRIDGE_ID] = '0.1.1'
        self.assertIn('the catalog has', self.problems(c))
        c = self.comps()
        c[2]['requires']['iteriodev-turnview'] = '1.0.0'
        self.assertIn('neither in the catalog nor a known Store tool', self.problems(c))
        c = self.comps()
        del c[0]['requires'][rt.BRIDGE_ID]
        self.assertIn('the app does not require xop-camera-bridge', self.problems(c))


class CombinedRelease(unittest.TestCase):
    """assemble / install_release end to end: the synthetic app built by the real kit build.py, the bridge kit from a
    stand-in bundle, the helper (real build, else the ELF fixture), corresponding source, catalog and checksums."""

    @classmethod
    def setUpClass(cls):
        cls.elf, why = helper_elf()
        if cls.elf is None:
            raise unittest.SkipTest(why)
        cls.tmp = tempfile.mkdtemp()
        r = store_fixture.make_fixture(os.path.join(cls.tmp, 'app'), 'ru', 'store')
        if r['code'] != 0 or not r['tgz']:
            raise AssertionError('fixture app build failed: %s' % r['stderr'][-800:])
        cls.app_tgz = r['tgz']
        with open(r['spec'], encoding='utf-8') as f:
            cls.spec = json.load(f)
        cls.bridge_js = write(os.path.join(cls.tmp, 'in', 'bridge.js'), synthetic_bridge_js())
        cls.helper = write(os.path.join(cls.tmp, 'in', 'xop-camrx'), cls.elf)
        cls.node8 = NODE8 if os.path.isfile(NODE8) else None
        with open(os.path.join(rt.PACKAGING, rt.BRIDGE_ID, 'component.json'), encoding='utf-8') as f:
            cls.bridge_version = json.load(f)['version']
        with open(os.path.join(rt.PACKAGING, rt.CAMRX_ID, 'component.json'), encoding='utf-8') as f:
            cls.camrx_version = json.load(f)['version']

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def assemble(self, name, **kw):
        out = os.path.join(self.tmp, name)
        args = dict(repository='owner/repo', tag='v0.1.3', node8=self.node8, log=lambda m: None)
        args.update(kw)
        return out, rt.assemble(out, self.app_tgz, self.spec, self.bridge_js, self.helper, **args)

    def test_assemble_verifies_and_is_reproducible(self):
        a, s = self.assemble('a')
        b, _s = self.assemble('b')
        names = sorted(os.listdir(a))
        source_name = 'xop-camrx-%s-source.tar.gz' % self.camrx_version
        self.assertEqual(names, sorted(['SHA256SUMS', 'catalog.json', 'icon.png', 'mgu-store.json', 'store_fixture@1.2.3.tgz',
                                        'xop-camera-bridge@%s.tgz' % self.bridge_version,
                                        'xop-camrx@%s.tgz' % self.camrx_version, source_name]))
        for n in names:
            with open(os.path.join(a, n), 'rb') as fa, open(os.path.join(b, n), 'rb') as fb:
                self.assertEqual(fa.read(), fb.read(), n)
        with open(os.path.join(a, 'catalog.json'), encoding='utf-8') as f:
            cat = json.load(f)
        by = {c['id']: c for c in cat['components']}
        self.assertEqual(by['store_fixture']['requires'][rt.BRIDGE_ID], self.bridge_version)
        self.assertEqual(by['store_fixture']['requires']['mgu-render'], '0.6.21')
        self.assertEqual(by[rt.BRIDGE_ID]['requires'][rt.CAMRX_ID], self.camrx_version)
        for c in cat['components']:
            self.assertTrue(c['artifact']['url'].startswith('https://github.com/owner/repo/releases/download/v0.1.3/'))
            self.assertTrue(c['uninstallable'])
            self.assertNotIn('optional', c)
        self.assertEqual(s['source'], source_name)
        _s2, p = v.verify_release(a, self.spec, repository='owner/repo', tag='v0.1.3', node8=self.node8)
        self.assertEqual(list(p), [])
        _s3, p = v.verify_release(a, self.spec, repository='owner/repo', tag='catalog')
        self.assertTrue(any('artifact url' in x for x in p), p)

    def test_release_tampering_rejected(self):
        a, _s = self.assemble('t')
        with open(os.path.join(a, 'catalog.json'), encoding='utf-8') as f:
            cat = json.load(f)
        for c in cat['components']:
            if c['id'] == rt.BRIDGE_ID:
                c['requires'].pop(rt.CAMRX_ID)
                c['optional'] = True
        with open(os.path.join(a, 'catalog.json'), 'w', encoding='utf-8') as f:
            json.dump(cat, f)
        write(os.path.join(a, 'catalog 2.json'), b'{}')
        _s, p = v.verify_release(a, self.spec, repository='owner/repo', tag='v0.1.3')
        self.assertTrue(any('conflict copy of catalog.json' in x for x in p), p)
        os.remove(os.path.join(a, 'catalog 2.json'))
        _s, p = v.verify_release(a, self.spec, repository='owner/repo', tag='v0.1.3')
        text = '\n'.join(p)
        self.assertIn('does not require xop-camrx', text)
        self.assertIn('optional', text)
        self.assertIn('SHA256SUMS mismatch for catalog.json', text)

    def test_repository_needs_immutable_tag_and_empty_out(self):
        with self.assertRaises(rt.PackError):
            self.assemble('nt', tag=None)
        busy = write(os.path.join(self.tmp, 'busy', 'x'), b'x')
        with self.assertRaises(rt.PackError):
            rt.assemble(os.path.dirname(busy), self.app_tgz, self.spec, self.bridge_js, self.helper, log=lambda m: None)

    def test_install_release_quarantines_conflict_copies_and_refuses_foreign_files(self):
        rel = os.path.join(self.tmp, 'release')
        q = os.path.join(self.tmp, 'quarantine')
        write(os.path.join(rel, 'store_fixture@1.2.3.tgz'), b'old app-only archive')
        write(os.path.join(rel, 'catalog 2.json'), b'{"old": 1}')
        write(os.path.join(rel, 'notes.txt'), b'mine')
        with self.assertRaises(rt.PackError) as e:
            rt.install_release(rel, q, self.app_tgz, self.spec, self.bridge_js, self.helper, 'owner/repo', 'v0.1.3', self.node8, log=lambda m: None)
        self.assertIn('notes.txt', str(e.exception))
        with open(os.path.join(rel, 'store_fixture@1.2.3.tgz'), 'rb') as f:
            self.assertEqual(f.read(), b'old app-only archive')          # nothing changed
        os.remove(os.path.join(rel, 'notes.txt'))
        s, moved = rt.install_release(rel, q, self.app_tgz, self.spec, self.bridge_js, self.helper, 'owner/repo', 'v0.1.3',
                                      self.node8, stamp='T1', log=lambda m: None)
        self.assertEqual(moved, [os.path.join(q, 'T1', 'catalog 2.json')])
        with open(moved[0], 'rb') as f:
            self.assertEqual(f.read(), b'{"old": 1}')                     # kept, byte for byte
        self.assertNotIn('catalog 2.json', os.listdir(rel))
        self.assertEqual(s['tools'][rt.CAMRX_ID]['version'], self.camrx_version)
        _s, p = v.verify_release(rel, self.spec, repository='owner/repo', tag='v0.1.3')
        self.assertEqual(list(p), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
