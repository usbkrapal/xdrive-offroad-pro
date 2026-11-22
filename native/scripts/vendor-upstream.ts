// npm run native:vendor -- [--upstream <idrive7-apps checkout>]   (запись vendor/idrive7-apps + PROVENANCE.json)
// npm run native:vendor -- --check                                  (офлайн-проверка вендорного дерева по PROVENANCE.json)
//
// Вендорит курируемое MIT-подмножество idrive7-apps строго из объектов закреплённого коммита
// (git ls-tree / git cat-file), не из рабочего дерева checkout. Явный allowlist: рантайм kit,
// сборщик и то, что нужно для русской сборки. НЕ вендорятся: GPL kit/renderd, kit/emu, Doom,
// oap-sdk, скрипты развёртывания, бинарники, тесты, кэши. Локально изменённые файлы (MODIFIED)
// при повторном запуске не перезаписываются; их отличие от upstream фиксируется в PROVENANCE.json.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { ROOT } from './bundle';
import { DEFAULT_UPSTREAM } from './stage';

export const VENDOR_DIR = join(ROOT, 'vendor', 'idrive7-apps');
export const PROVENANCE_FILE = 'PROVENANCE.json';
export const UPSTREAM_REPOSITORY = 'https://github.com/cauliflowermossgrape/idrive7-apps';
export const UPSTREAM_COMMIT = '082d42d52cfaa654c1a9740e6736cbd9433c486d';

/** Отдельные файлы коммита. */
export const ALLOW_FILES = [
  'LICENSE',
  'kit/platform/permissions.json',
  'kit/localization/credit.ru.json',
  'kit/localization/fonts/cyrillic-ru.json',
  'kit/tools/build.py',
  'kit/tools/pack_data.py',
  'kit/tools/localize.py',
  'kit/tools/locale-revisions.json',
  'kit/tools/make_icon.js',
  'kit/tools/oapgen/gen.js',
] as const;

/** Каталоги коммита целиком (рантайм — полностью, чтобы не обрезать require-зависимости). */
export const ALLOW_DIRS = ['kit/runtime'] as const;

/** Исключения внутри ALLOW_DIRS: build.py сам удаляет Barlow из всех приложений, кроме redline. */
export const EXCLUDE = ['kit/runtime/fonts/gear_barlow.json', 'kit/runtime/fonts/OFL-Barlow.txt'] as const;

/** Локальные изменения (seed из upstream только при первом вендоринге). */
export const MODIFIED: Record<string, string> = {
  'kit/tools/build.py':
    'explicit --store-package mode (SDK-free npm-format .tgz only: no oap-sdk check/copy/folder, no .mgu, ' +
    'no fit to the build machine, x.y.z version required, mguHmi and minimum requires in package.json, ' +
    'deterministic tar entries); icon helper run without a shell',
  'kit/runtime/renderd.js':
    'pixel images on mgu-render/1 connections (PROTOCOL.md of mgu-render 0.6.21): IMAGE 10 with premultiplied RGBA ' +
    'up to 1024 a side, X_PIXMAP/X_PIXELS beyond that where offered, op 18 rewritten to x y w h r id in a copy of ' +
    'each frame and layer; X_READY pixmap capability read; an image that cannot be sent is logged and emitted; ' +
    'video (PROTOCOL.md "Video"): X_READY caps 16 as info.video, video(id, /dev/shm/mgu-video-<name>) / dropVideo(id) ' +
    'as VIDEO 13 / DROP_VIDEO 14 (at most 4, sent again after a reconnect or a resize), op 19 counted, and stripped ' +
    'from frames on an upstream-dialect connection',
  'kit/runtime/signals.js':
    'watch(): poll timer cleared on shutdown and no callbacks after it; at most one getValue() per field in flight ' +
    "(polls skipped while the binding's 3 s timeout has not settled it, never stacked); provider epoch: answers to reads " +
    'started before a loss and notifications while the provider is away are dropped; per-field fieldPollMs, ' +
    'onAvailability, res.losses, res.reads (getter counts/times/short error text, no values)',
  'kit/runtime/record.js':
    'makeLayer keeps the pixel images a layer draws (images), so transports upload them before the layer; ' +
    'Recorder.video(id, x, y, w, h, r) records op 19 only when the recorder allows it (videoOk), play() skips op 19',
  'kit/runtime/gauges.js':
    'page tab fonts and badges enlarged by 38 percent from the original in software and GPU headers, with matching text measurements',
  'kit/runtime/display.js':
    "the app's brand at the start of the full-screen header (display.brand: width(c), draw), always kept; the badges leave the header where the tabs would not fit beside it; " +
    'canvas() sets recorder.videoOk while the GPU path shows the screen on a connection offering video; ' +
    'software replay of a cached full-screen frame rebuilds its tab strip (GPU chrome is skipped by software playback); ' +
    'continue checking renderer acknowledgements after startup, refresh software fallback on page changes, clear fallback when acknowledgements resume, and reconnect a hidden connection only while its foreground gate confirms this app; coalesce frames while the renderer waits for its tick using one immutable latest snapshot, discard pending commands when the display connection or placement changes, and transfer controller focus to the tab opened by touch; tag cached recordings by GPU connection and placement, keep software fallbacks out of GPU keepalives, and send a current compatible frame before SHOW; clear stale fallback on READY and retry a lost foreground surface at most three times while the HMI screen has focus; use a slim tab focus marker instead of a red outline',
};

