#!/usr/bin/env python3
"""Tool kits, GPL source archive and the combined release (app + xop-camera-bridge + xop-camrx), standard library only.

    python3 -I native/scripts/release_tools.py kit <id> --out <dir> [--input <kit path>=<file> ...]
    python3 -I native/scripts/release_tools.py verify-kit <id@ver.tgz>
    python3 -I native/scripts/release_tools.py check-elf <binary>
    python3 -I native/scripts/release_tools.py assemble --out <new empty dir> --app-tgz <tgz> --spec <app.json>
        --bridge-js <bridge.js> --camrx <xop-camrx> [--repository o/r --tag t] [--node8 <node>]

Tool kit = the deploy tool's artifact (mgu-store deploy/README.md "Artifacts", deploy/hu buildArtifact at
d5e305242dc4e1ee3a1265ad48c6f0f19d12fcbf; this is an independent implementation of that documented format):
<id>@<version>.tgz holding component.json (id, kind, version, title, description, files[{path, mode, sha256}],
units[{name}], enable, recmgr, restart and the optional deploy fields), files/<path> and units/<name>; sorted,
regular files only, owner 0:0, one mtime. requires/uninstallable are catalog fields, not in the kit.

Every input is read whole and must be as long as the file system says (iCloud may hold files as placeholders);
an empty input is an error. Nothing is published.
"""
import argparse
import calendar
import gzip
import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import struct
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)  # python3 -I leaves the script's folder out; verify_store_package lives beside it
PROJECT = os.path.abspath(os.path.join(HERE, '..', '..'))
PACKAGING = os.path.join(PROJECT, 'native', 'packaging')
APP_ID = 'xdrive_offroad_pro'
BRIDGE_ID = 'xop-camera-bridge'
CAMRX_ID = 'xop-camrx'
TOOL_IDS = (BRIDGE_ID, CAMRX_ID)
SEMVER = re.compile(r'^\d+\.\d+\.\d+$')
TOOL_ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]*$')
RECMGR_NAME = re.compile(r'^[A-Za-z0-9:._+@-]+$')
MTIME = calendar.timegm((2026, 11, 18, 0, 0, 0))
# deploy-tool fields kept in the kit's component.json besides the required ones (deploy/hu buildArtifact)
OPTIONAL_KIT_FIELDS = ('mguHmi', 'mguProvides', 'keepRunning', 'crashNames', 'postInstall', 'check', 'activate', 'deactivate')
KIT_FIELDS = ('id', 'kind', 'version', 'title', 'description', 'files', 'units', 'enable', 'recmgr', 'restart') + OPTIONAL_KIT_FIELDS
# Store components outside this release that the catalog may require, with the lowest acceptable version
EXTERNAL_MIN = {'mgu-render': '0.6.21', 'mgu-deploy': '0.8.19'}
# the official nodejs.org v8.16.2 darwin-x64 build (sha256 checked against its SHASUMS256.txt), outside iCloud
NODE8_DEFAULT = os.path.join('/private/tmp', 'xop-toolchains', 'node-v8.16.2', 'node-v8.16.2-darwin-x64', 'bin', 'node')
NODE_BUILTINS = {'child_process', 'fs', 'net', 'path', 'os', 'crypto', 'events', 'util', 'buffer', 'stream', 'string_decoder', 'readline', 'timers'}
# private build-machine paths must not reach anything shipped
PRIVATE_MARKERS = (b'/Users/', b'/private/', b'/home/', b'/var/folders/', b'zig-cache', b'.zig-cache', b'/tmp/xop-toolchains')
PRIVATE_PATH_RE = re.compile(rb'/Users/[A-Za-z0-9][\w.-]*/|/home/[a-z][\w.-]*/|/private/(?:tmp|var)/[\w.-]+/|/var/folders/\w')

