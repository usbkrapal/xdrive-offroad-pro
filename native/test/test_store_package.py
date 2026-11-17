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

RELEASE = os.path.join(PROJECT, 'native', 'release')
SPEC_FILE = os.path.join(PROJECT, 'native', 'dist', 'xdrive_offroad_pro', 'app.json')


def release_tgz():
    names = [n for n in os.listdir(RELEASE) if n.endswith('.tgz')] if os.path.isdir(RELEASE) else []
    return os.path.join(RELEASE, names[0]) if len(names) == 1 else None


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
        cat = json.load(open(os.path.join(RELEASE, 'catalog.json'), encoding='utf-8'))
        repo = tag = None
        url = cat['components'][0]['artifact']['url']
        if url.startswith('https://github.com/'):
            repo = '/'.join(url.split('/')[3:5])
            tag = url.split('/')[7]
            self.assertEqual(cat['components'][0]['icon'], url.rsplit('/', 1)[0] + '/icon.png')
        _summary, problems = v.verify_release(RELEASE, self.spec, repository=repo, tag=tag)
        self.assertEqual(list(problems), [])
        d = os.path.join(self.tmp, 'rel')
        shutil.copytree(RELEASE, d)
        cat['components'][0]['artifact']['sha256'] = '0' * 64
        json.dump(cat, open(os.path.join(d, 'catalog.json'), 'w', encoding='utf-8'))
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