/** Добавленные файлы уведомлений (источник — относительно корня проекта или upstream-путь). */
export const ADDED: Record<string, { from: string; upstream?: boolean; summary: string }> = {
  'kit/runtime/LICENSE': {
    from: 'LICENSE',
    upstream: true,
    summary: 'the upstream MIT LICENSE, verbatim, so the runtime copied into packages (javascript/kit/) carries its notice',
  },
  'kit/runtime/fonts/UFL-Ubuntu.txt': {
    from: 'licenses/UBUNTU_FONT_LICENCE.txt',
    summary: 'Ubuntu Font Licence 1.0 for the atlases baked from the Ubuntu font (label, bold, num, light, gear, cyrillic)',
  },
  'package.json': {
    from: 'native/scripts/vendor-package.json',
    summary: 'marks the vendored CommonJS tools/runtime as "type": "commonjs" (the project root is "type": "module")',
  },
};

/** Каталоги, которые создаёт сборка внутри vendor/ (в git не попадают). */
export const BUILD_DIRS = ['apps', 'dist'] as const;

interface FileRecord {
  path: string;
  status: 'unchanged' | 'modified' | 'added';
  sha256: string;
  upstreamBlob?: string;
  upstreamSha256?: string;
  from?: string;
  summary?: string;
}

export interface Provenance {
  source: { repository: string; commit: string; license: string; licenseFile: string };
  policy: string;
  excluded: string[];
  files: FileRecord[];
}