# ELF policy for xop-camrx: the head unit's loader (no /lib64 there), glibc 2.27, the libraries it has.
ELF_INTERP = '/lib/ld-linux-x86-64.so.2'
ELF_GLIBC_MAX = (2, 27)
ELF_NEEDED_ALLOWED = {'libmfxhw64.so', 'libva.so.1', 'libva-drm.so.1', 'libias-media_transport-avb_ufipc_bridge.so.1',
                      'libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'ld-linux-x86-64.so.2'}
ELF_NEEDED_REQUIRED = {'libmfxhw64.so', 'libias-media_transport-avb_ufipc_bridge.so.1', 'libc.so.6'}
# imports that only the real target build has (the host build replaces AVB and MSDK)
ELF_IMPORTS_REQUIRED = {'ias_avbbridge_create_receiver', 'MFXInit'}
# exported (defined) C++ runtime symbols would interpose on the unit's libstdc++ users (libmfxhw64, the AVB bridge)
ELF_EXPORT_FORBIDDEN = re.compile(r'^(_Z|__cxa_|__gxx_|_Unwind_|__dynamic_cast)')
ELF_MAX = 16 << 20


class PackError(Exception):
    pass


class Problems(list):
    def check(self, ok, msg):
        if not ok:
            self.append(msg)
        return ok


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def git_blob_id(b):
    return hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()


def semver(v):
    return tuple(int(n) for n in v.split('.')) if isinstance(v, str) and SEMVER.match(v) else None


def safe_rel(p):
    return (isinstance(p, str) and p != '' and not p.startswith('/') and '\\' not in p and '\0' not in p
            and '..' not in p.split('/') and posixpath.normpath(p) == p)


def read_input(path, what=None):
    """The whole file; it must be a non-empty regular file whose bytes are all there (no iCloud placeholder left)."""
    what = what or path
    if not os.path.isfile(path) or os.path.islink(path):
        raise PackError('%s: missing or not a regular file (%s)' % (what, path))
    size = os.stat(path).st_size
    with open(path, 'rb') as f:
        data = f.read()
    if size == 0 or not data:
        raise PackError('%s: empty file (%s)' % (what, path))
    if len(data) != size:
        raise PackError('%s: read %d of %d bytes (not materialized? %s)' % (what, len(data), size, path))
    return data


# ---------------------------------------------------------------- tar

def tgz(entries, mtime=MTIME):
    """gzip'd ustar of [(name, bytes, mode)], sorted by name, owner 0:0, one mtime; same input, same bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as t:
        for name, data, mode in sorted(entries, key=lambda e: e[0]):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.mtime = mtime
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.type = tarfile.REGTYPE
            t.addfile(info, io.BytesIO(data))
    return gzip.compress(buf.getvalue(), compresslevel=9, mtime=0)


def read_tgz(path, problems, limit=64 << 20):
    """{name: (bytes, TarInfo)}; links, special files, unsafe names and duplicates are problems."""
    out = {}
    try:
        tf = tarfile.open(path, 'r:gz')
    except (tarfile.TarError, OSError) as e:
        problems.append('%s: not a gzip tar: %s' % (os.path.basename(path), e))
        return out
    total = 0
    with tf:
        for m in tf:
            n = m.name
            if not problems.check(safe_rel(n.rstrip('/')), 'unsafe path in %s: %r' % (os.path.basename(path), n)):
                continue
            if m.isdir():
                continue
            if not problems.check(m.isfile(), 'link or special file in %s: %s' % (os.path.basename(path), n)):
                continue
            problems.check(n not in out, 'duplicate entry in %s: %s' % (os.path.basename(path), n))
            problems.check(not (m.mode & 0o7000), 'setuid/setgid/sticky mode on %s' % n)
            total += m.size
            if not problems.check(total <= limit, '%s expands past %d MiB' % (os.path.basename(path), limit >> 20)):
                break
            out[n] = (tf.extractfile(m).read(), m)
    return out


# ---------------------------------------------------------------- ELF (x86-64, little endian)

class Elf:
    def __init__(self, data):
        if data[:4] != b'\x7fELF':
            raise ValueError('not an ELF file')
        if data[4] != 2 or data[5] != 1:
            raise ValueError('not a little-endian ELF64')
        self.d = data
        (self.type, self.machine, _v, _entry, self.phoff, self.shoff, _flags, _ehs, self.phentsize, self.phnum,
         self.shentsize, self.shnum, self.shstrndx) = struct.unpack_from('<HHIQQQIHHHHHH', data, 16)
        self.ph = [struct.unpack_from('<IIQQQQQQ', data, self.phoff + i * self.phentsize) for i in range(self.phnum)]
        self.sh = [struct.unpack_from('<IIQQQQIIQQ', data, self.shoff + i * self.shentsize) for i in range(self.shnum)] if self.shoff else []

    def cstr(self, off):
        return self.d[off:self.d.index(b'\0', off)].decode('latin-1')

    def sections(self, kind):
        return [s for s in self.sh if s[1] == kind]

    def interp(self):
        for p in self.ph:
            if p[0] == 3:
                return self.d[p[2]:p[2] + p[5]].rstrip(b'\0').decode('latin-1')
        return None

    def gnu_stack_flags(self):
        for p in self.ph:
            if p[0] == 0x6474e551:
                return p[1]
        return None

    def dynamic(self):
        """[(tag, value or string)] from the SHT_DYNAMIC section; string tags resolved through its linked string table."""
        out = []
        for s in self.sections(6):
            strtab = self.sh[s[6]]
            for i in range(s[5] // 16):
                tag, val = struct.unpack_from('<qQ', self.d, s[4] + i * 16)
                if tag == 0:
                    break
                out.append((tag, self.cstr(strtab[4] + val) if tag in (1, 14, 15, 29) else val))
        return out

    def dynsym(self):
        """[(name, defined, binding, version name or None)]."""
        out = []
        ds = self.sections(11)
        if not ds:
            return out
        s = ds[0]
        strtab = self.sh[s[6]]
        versym = self.sections(0x6fffffff)
        names = {}
        for v in self.sections(0x6ffffffe):
            vstr = self.sh[v[6]]
            off = v[4]
            for _ in range(v[7]):
                _ver, cnt, _file, aux, nxt = struct.unpack_from('<HHIII', self.d, off)
                a = off + aux
                for _ in range(cnt):
                    _h, _f, other, name, anext = struct.unpack_from('<IHHII', self.d, a)
                    names[other] = self.cstr(vstr[4] + name)
                    if not anext:
                        break
                    a += anext
                if not nxt:
                    break
                off += nxt
        for i in range(1, s[5] // 24):
            name, info, _other, shndx, _value, _size = struct.unpack_from('<IBBHQQ', self.d, s[4] + i * 24)
            nm = self.cstr(strtab[4] + name)
            if not nm:
                continue
            ver = None
            if versym:
                vi = struct.unpack_from('<H', self.d, versym[0][4] + i * 2)[0] & 0x7fff
                ver = names.get(vi)
            out.append((nm, shndx != 0, info >> 4, ver))
        return out

    def versions_needed(self):
        out = []
        for v in self.sections(0x6ffffffe):
            vstr = self.sh[v[6]]
            off = v[4]
            for _ in range(v[7]):
                _ver, cnt, file_, aux, nxt = struct.unpack_from('<HHIII', self.d, off)
                lib = self.cstr(vstr[4] + file_)
                a = off + aux
                for _ in range(cnt):
                    _h, _f, _o, name, anext = struct.unpack_from('<IHHII', self.d, a)
                    out.append((lib, self.cstr(vstr[4] + name)))
                    if not anext:
                        break
                    a += anext
                if not nxt:
                    break
                off += nxt
        return out


def check_elf(data):
    """(problems, summary) for the xop-camrx binary against the head-unit policy above."""
    p = Problems()
    summary = {}
    p.check(64 << 10 <= len(data) <= ELF_MAX, 'xop-camrx is %d bytes (expected 64 KiB .. 16 MiB)' % len(data))
    try:
        e = Elf(data)
    except (ValueError, struct.error, IndexError) as ex:
        p.append('xop-camrx: %s (a host or Mach-O build is not the head-unit binary)' % ex)
        return p, summary
    try:
        p.check(e.machine == 62, 'xop-camrx: machine %d is not x86-64' % e.machine)
        p.check(e.type in (2, 3), 'xop-camrx: ELF type %d is not an executable' % e.type)
        interp = e.interp()
        p.check(interp == ELF_INTERP, 'xop-camrx: interpreter %r, expected %s' % (interp, ELF_INTERP))
        stack = e.gnu_stack_flags()
        p.check(stack is not None and not (stack & 1), 'xop-camrx: stack is executable or PT_GNU_STACK missing')
        p.check(not e.sections(2), 'xop-camrx: not stripped (has a .symtab)')
        dyn = e.dynamic()
        p.check(bool(dyn), 'xop-camrx: no dynamic section')
        needed = [v for t, v in dyn if t == 1]
        for n in needed:
            p.check(n in ELF_NEEDED_ALLOWED, 'xop-camrx: NEEDED %s is not one of the unit libraries' % n)
        for n in sorted(ELF_NEEDED_REQUIRED - set(needed)):
            p.append('xop-camrx: does not need %s (not the target build?)' % n)
        p.check(not any(t in (15, 29) for t, _ in dyn), 'xop-camrx: has DT_RPATH/DT_RUNPATH')
        p.check(not any(t == 22 for t, _ in dyn) and not any(t == 30 and (v & 4) for t, v in dyn), 'xop-camrx: has text relocations')
        newest = None
        for lib, ver in e.versions_needed():
            if ver.startswith(('GLIBCXX_', 'CXXABI_', 'GCC_')):
                p.append('xop-camrx: needs %s from %s (no libstdc++/libgcc_s on purpose)' % (ver, lib))
            m = re.match(r'^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$', ver)
            if m:
                v = (int(m.group(1)), int(m.group(2)))
                newest = max(newest or v, v)
                p.check(v <= ELF_GLIBC_MAX, 'xop-camrx: %s needs %s (unit: glibc %d.%d)' % (lib, ver, *ELF_GLIBC_MAX))
        syms = e.dynsym()
        imports = {n for n, d, _b, _v in syms if not d}
        for n in sorted(ELF_IMPORTS_REQUIRED - imports):
            p.append('xop-camrx: does not import %s (host/stand-in build?)' % n)
        bad_exports = sorted(n for n, d, b, _v in syms if d and b in (1, 2) and ELF_EXPORT_FORBIDDEN.match(n))
        p.check(not bad_exports, 'xop-camrx: exports C++ runtime symbols %s' % ', '.join(bad_exports[:8]))
        for m in PRIVATE_MARKERS:
            p.check(m not in data, 'xop-camrx: contains the build-machine path marker %r' % m.decode())
        p.check(b'fake_msdk' not in data and b'XOP_NO_AVB' not in data, 'xop-camrx: contains host stand-in code markers')
        summary = {'interp': interp, 'needed': needed, 'newestGlibc': '%d.%d' % newest if newest else None,
                   'imports': len(imports), 'exports': sorted(n for n, d, b, _v in syms if d and b in (1, 2))}
    except (ValueError, struct.error, IndexError) as ex:
        p.append('xop-camrx: malformed ELF: %s' % ex)
    return p, summary


# ---------------------------------------------------------------- bridge.js

def check_bridge_js(data, node8=None):
    """(problems, summary): a CommonJS bundle for Node 8 that only requires Node built-ins and names the helper path."""
    p = Problems()
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        p.append('bridge.js is not UTF-8')
        return p, {}
    p.check(len(text) > 2000, 'bridge.js is too small to be the bundle')
    reqs = sorted(set(re.findall(r'''\brequire\(\s*["']([^"']+)["']\s*\)''', text)))
    for r in reqs:
        p.check(r in NODE_BUILTINS, 'bridge.js requires %r (only Node built-ins are on the unit)' % r)
    for m in PRIVATE_MARKERS:
        p.check(m.decode() not in text, 'bridge.js contains the build-machine path marker %r' % m.decode())
    # the paths are template literals in the source ("/run/".concat(BRIDGE_ID)): look for their parts
    p.check('"/var/opt/%s"' % CAMRX_ID in text or '/var/opt/%s/' % CAMRX_ID in text, 'bridge.js does not name the helper root /var/opt/xop-camrx')
    p.check('"%s"' % BRIDGE_ID in text and '"/run/' in text, 'bridge.js does not name its runtime directory /run/xop-camera-bridge')
    p.check(not re.search(r'\bimport\s*\(|^\s*import\s|^\s*export\s', text, re.M), 'bridge.js has ES module syntax')
    node8_result = 'skipped'
    if node8:
        if not os.path.isfile(node8):
            p.append('Node 8 for the syntax check not found: %s' % node8)
            node8_result = 'missing'
        else:
            ver = subprocess.run([node8, '--version'], capture_output=True, text=True)
            ok_ver = ver.returncode == 0 and ver.stdout.strip().startswith('v8.')
            p.check(ok_ver, '%s is not Node 8 (%s)' % (node8, ver.stdout.strip() or ver.stderr.strip()))
            tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.bridge-check-%d.js' % os.getpid())
            try:
                with open(tmp, 'wb') as f:
                    f.write(data)
                r = subprocess.run([node8, '--check', tmp], capture_output=True, text=True)
            finally:
                os.unlink(tmp)
            p.check(r.returncode == 0, 'bridge.js does not parse on %s: %s' % (ver.stdout.strip(), (r.stderr or r.stdout).strip()[-400:]))
            node8_result = ver.stdout.strip() if ok_ver and r.returncode == 0 else 'failed'
    return p, {'requires': reqs, 'node8Check': node8_result}


# ---------------------------------------------------------------- manifests and kits

def load_manifest(tool_id, packaging=PACKAGING):
    path = os.path.join(packaging, tool_id, 'component.json')
    m = json.loads(read_input(path).decode('utf-8'))
    if m.get('id') != tool_id or m.get('kind') != 'tool' or not semver(m.get('version')) or not TOOL_ID_RE.match(tool_id):
        raise PackError('%s: needs id %s, kind "tool" and an x.y.z version' % (path, tool_id))
    for f in m.get('files') or []:
        if not safe_rel(f.get('path')) or not re.match(r'^[0-7]{3,4}$', f.get('mode') or ''):
            raise PackError('%s: bad files[] entry %r' % (path, f))
    for u in m.get('units') or []:
        if not safe_rel(u.get('name')) or '/' in u['name'] or u.get('runsInSafeMode') not in (None, True):
            raise PackError('%s: bad unit %r' % (path, u))
    for n in m.get('recmgr') or []:
        if not RECMGR_NAME.match(n):
            raise PackError('%s: bad recmgr name %r' % (path, n))
    return m


def kit_manifest(m, file_bytes):
    """The kit's component.json (deploy fields only) for the source manifest m and {kit path: bytes}."""
    out = {
        'id': m['id'], 'kind': 'tool', 'version': m['version'], 'title': m.get('title') or m['id'],
        'description': m.get('description') or '',
        'files': [{'path': f['path'], 'mode': f['mode'], 'sha256': sha256(file_bytes[f['path']])} for f in m['files']],
        'units': [dict({'name': u['name']}, **({'runsInSafeMode': True} if u.get('runsInSafeMode') is True else {})) for u in m.get('units') or []],
        'enable': m.get('enable') or [], 'recmgr': m.get('recmgr') or [], 'restart': m.get('restart') or [],
    }
    for k in OPTIONAL_KIT_FIELDS:
        if k in m:
            out[k] = m[k]
    return out


def build_kit(m, project=PROJECT, generated=None, overrides=None):
    """(file name, tgz bytes, kit component.json) from the source manifest; inputs read whole and checked non-empty."""
    generated = generated or {}
    overrides = overrides or {}
    files = {}
    entries = []
    for f in m['files']:
        src = f.get('from') or f['path']
        if f['path'] in overrides:
            data = read_input(overrides[f['path']], '%s files/%s' % (m['id'], f['path']))
        elif src.startswith('@generated/'):
            if src[len('@generated/'):] not in generated:
                raise PackError('%s: generated file %s was not supplied' % (m['id'], src))
            data = generated[src[len('@generated/'):]]
        else:
            data = read_input(os.path.join(project, src), '%s files/%s' % (m['id'], f['path']))
        files[f['path']] = data
        entries.append(('files/' + f['path'], data, int(f['mode'], 8)))
    for u in m.get('units') or []:
        data = read_input(os.path.join(project, u.get('from') or u['name']), '%s units/%s' % (m['id'], u['name']))
        entries.append(('units/' + u['name'], data, 0o644))
    km = kit_manifest(m, files)
    entries.append(('component.json', (json.dumps(km, indent=2, ensure_ascii=False) + '\n').encode('utf-8'), 0o644))
    return '%s@%s.tgz' % (m['id'], m['version']), tgz(entries), km


def verify_kit(path, tool_id=None, node8=None):
    """(summary or None, problems) for a tool kit: deploy-tool validity, payload hashes, and what each of ours must hold."""
    p = Problems()
    name = os.path.basename(path)
    if not p.check(os.path.isfile(path), 'kit not found: %s' % path):
        return None, p
    members = read_tgz(path, p)
    for n, (_d, info) in members.items():
        p.check(info.uid == 0 and info.gid == 0, '%s: %s is not owned by 0:0' % (name, n))
        p.check(n == 'component.json' or n.startswith(('files/', 'units/')), '%s: unexpected entry %s' % (name, n))
    if 'component.json' not in members:
        p.append('%s: no component.json' % name)
        return None, p
    try:
        c = json.loads(members['component.json'][0].decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        p.append('%s: component.json does not parse: %s' % (name, e))
        return None, p
    cid, ver = c.get('id'), c.get('version')
    p.check(TOOL_ID_RE.match(cid or '') is not None and c.get('kind') == 'tool', '%s: id/kind %r %r' % (name, cid, c.get('kind')))
    p.check(semver(ver) is not None, '%s: version %r is not x.y.z' % (name, ver))
    p.check(name == '%s@%s.tgz' % (cid, ver), '%s: file name is not <id>@<version>.tgz' % name)
    if tool_id:
        p.check(cid == tool_id, '%s: id %r, expected %s' % (name, cid, tool_id))
    p.check(set(c) <= set(KIT_FIELDS), '%s: component.json has fields the deploy tool does not read: %s' % (name, sorted(set(c) - set(KIT_FIELDS))))
    p.check(c.get('mguHmi') == ['ID7'], '%s: mguHmi %r' % (name, c.get('mguHmi')))
    p.check('mguProvides' not in c and 'keepRunning' not in c, '%s: mguProvides/keepRunning set' % name)
    listed = set()
    payload = {}
    for f in c.get('files') or []:
        fp = f.get('path')
        if not p.check(safe_rel(fp) and re.match(r'^[0-7]{3,4}$', f.get('mode') or ''), '%s: bad files[] entry %r' % (name, f)):
            continue
        listed.add('files/' + fp)
        got = members.get('files/' + fp)
        if not p.check(got is not None, '%s: payload files/%s missing' % (name, fp)):
            continue
        payload[fp] = got[0]
        p.check(sha256(got[0]) == f.get('sha256'), '%s: sha256 mismatch for %s' % (name, fp))
        p.check(got[1].mode == int(f['mode'], 8), '%s: tar mode of %s differs from component.json' % (name, fp))
        p.check(len(got[0]) > 0, '%s: %s is empty' % (name, fp))
        p.check(not fp.endswith(('.so', '.dylib', '.o', '.a')) and '.so.' not in posixpath.basename(fp), '%s: link-only library or object %s' % (name, fp))
    units = [u.get('name') for u in c.get('units') or []]
    for u in units:
        listed.add('units/' + str(u))
        p.check(('units/%s' % u) in members, '%s: unit %s missing' % (name, u))
    for n in members:
        p.check(n == 'component.json' or n in listed, '%s: %s is not listed in component.json' % (name, n))
    for k in ('recmgr', 'restart'):
        for n in c.get(k) or []:
            p.check(isinstance(n, str) and RECMGR_NAME.match(n) is not None and 'oapcontroller' not in n, '%s: bad %s entry %r' % (name, k, n))
    summary = {'file': name, 'size': os.path.getsize(path), 'sha256': sha256(open(path, 'rb').read()), 'id': cid,
               'version': ver, 'title': c.get('title'), 'description': c.get('description'),
               'files': sorted(payload), 'units': units}
    if cid == BRIDGE_ID:
        p.check(sorted(payload) == ['NOTICE', 'bridge.js'], '%s: files %r, expected bridge.js and NOTICE' % (name, sorted(payload)))
        unit_name = BRIDGE_ID + '.service'
        p.check(units == [unit_name], '%s: units %r' % (name, units))
        p.check({'unit': unit_name, 'target': 'multi-user.target'} in (c.get('enable') or []), '%s: service not enabled for multi-user.target' % name)
        p.check(BRIDGE_ID in (c.get('recmgr') or []), '%s: recmgr does not list %s' % (name, BRIDGE_ID))
        p.check(c.get('restart') == [unit_name], '%s: restart %r' % (name, c.get('restart')))
        if 'units/' + unit_name in members:
            p.extend(check_unit(members['units/' + unit_name][0].decode('utf-8', 'replace')))
        if 'bridge.js' in payload:
            bp, bs = check_bridge_js(payload['bridge.js'], node8)
            p.extend(bp)
            summary.update(bs)
        if 'NOTICE' in payload:
            p.check(b'xop-camrx' in payload['NOTICE'] and b'GPL' in payload['NOTICE'], '%s: NOTICE does not explain the separate GPL helper' % name)
    elif cid == CAMRX_ID:
        p.check(sorted(payload) == ['LICENSE', 'LICENSE.intel-mfx-headers', 'NOTICE', 'xop-camrx'], '%s: files %r' % (name, sorted(payload)))
        p.check(not units and not c.get('enable') and not c.get('restart'), '%s: the helper has no units of its own' % name)
        modes = {f.get('path'): f.get('mode') for f in c.get('files') or []}
        p.check(modes.get('xop-camrx') == '0755' and all(v == '0644' for k, v in modes.items() if k != 'xop-camrx'), '%s: modes %r' % (name, modes))
        if 'xop-camrx' in payload:
            ep, es = check_elf(payload['xop-camrx'])
            p.extend(ep)
            summary['elf'] = es
        lic = payload.get('LICENSE', b'')
        p.check(b'GNU GENERAL PUBLIC LICENSE' in lic and b'Version 3, 29 June 2007' in lic, '%s: LICENSE is not the GPL v3 text' % name)
        p.check(b'Permission is hereby granted, free of charge' in payload.get('LICENSE.intel-mfx-headers', b''), '%s: Intel MIT licence text missing' % name)
        notice = payload.get('NOTICE', b'').decode('utf-8', 'replace')
        m = re.search(r'release\s+asset\s+(\S+)\s+\(sha256\s+([0-9a-f]{64})\)', notice)
        p.check(m is not None and 'GNU General Public License' in notice, '%s: NOTICE does not name the corresponding source' % name)
        if m:
            summary['source'] = {'name': m.group(1), 'sha256': m.group(2)}
    else:
        p.append('%s: %s is not a component of this release' % (name, cid))
    return summary, p


def check_unit(text):
    """The bridge's systemd unit: our node script from the installed version, root, its runtime dir, restarted, stays up."""
    p = Problems()
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith('#')]
    kv = {}
    for l in lines:
        if '=' in l:
            k, v = l.split('=', 1)
            kv.setdefault(k, []).append(v)
    want = {
        'ExecStart': ['/usr/bin/node /var/opt/%s/current/bridge.js' % BRIDGE_ID],
        'RuntimeDirectory': [BRIDGE_ID],
        'Restart': ['always'],
        'KillMode': ['control-group'],
        'WantedBy': ['multi-user.target'],
    }
    for k, v in want.items():
        p.check(kv.get(k) == v, 'unit %s=%r, expected %r' % (k, kv.get(k), v))
    for k in ('DynamicUser', 'User', 'ExecStartPre', 'ExecStopPost', 'Type'):
        p.check(k not in kv, 'unit sets %s (the bridge runs as root, a simple service)' % k)
    p.check('[Install]' in lines and '[Service]' in lines, 'unit lacks [Service] or [Install]')
    p.check(not any('oapcontroller' in l for l in lines), 'unit refers to oapcontroller')
    return p


# ---------------------------------------------------------------- GPL source archive

SOURCE_DIRS = ('native/camrx/src', 'native/camrx/third_party', 'native/camrx/tools', 'native/camrx/test')
SOURCE_FILES = ('native/camrx/LICENSE', 'native/camrx/build.sh', 'native/packaging/xop-camrx/component.json',
                'native/packaging/xop-camrx/NOTICE.in', 'native/packaging/xop-camrx/SOURCE-README.md',
                'native/packaging/xop-camrx/upstream-idrive-apps.json', 'native/scripts/release_tools.py')
SOURCE_SKIP = re.compile(r'(^|/)(__pycache__|\.DS_Store|\._[^/]*|build)(/|$)|\.(pyc|o|a|so|dylib)$|( \d+)(\.[^./]*)?$')


def source_files(project=PROJECT):
    rels = list(SOURCE_FILES)
    for d in SOURCE_DIRS:
        top = os.path.join(project, d)
        if not os.path.isdir(top):
            raise PackError('source directory missing: %s' % d)
        for root, dirs, names in os.walk(top):
            dirs.sort()
            for n in sorted(names):
                rel = os.path.relpath(os.path.join(root, n), project).replace(os.sep, '/')
                if not SOURCE_SKIP.search(rel):
                    rels.append(rel)
    return sorted(set(rels))


def provenance(project=PROJECT):
    """(text, problems): every vendored idrive-apps file as identical to the recorded upstream blob or modified."""
    p = Problems()
    up = json.loads(read_input(os.path.join(project, 'native/packaging/xop-camrx/upstream-idrive-apps.json')).decode('utf-8'))
    base = os.path.join(project, 'native/camrx/third_party/idrive-apps')
    lines = ['xop-camrx: provenance of native/camrx/third_party/idrive-apps', '',
             'Upstream: %s at commit %s (paths under %s).' % (up['repository'], up['commit'], up['upstreamPrefix']),
             'Licence: %s.' % up['license'], '',
             'status     path (relative to native/camrx/third_party/idrive-apps)']
    present = set()
    for root, _dirs, names in os.walk(base):
        for n in names:
            rel = os.path.relpath(os.path.join(root, n), base).replace(os.sep, '/')
            if not SOURCE_SKIP.search(rel):
                present.add(rel)
    for rel in sorted(present | set(up['files'])):
        if rel not in present:
            lines.append('missing    %s' % rel)
            p.append('third_party file listed upstream but missing: %s' % rel)
            continue
        data = read_input(os.path.join(base, rel))
        if rel not in up['files']:
            lines.append('added      %s' % rel)
            p.append('third_party file without upstream record: %s' % rel)
            continue
        if git_blob_id(data) == up['files'][rel]:
            lines.append('identical  %s' % rel)
        else:
            lines.append('modified   %s' % rel)
            head = data[:600].decode('utf-8', 'replace')
            p.check('Modified' in head and 'xop-camrx' in head, 'modified upstream file without a modification notice at its top: %s' % rel)
    return '\n'.join(lines) + '\n', p


def build_source_archive(version, camrx_sha256, project=PROJECT):
    """(name, bytes, problems): xop-camrx-<version>-source.tar.gz under xop-camrx-<version>/."""
    prov, p = provenance(project)
    prefix = 'xop-camrx-%s' % version
    entries = []
    for rel in source_files(project):
        data = read_input(os.path.join(project, rel))
        # an actual private path (a user or temp segment after the prefix), not a pattern a checker looks for
        hit = PRIVATE_PATH_RE.search(data)
        if hit:
            p.append('source file %s contains the private path %r' % (rel, hit.group(0).decode('latin-1')))
        mode = 0o755 if rel.endswith(('.sh',)) else 0o644
        entries.append(('%s/%s' % (prefix, rel), data, mode))
    info = ['xop-camrx %s: build information' % version, '',
            'Toolchain: Zig 0.14.1 (zig c++ / zig cc), targets x86_64-linux-gnu.2.27 (unit) and x86_64-macos (host tests).',
            'Command:   sh native/camrx/build.sh target',
            'Output:    native/camrx/build/target/xop-camrx (installed as /var/opt/xop-camrx/versions/%s/xop-camrx)' % version,
            'sha256 of the shipped binary: %s' % camrx_sha256, '',
            'The link-only stub libraries build.sh generates under build/target/stub are not installed.', '']
    entries.append(('%s/PROVENANCE.txt' % prefix, prov.encode('utf-8'), 0o644))
    entries.append(('%s/BUILD-INFO.txt' % prefix, '\n'.join(info).encode('utf-8'), 0o644))
    names = [e[0] for e in entries]
    for need in ('native/camrx/LICENSE', 'native/camrx/build.sh', 'native/camrx/src/main.cpp', 'native/camrx/tools/elfabi.py'):
        p.check('%s/%s' % (prefix, need) in names, 'source archive lacks %s' % need)
    return '%s-source.tar.gz' % prefix, tgz(entries), p


def verify_source_archive(path, version, binary_sha=None):
    p = Problems()
    members = read_tgz(path, p, limit=64 << 20)
    prefix = 'xop-camrx-%s/' % version
    for n in members:
        p.check(n.startswith(prefix), 'source archive entry outside %s: %s' % (prefix, n))
        p.check('/build/' not in n and not n.endswith(('.so', '.o', '.a', '.dylib')), 'source archive holds build output: %s' % n)
    for need in ('native/camrx/LICENSE', 'native/camrx/build.sh', 'native/camrx/src/main.cpp', 'PROVENANCE.txt', 'BUILD-INFO.txt',
                 'native/packaging/xop-camrx/component.json', 'native/camrx/third_party/idrive-apps/waze-on-cluster/LICENSE'):
        p.check(prefix + need in members, 'source archive lacks %s' % need)
    prov = members.get(prefix + 'PROVENANCE.txt', (b'', None))[0].decode('utf-8', 'replace')
    p.check('Upstream: https://github.com/robertnisipeanu/idrive-apps at commit ' in prov, 'PROVENANCE.txt does not name the upstream commit')
    p.check('missing ' not in prov and 'added ' not in prov, 'PROVENANCE.txt lists missing or unrecorded files')
    if binary_sha:
        info = members.get(prefix + 'BUILD-INFO.txt', (b'', None))[0].decode('utf-8', 'replace')
        p.check(binary_sha in info, 'BUILD-INFO.txt does not name the shipped binary sha256')
    for n, (d, _i) in members.items():
        p.check(not d.startswith((b'\x7fELF', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe')), 'source archive holds a binary: %s' % n)
    return p


# ---------------------------------------------------------------- catalog

def artifact_url(name, repository=None, tag=None):
    return 'https://github.com/%s/releases/download/%s/%s' % (repository, tag, name) if repository else name


def catalog_entry(kind, summary, requires, repository, tag, title=None, description=None, extra=None):
    e = {'id': summary['id'], 'kind': kind, 'title': title or summary.get('title'), 'description': description or summary.get('description'),
         'version': summary['version'],
         'artifact': {'name': summary['file'], 'size': summary['size'], 'sha256': summary['sha256'],
                      'url': artifact_url(summary['file'], repository, tag)},
         'requires': dict(requires), 'uninstallable': True, 'mguHmi': ['ID7']}
    e.update(extra or {})
    return e


def check_catalog_graph(comps, p, app_id=APP_ID):
    """Dependency graph: every requires names a catalog component at its exact version or a known external tool at
    least at its minimum; app -> bridge -> camrx; no cycles."""
    by_id = {c.get('id'): c for c in comps}
    for c in comps:
        for dep, v in (c.get('requires') or {}).items():
            if dep in by_id:
                p.check(v == by_id[dep].get('version'), '%s requires %s %r, the catalog has %r' % (c.get('id'), dep, v, by_id[dep].get('version')))
            elif dep in EXTERNAL_MIN:
                p.check(semver(v) is not None and semver(v) >= semver(EXTERNAL_MIN[dep]), '%s requires %s %r, at least %s' % (c.get('id'), dep, v, EXTERNAL_MIN[dep]))
            else:
                p.append('%s requires %s, which is neither in the catalog nor a known Store tool' % (c.get('id'), dep))
    app = by_id.get(app_id) or {}
    bridge = by_id.get(BRIDGE_ID) or {}
    p.check(BRIDGE_ID in (app.get('requires') or {}), 'the app does not require %s' % BRIDGE_ID)
    p.check('mgu-render' in (app.get('requires') or {}), 'the app does not require mgu-render')
    p.check(CAMRX_ID in (bridge.get('requires') or {}), '%s does not require %s' % (BRIDGE_ID, CAMRX_ID))
    for c in comps:
        p.check(app_id not in (c.get('requires') or {}), '%s requires the app' % c.get('id'))
    state = {}

    def visit(n, stack):
        if state.get(n) == 1:
            p.append('dependency cycle: %s' % ' -> '.join(stack + [n]))
            return
        if state.get(n) == 2 or n not in by_id:
            return
        state[n] = 1
        for d in sorted((by_id[n].get('requires') or {})):
            visit(d, stack + [n])
        state[n] = 2
    for n in sorted(by_id):
        visit(n, [])


# ---------------------------------------------------------------- assemble

def notice_text(version, source_name, source_sha, kit_name, repository=None, tag=None):
    tpl = read_input(os.path.join(PACKAGING, CAMRX_ID, 'NOTICE.in')).decode('utf-8')
    where = (' (https://github.com/%s/releases/tag/%s)' % (repository, tag)) if repository else ''
    return tpl.format(version=version, source_name=source_name, source_sha256=source_sha, kit_name=kit_name, source_where=where).encode('utf-8')


def assemble(out, app_tgz, spec, bridge_js, camrx_bin, repository=None, tag=None, node8=NODE8_DEFAULT, project=PROJECT,
             packaging=PACKAGING, log=print):
    """Writes the combined release into the new empty folder out and verifies it; returns the summary.
    Raises PackError with every problem found."""
    import verify_store_package as vsp
    if repository and not tag:
        raise PackError('--repository needs --tag (the immutable release the artifacts are uploaded to, e.g. v0.1.2)')
    if os.path.exists(out) and os.listdir(out):
        raise PackError('%s is not empty' % out)
    os.makedirs(out, exist_ok=True)
    problems = Problems()
    app, app_problems, icon = vsp.verify_package(app_tgz, spec)
    if app_problems or not app:
        raise PackError('app package:\n  ' + '\n  '.join(app_problems))
    mb, mc = load_manifest(BRIDGE_ID, packaging), load_manifest(CAMRX_ID, packaging)
    camrx_bytes = read_input(camrx_bin, 'xop-camrx binary')
    ep, _es = check_elf(camrx_bytes)
    if ep:
        raise PackError('xop-camrx binary %s is not the head-unit build:\n  %s' % (camrx_bin, '\n  '.join(ep)))
    src_name, src_bytes, sp = build_source_archive(mc['version'], sha256(camrx_bytes), project)
    problems.extend(sp)
    kit_c = '%s@%s.tgz' % (CAMRX_ID, mc['version'])
    notice = notice_text(mc['version'], src_name, sha256(src_bytes), kit_c, repository, tag)
    name_c, bytes_c, _km = build_kit(mc, project, generated={'NOTICE': notice}, overrides={'xop-camrx': camrx_bin})
    name_b, bytes_b, _kb = build_kit(mb, project, overrides={'bridge.js': bridge_js})
    for n, b in ((name_c, bytes_c), (name_b, bytes_b), (src_name, src_bytes), (app['file'], read_input(app_tgz)), ('icon.png', icon)):
        with open(os.path.join(out, n), 'wb') as f:
            f.write(b)
    sb, pb = verify_kit(os.path.join(out, name_b), BRIDGE_ID, node8)
    sc, pc = verify_kit(os.path.join(out, name_c), CAMRX_ID)
    problems.extend(pb)
    problems.extend(pc)
    if problems:
        raise PackError('tool kits:\n  ' + '\n  '.join(problems))
    from_store = mb['catalog'].get('requires') or {}
    comps = [
        catalog_entry('app', app, dict(app['requires'], **{BRIDGE_ID: mb['version']}), repository, tag,
                      title=spec.get('title'), description=app.get('description'),
                      extra={'icon': artifact_url('icon.png', repository, tag), 'iconSha256': sha256(icon)}),
        catalog_entry('tool', sb, from_store, repository, tag),
        catalog_entry('tool', sc, mc['catalog'].get('requires') or {}, repository, tag),
    ]
    catalog = {'schema': 2, 'components': comps}
    store = {'apps': {spec['id']: {'title': spec.get('title'), 'description': app.get('description'), 'icon': 'icon.png', 'iconSha256': sha256(icon)}}}
    with open(os.path.join(out, 'catalog.json'), 'w', encoding='utf-8') as f:
        f.write(json.dumps(catalog, indent=2, ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'mgu-store.json'), 'w', encoding='utf-8') as f:
        f.write(json.dumps(store, indent=2, ensure_ascii=False) + '\n')
    names = sorted(n for n in os.listdir(out) if n != 'SHA256SUMS')
    with open(os.path.join(out, 'SHA256SUMS'), 'w', encoding='utf-8') as f:
        f.write(''.join('%s  %s\n' % (sha256(open(os.path.join(out, n), 'rb').read()), n) for n in names))
    summary, rp = vsp.verify_release(out, spec, repository=repository, tag=tag, node8=node8)
    if rp:
        raise PackError('release verification:\n  ' + '\n  '.join(rp))
    log('assembled %s: %s' % (out, ', '.join(sorted(os.listdir(out)))))
    return summary


# ---------------------------------------------------------------- release folder housekeeping

CONFLICT_COPY = re.compile(r'^(?P<base>.+?) (?P<n>\d+)(?P<ext>\.[^. ]+)?$')


def conflict_copy_of(name, managed):
    """The managed name a Finder/iCloud conflict copy ('catalog 2.json') duplicates, else None."""
    m = CONFLICT_COPY.match(name)
    if not m:
        return None
    base = m.group('base') + (m.group('ext') or '')
    return base if managed(base) else None


RELEASE_META = ('catalog.json', 'mgu-store.json', 'icon.png', 'SHA256SUMS')
def managed(name, app_id=APP_ID):
    """Files this tool writes into native/release (and replaces on the next run)."""
    pat = r'^((%s|%s|%s)@\d+\.\d+\.\d+\.tgz|xop-camrx-\d+\.\d+\.\d+-source\.tar\.gz)$' % (re.escape(app_id), BRIDGE_ID, CAMRX_ID)
    return name in RELEASE_META or re.match(pat, name) is not None


def install_release(release_dir, quarantine_root, app_tgz, spec, bridge_js, camrx_bin, repository=None, tag=None,
                    node8=NODE8_DEFAULT, project=PROJECT, packaging=PACKAGING, stamp=None, log=print):
    """Assembles and verifies the combined release beside release_dir, then puts it in place:
    - files this tool manages are replaced;
    - Finder/iCloud conflict copies of them ('catalog 2.json') are moved, untouched, to quarantine_root/<stamp>/;
    - any other file stops the run before anything changes.
    Returns (summary, [quarantined paths])."""
    import time
    import verify_store_package as vsp
    os.makedirs(release_dir, exist_ok=True)
    old, copies, foreign = [], [], []
    own = lambda n: managed(n, spec['id'])  # noqa: E731
    for n in sorted(os.listdir(release_dir)):
        if n == '.gitkeep':
            continue
        if own(n):
            old.append(n)
        elif conflict_copy_of(n, own):
            copies.append(n)
        else:
            foreign.append(n)
    if foreign:
        raise PackError('%s holds files this tool does not manage: %s; move them yourself, nothing was changed' % (release_dir, ', '.join(foreign)))
    tmp = release_dir.rstrip('/') + '.new-%d' % os.getpid()
    if os.path.exists(tmp):
        raise PackError('%s exists (an earlier run?); remove it' % tmp)
    try:
        assemble(tmp, app_tgz, spec, bridge_js, camrx_bin, repository, tag, node8, project, packaging, log)
        moved = []
        if copies:
            qdir = os.path.join(quarantine_root, stamp or time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
            os.makedirs(qdir, exist_ok=False)
            for n in copies:
                os.rename(os.path.join(release_dir, n), os.path.join(qdir, n))
                moved.append(os.path.join(qdir, n))
            log('quarantined %d conflict copies in %s: %s' % (len(copies), qdir, ', '.join(copies)))
        for n in old:
            os.remove(os.path.join(release_dir, n))
        for n in sorted(os.listdir(tmp)):
            os.rename(os.path.join(tmp, n), os.path.join(release_dir, n))
    finally:
        if os.path.isdir(tmp):
            shutil.rmtree(tmp)
    summary, p = vsp.verify_release(release_dir, spec, repository=repository, tag=tag, node8=node8)
    if p:
        raise PackError('%s after the move:\n  %s' % (release_dir, '\n  '.join(p)))
    return summary, moved


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    k = sub.add_parser('kit')
    k.add_argument('id', choices=TOOL_IDS)
    k.add_argument('--out', required=True)
    k.add_argument('--input', action='append', default=[], help='<kit path>=<file> instead of the manifest\'s "from"')
    vk = sub.add_parser('verify-kit')
    vk.add_argument('path')
    vk.add_argument('--node8', default=None)
    ce = sub.add_parser('check-elf')
    ce.add_argument('path')
    a_ = sub.add_parser('assemble')
    a_.add_argument('--out', required=True)
    a_.add_argument('--app-tgz', required=True)
    a_.add_argument('--spec', required=True)
    a_.add_argument('--bridge-js', required=True)
    a_.add_argument('--camrx', required=True)
    a_.add_argument('--repository')
    a_.add_argument('--tag')
    a_.add_argument('--node8', default=os.environ.get('XOP_NODE8', NODE8_DEFAULT))
    r_ = sub.add_parser('release', help='assemble, verify and put into --release-dir (conflict copies to --quarantine)')
    r_.add_argument('--release-dir', default=os.path.join(PROJECT, 'native', 'release'))
    r_.add_argument('--quarantine', default=os.path.join(PROJECT, 'native', 'release-quarantine'))
    r_.add_argument('--app-tgz', required=True)
    r_.add_argument('--spec', required=True)
    r_.add_argument('--bridge-js', default=os.path.join(PROJECT, 'native', 'build', BRIDGE_ID, 'bridge.js'))
    r_.add_argument('--camrx', default=os.path.join(PROJECT, 'native', 'camrx', 'build', 'target', CAMRX_ID))
    r_.add_argument('--repository')
    r_.add_argument('--tag')
    r_.add_argument('--node8', default=os.environ.get('XOP_NODE8', NODE8_DEFAULT))
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'kit':
            m = load_manifest(a.id)
            overrides = dict(x.split('=', 1) for x in a.input)
            if a.id == CAMRX_ID and 'NOTICE' not in overrides:
                raise PackError('xop-camrx NOTICE is generated by assemble (it names the source archive); pass --input NOTICE=<file> for a test kit')
            name, data, _km = build_kit(m, overrides=overrides)
            os.makedirs(a.out, exist_ok=True)
            with open(os.path.join(a.out, name), 'wb') as f:
                f.write(data)
            print(json.dumps({'file': os.path.join(a.out, name), 'size': len(data), 'sha256': sha256(data)}))
            return 0
        if a.cmd == 'verify-kit':
            s, p = verify_kit(a.path, node8=a.node8)
        elif a.cmd == 'check-elf':
            p, s = check_elf(read_input(a.path))
        elif a.cmd == 'release':
            if not os.path.isfile(a.camrx):
                raise PackError('xop-camrx binary not found: %s\n  build it with: sh native/camrx/build.sh target '
                                '(the x86-64 Linux build; a host or stub build is never packaged)' % a.camrx)
            s, moved = install_release(a.release_dir, a.quarantine, a.app_tgz, json.load(open(a.spec, encoding='utf-8')),
                                       a.bridge_js, a.camrx, a.repository, a.tag, a.node8,
                                       log=lambda m: print(m, file=sys.stderr))
            s = dict(s, quarantined=moved)
            p = []
        else:
            if a.tag and not a.repository:
                raise PackError('--tag needs --repository')
            s = assemble(a.out, a.app_tgz, json.load(open(a.spec, encoding='utf-8')), a.bridge_js, a.camrx,
                         a.repository, a.tag, a.node8, log=lambda m: print(m, file=sys.stderr))
            p = []
        if p:
            print('%s failed (%d problems):' % (a.cmd, len(p)), file=sys.stderr)
            for x in p:
                print('  - ' + x, file=sys.stderr)
            return 1
        print(json.dumps(s, ensure_ascii=False, indent=1))
        return 0
    except PackError as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
