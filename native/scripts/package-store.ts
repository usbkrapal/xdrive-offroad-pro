// npm run native:package -- [--repository <owner>/<name> [--tag <tag>]]
//
// Объединённый Store-выпуск 0.1.2 без BMW SDK (ничего не публикуется):
//   1. проверяет вендорное MIT-дерево (vendor/idrive7-apps, PROVENANCE.json);
//   2. кладёт собранное приложение (native/dist/xdrive_offroad_pro) в vendor/idrive7-apps/apps/<id> и запускает
//      python3 -I kit/tools/build.py --language ru --store-package <id> (без оболочки); проверяет пакет;
//   3. собирает bridge.js моста камер (bundle-bridge.ts, Node 8.7);
//   4. берёт приёмник native/camrx/build/target/xop-camrx (sh native/camrx/build.sh target; без него — ошибка,
//      хостовая сборка или заглушки не подставляются);
//   5. python3 -I native/scripts/release_tools.py release: наборы xop-camera-bridge и xop-camrx (формат deploy),
//      исходники xop-camrx (GPL), catalog.json с цепочкой app -> bridge -> camrx, mgu-store.json, icon.png,
//      SHA256SUMS; всё проверяется до и после переноса в native/release. Копии-конфликты iCloud/Finder
//      ("catalog 2.json") уходят нетронутыми в native/release-quarantine/<время>/, чужие файлы останавливают сборку.
// URL артефактов: без --repository относительные (папка/флешка/HTTPS рядом с catalog.json); с --repository —
// загрузки неизменяемого релиза GitHub, по умолчанию тег v<версия> (catalog.json потом выкладывается отдельно в
// релиз "catalog").

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { APP_ID } from '../src/manifest';
import { BRIDGE_JS, bundleBridge } from './bundle-bridge';
import { NATIVE } from './bundle';
import { OUT_DIR } from './build';
import { stage } from './stage';
import { checkVendor, VENDOR_DIR } from './vendor-upstream';

export const RELEASE_DIR = join(NATIVE, 'release');
export const VERIFIER = join(NATIVE, 'scripts', 'verify_store_package.py');
export const CATALOG_TAG = 'catalog';
export const ICON_NAME = 'icon.png';
export const RELEASE_TOOLS = join(NATIVE, 'scripts', 'release_tools.py');
export const CAMRX_BIN = join(NATIVE, 'camrx', 'build', 'target', 'xop-camrx');
export const QUARANTINE_DIR = join(NATIVE, 'release-quarantine');
const LANGUAGE = 'ru';

export interface ReleaseOptions {
  readonly repository?: string;
  readonly tag?: string;
  /** Каталог с опубликованными инструментами камер 0.1.6 (release_tools.py PUBLISHED_TOOLS): переиспользуются байт в байт. */
  readonly reuseTools?: string;
}

/** Сводка verify_store_package.py package. */
export interface PackageSummary {
  file: string;
  size: number;
  sha256: string;
  id: string;
  version: string;
  description: string;
  mguHmi: string[];
  requires: Record<string, string>;
  icon: string;
}

function fail(msg: string): never {
  throw new Error(`package-store: ${msg}`);
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseArgs(argv: readonly string[]): ReleaseOptions {
  let repository: string | undefined;
  let tag: string | undefined;
  let reuseTools: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--repository') repository = value();
    else if (a === '--tag') tag = value();
    else if (a === '--reuse-tools') reuseTools = value();
    else fail(`unknown argument ${a} (use --repository <owner>/<name> [--tag <tag>] [--reuse-tools <dir>])`);
  }
  if (repository !== undefined && (!REPO_RE.test(repository) || repository.split('/')[1].startsWith('.') || repository.includes('..'))) {
    fail(`--repository must be <owner>/<name>, got ${JSON.stringify(repository)}`);
  }
  if (tag !== undefined && (!TAG_RE.test(tag) || tag.includes('..'))) fail(`--tag ${JSON.stringify(tag)} is not a plain release tag`);
  if (tag !== undefined && repository === undefined) fail('--tag needs --repository (relative URLs need no tag)');
  return { repository, tag, reuseTools };
}

function run(cmd: string, args: string[], cwd: string, capture: boolean): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 16 << 20 });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface VerifyTarget {
  readonly spec: string;
  readonly language: string;
}

const APP_TARGET: VerifyTarget = { spec: join(OUT_DIR, 'app.json'), language: LANGUAGE };

/** verify_store_package.py package; бросает ошибку с её списком проблем. */
export function verifyAppPackage(path: string, target: VerifyTarget = APP_TARGET): PackageSummary {
  const r = run('python3', ['-I', VERIFIER, 'package', path, '--spec', target.spec, '--language', target.language], NATIVE, true);
  if (r.status !== 0) fail(`package verification failed:\n${r.stderr.trim() || r.stdout.trim()}`);
  return JSON.parse(r.stdout) as PackageSummary;
}

/** Аргументы release_tools.py release (отдельно — для проверки и для печати команды). */
export function releaseArgs(appTgz: string, opts: ReleaseOptions, spec = APP_TARGET.spec): string[] {
  const args = ['-I', RELEASE_TOOLS, 'release', '--release-dir', RELEASE_DIR, '--quarantine', QUARANTINE_DIR, '--app-tgz', appTgz, '--spec', spec, '--bridge-js', BRIDGE_JS, '--camrx', CAMRX_BIN];
  if (opts.repository) args.push('--repository', opts.repository, '--tag', opts.tag as string);
  if (opts.reuseTools) args.push('--reuse-tools', opts.reuseTools);
  return args;
}