function fail(msg: string): never {
  throw new Error(`vendor: ${msg}`);
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function git(up: string, args: string[], encoding: 'buffer' | 'utf8' = 'utf8'): Buffer | string {
  const r = spawnSync('git', ['-C', up, ...args], { encoding: encoding === 'utf8' ? 'utf8' : 'buffer', maxBuffer: 64 << 20 });
  if (r.error) fail(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

interface Blob {
  path: string;
  sha: string;
}

/** Блобы закреплённого коммита по allowlist (только обычные файлы; ссылки и подмодули — ошибка). */
export function listBlobs(up: string): Blob[] {
  if (String(git(up, ['cat-file', '-t', UPSTREAM_COMMIT])).trim() !== 'commit') fail(`${UPSTREAM_COMMIT} is not a commit in ${up}`);
  const out = String(git(up, ['ls-tree', '-r', '-z', UPSTREAM_COMMIT, '--', ...ALLOW_FILES, ...ALLOW_DIRS]));
  const blobs: Blob[] = [];
  for (const line of out.split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m) fail(`unexpected ls-tree line: ${line}`);
    const [, mode, type, sha, path] = m;
    if ((EXCLUDE as readonly string[]).includes(path)) continue;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) fail(`${path}: ${type} ${mode} is not a regular file`);
    blobs.push({ path, sha });
  }
  for (const f of ALLOW_FILES) if (!blobs.some((b) => b.path === f)) fail(`${f} is not in commit ${UPSTREAM_COMMIT}`);
  return blobs.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function safeRel(p: string): boolean {
  return p.length > 0 && !p.startsWith('/') && !p.includes('\\') && posix.normalize(p) === p && !p.split('/').includes('..');
}

function writeFile(file: string, data: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

export function vendor(upstream: string = DEFAULT_UPSTREAM, dest: string = VENDOR_DIR): Provenance {
  const up = resolve(upstream);
  if (!existsSync(join(up, '.git'))) fail(`${up} is not a git checkout of idrive7-apps`);
  const blobs = listBlobs(up);
  const files: FileRecord[] = [];
  const contents = new Map<string, Buffer>();
  for (const b of blobs) {
    if (!safeRel(b.path)) fail(`unsafe path ${b.path}`);
    const data = git(up, ['cat-file', 'blob', b.sha], 'buffer') as Buffer;
    contents.set(b.path, data);
    const file = join(dest, b.path);
    if (MODIFIED[b.path]) {
      if (!existsSync(file)) writeFile(file, data);
      const local = readFileSync(file);
      files.push({ path: b.path, status: 'modified', sha256: sha256(local), upstreamBlob: b.sha, upstreamSha256: sha256(data), summary: MODIFIED[b.path] });
    } else {
      writeFile(file, data);
      files.push({ path: b.path, status: 'unchanged', sha256: sha256(data), upstreamBlob: b.sha });
    }
  }
  for (const [path, a] of Object.entries(ADDED)) {
    const data = a.upstream ? contents.get(a.from) : existsSync(join(ROOT, a.from)) ? readFileSync(join(ROOT, a.from)) : undefined;
    if (!data) fail(`${a.from} is missing (source of ${path})`);
    writeFile(join(dest, path), data);
    files.push({ path, status: 'added', sha256: sha256(data), from: a.upstream ? `upstream ${a.from}` : `this project: ${a.from}`, summary: a.summary });
  }
  const prov: Provenance = {
    source: { repository: UPSTREAM_REPOSITORY, commit: UPSTREAM_COMMIT, license: 'MIT', licenseFile: 'LICENSE' },
    policy:
      'Curated MIT subset: kit runtime, the app builder and the files a Russian (ru) build reads. Not included: ' +
      'GPL parts (kit/renderd, kit/emu, Doom), BMW oap-sdk, deployment scripts, prebuilt binaries, tests, caches, ' +
      'other apps, diagnostic catalogs, Barlow (removed by the builder for this app).',
    excluded: [...EXCLUDE],
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  writeFile(join(dest, PROVENANCE_FILE), `${JSON.stringify(prov, null, 2)}\n`);
  const problems = checkVendor(dest);
  if (problems.length) fail(`vendored tree does not verify:\n  ${problems.join('\n  ')}`);
  return prov;
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    const rel = base ? `${base}/${n}` : n;
    const st = lstatSync(join(dir, n));
    if (st.isSymbolicLink()) out.push(`${rel} (symlink)`);
    else if (st.isDirectory()) out.push(...walk(join(dir, n), rel));
    else out.push(rel);
  }
  return out;
}

/** Офлайн-проверка: каждый файл совпадает с PROVENANCE.json, лишних файлов и SDK нет. Возвращает список проблем. */
export function checkVendor(dest: string = VENDOR_DIR): string[] {
  const problems: string[] = [];
  const pf = join(dest, PROVENANCE_FILE);
  if (!existsSync(pf)) return [`${pf} is missing — run npm run native:vendor`];
  let prov: Provenance;
  try {
    prov = JSON.parse(readFileSync(pf, 'utf8')) as Provenance;
  } catch (e) {
    return [`${PROVENANCE_FILE} does not parse: ${(e as Error).message}`];
  }
  if (prov.source?.commit !== UPSTREAM_COMMIT) problems.push(`${PROVENANCE_FILE} names commit ${prov.source?.commit}, expected ${UPSTREAM_COMMIT}`);
  const listed = new Map(prov.files.map((f) => [f.path, f]));
  for (const f of prov.files) {
    const file = join(dest, f.path);
    if (!safeRel(f.path)) problems.push(`unsafe path in provenance: ${f.path}`);
    else if (!existsSync(file)) problems.push(`${f.path} is missing`);
    else if (sha256(readFileSync(file)) !== f.sha256) problems.push(`${f.path} differs from ${PROVENANCE_FILE} (${f.status})`);
    if (f.status === 'unchanged' && f.upstreamSha256) problems.push(`${f.path}: unchanged file with an upstreamSha256`);
  }
  for (const rel of walk(dest)) {
    const top = rel.split('/')[0];
    if (rel === PROVENANCE_FILE || (BUILD_DIRS as readonly string[]).includes(top)) continue;
    if (rel.split('/').includes('__pycache__')) continue;
    if (!listed.has(rel)) problems.push(`${rel} is not in ${PROVENANCE_FILE}`);
  }
  for (const forbidden of ['oap-sdk', 'kit/renderd', 'kit/emu', 'apps/doom', 'deploy', 'third_party']) {
    if (existsSync(join(dest, forbidden))) problems.push(`${forbidden} must not be in the vendored tree`);
  }
  return problems;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] && /native[\\/]scripts[\\/]vendor-upstream\.ts$/.test(process.argv[1]);
if (isMain) {
  try {
    if (process.argv.includes('--check')) {
      const problems = checkVendor();
      if (problems.length) {
        console.error(`vendor check failed:\n  ${problems.join('\n  ')}`);
        process.exit(1);
      }
      console.log(`vendor/idrive7-apps verifies against ${PROVENANCE_FILE} (${UPSTREAM_COMMIT})`);
    } else {
      const prov = vendor(arg('--upstream') ?? process.env.MGU_UPSTREAM ?? DEFAULT_UPSTREAM);
      const n = (s: FileRecord['status']) => prov.files.filter((f) => f.status === s).length;
      console.log(`vendored ${prov.files.length} files from ${UPSTREAM_COMMIT}: ${n('unchanged')} unchanged, ${n('modified')} modified, ${n('added')} added`);
    }
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