/** Убрать прежний вывод этого приложения в vendor/idrive7-apps/dist (только его). */
function cleanVendorDist(dist: string): void {
  if (!existsSync(dist)) return;
  for (const n of readdirSync(dist)) {
    if (n === APP_ID || n.startsWith(`${APP_ID}@`)) rmSync(join(dist, n), { recursive: true, force: true });
  }
}

export function packageStore(opts: ReleaseOptions, log: (s: string) => void = console.log): PackageSummary & { tag?: string } {
  const problems = checkVendor();
  if (problems.length) fail(`vendor/idrive7-apps does not verify (npm run native:vendor):\n  ${problems.join('\n  ')}`);
  if (!existsSync(join(OUT_DIR, 'app.json'))) fail(`${join(OUT_DIR, 'app.json')} is missing — run npm run native:build first`);
  if (!existsSync(VERIFIER) || !existsSync(RELEASE_TOOLS)) fail(`${VERIFIER} or ${RELEASE_TOOLS} is missing`);

  mkdirSync(join(VENDOR_DIR, 'apps'), { recursive: true });
  const staged = stage(VENDOR_DIR);
  log(`staged ${staged.files.join(', ')} -> vendor/idrive7-apps/apps/${APP_ID}`);

  const dist = join(VENDOR_DIR, 'dist');
  cleanVendorDist(dist);
  const args = ['-I', posix.join('kit', 'tools', 'build.py'), '--language', LANGUAGE, '--store-package', APP_ID];
  log(`$ (cd vendor/idrive7-apps && python3 ${args.join(' ')})`);
  const b = run('python3', args, VENDOR_DIR, false);
  if (b.status !== 0) fail(`build.py --store-package failed (exit ${b.status}); nothing was written to native/release`);

  const srcPkg = join(dist, APP_ID, 'source', 'package.json');
  if (!existsSync(srcPkg)) fail(`${srcPkg} was not generated`);
  const generated = JSON.parse(readFileSync(srcPkg, 'utf8')) as { name?: string; version?: string };
  if (generated.name !== APP_ID || typeof generated.version !== 'string') fail(`generated package.json names ${generated.name} ${generated.version}`);
  const tgzName = `${APP_ID}@${generated.version}.tgz`;
  const outputs = readdirSync(dist).filter((n) => n.startsWith(`${APP_ID}@`));
  if (outputs.length !== 1 || outputs[0] !== tgzName) fail(`expected only ${tgzName} in vendor/idrive7-apps/dist, found ${outputs.join(', ') || 'nothing'}`);

  const tgz = join(dist, tgzName);
  const pkg = verifyAppPackage(tgz);
  log(`verified ${pkg.file}: ${pkg.size} bytes, sha256 ${pkg.sha256}`);
  if (opts.repository && !opts.tag) opts = { ...opts, tag: `v${pkg.version}` };

  // Камеры: опубликованные инструменты 0.1.6 байт в байт (--reuse-tools), иначе мост (Node 8) и приёмник (готовая сборка
  // x86-64 Linux; ничем не подменяется).
  if (opts.reuseTools) log(`camera tools: published files from ${opts.reuseTools} (sha256 checked by release_tools.py)`);
  else {
    const bridge = bundleBridge();
    log(`bundled ${bridge.file}: ${bridge.bytes} bytes (${bridge.inputs.length} inputs; requires ${bridge.requires.join(', ')})`);
    if (!existsSync(CAMRX_BIN) || statSync(CAMRX_BIN).size === 0) {
      fail(`${CAMRX_BIN} is missing or empty: build it with sh native/camrx/build.sh target (no host build or stub is ever packaged); nothing was written to native/release`);
    }
  }
  // Сборка, проверка и перенос в native/release — release_tools.py (копии-конфликты — в карантин, чужие файлы — стоп).
  const r = run('python3', releaseArgs(tgz, opts), NATIVE, true);
  if (r.stderr.trim()) log(r.stderr.trim());
  if (r.status !== 0) fail(`release_tools.py release failed (exit ${r.status}); see above`);
  const summary = JSON.parse(r.stdout) as { quarantined?: string[] };
  if (summary.quarantined && summary.quarantined.length) log(`conflict copies moved (not deleted): ${summary.quarantined.join(', ')}`);
  return { ...pkg, tag: opts.tag } as PackageSummary & { tag?: string };
}

const isMain = process.argv[1] && /native[\\/]scripts[\\/]package-store\.ts$/.test(process.argv[1]);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const pkg = packageStore(opts);
    const size = (n: string) => statSync(join(RELEASE_DIR, n)).size;
    console.log(`native/release ready (not published):`);
    for (const n of readdirSync(RELEASE_DIR).sort()) console.log(`  ${n}  ${size(n)} bytes`);
    console.log(
      opts.repository
        ? `artifact URLs point to the immutable ${pkg.tag} release of ${opts.repository}: every file but catalog.json goes there; catalog.json (and ${ICON_NAME}) later to the release tagged "${CATALOG_TAG}". Nothing was uploaded.`
        : 'artifact URLs are relative (a folder, USB stick or HTTPS directory holding these files); pass --repository <owner>/<name> [--tag v<version>] for GitHub release URLs.',
    );
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
