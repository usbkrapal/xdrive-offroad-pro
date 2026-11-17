// npm run native:package -- [--repository <owner>/<name> [--tag <tag>]]
//
// Store-пакет без BMW SDK для релиза GitHub / каталога MGU Store:
//   1. проверяет вендорное MIT-дерево (vendor/idrive7-apps, PROVENANCE.json);
//   2. кладёт собранное приложение (native/dist/xdrive_offroad_pro) в vendor/idrive7-apps/apps/<id>;
//   3. python3 -I kit/tools/build.py --language ru --store-package <id> (без оболочки);
//   4. проверяет пакет (verify_store_package.py) и только тогда пишет native/release:
//      <id>@<версия>.tgz, icon.png, catalog.json, mgu-store.json, SHA256SUMS — и проверяет их ещё раз.
// Версия берётся из сгенерированного build.py package.json (локализованная спецификация).
// URL артефакта по умолчанию относительный (каталог в папке / на флешке / по HTTPS рядом с пакетом);
// с --repository — ссылка на скачивание из релиза GitHub (тег по умолчанию — "catalog", обычный релиз
// каталога: Store читает его без API и без лимита запросов). Ничего не публикуется.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { APP_ID, APP_TITLE } from '../src/manifest';
import { NATIVE } from './bundle';
import { OUT_DIR } from './build';
import { stage } from './stage';
import { checkVendor, VENDOR_DIR } from './vendor-upstream';

export const RELEASE_DIR = join(NATIVE, 'release');
export const VERIFIER = join(NATIVE, 'scripts', 'verify_store_package.py');
export const CATALOG_TAG = 'catalog';
export const ICON_NAME = 'icon.png';
export const META_FILES = ['catalog.json', 'mgu-store.json', ICON_NAME, 'SHA256SUMS'] as const;
const LANGUAGE = 'ru';

export interface ReleaseOptions {
  readonly repository?: string;
  readonly tag?: string;
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--repository') repository = value();
    else if (a === '--tag') tag = value();
    else fail(`unknown argument ${a} (use --repository <owner>/<name> [--tag <tag>])`);
  }
  if (repository !== undefined && (!REPO_RE.test(repository) || repository.split('/')[1].startsWith('.') || repository.includes('..'))) {
    fail(`--repository must be <owner>/<name>, got ${JSON.stringify(repository)}`);
  }
  if (tag !== undefined && (!TAG_RE.test(tag) || tag.includes('..'))) fail(`--tag ${JSON.stringify(tag)} is not a plain release tag`);
  if (tag !== undefined && repository === undefined) fail('--tag needs --repository (relative URLs need no tag)');
  return { repository, tag: repository ? (tag ?? CATALOG_TAG) : undefined };
}

/** Относительный URL (рядом с catalog.json) или browser_download_url публичного релиза GitHub. */
export function artifactUrl(name: string, opts: ReleaseOptions): string {
  if (!opts.repository) return name;
  return `https://github.com/${opts.repository}/releases/download/${opts.tag ?? CATALOG_TAG}/${name}`;
}

export function buildCatalog(pkg: PackageSummary, iconSha256: string, opts: ReleaseOptions): Record<string, unknown> {
  return {
    schema: 2,
    components: [
      {
        id: pkg.id,
        kind: 'app',
        title: APP_TITLE,
        description: pkg.description,
        version: pkg.version,
        artifact: { name: pkg.file, size: pkg.size, sha256: pkg.sha256, url: artifactUrl(pkg.file, opts) },
        requires: { ...pkg.requires },
        uninstallable: true,
        mguHmi: [...pkg.mguHmi],
        icon: artifactUrl(ICON_NAME, opts),
        iconSha256,
      },
    ],
  };
}

export function buildStoreMeta(pkg: PackageSummary, iconSha256: string): Record<string, unknown> {
  return { apps: { [pkg.id]: { title: APP_TITLE, description: pkg.description, icon: ICON_NAME, iconSha256 } } };
}

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export function sha256sums(dir: string, names: readonly string[]): string {
  return [...names].sort().map((n) => `${sha256(readFileSync(join(dir, n)))}  ${n}\n`).join('');
}

/** Файлы, которыми управляет этот скрипт в native/release (прочие не трогаются, а мешают — ошибка). */
export function managed(name: string): boolean {
  return (META_FILES as readonly string[]).includes(name) || (name.startsWith(`${APP_ID}@`) && name.endsWith('.tgz'));
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

/** verify_store_package.py; бросает ошибку с её списком проблем. */
export function runVerifier(mode: 'package' | 'release', path: string, opts: ReleaseOptions = {}, target: VerifyTarget = APP_TARGET): PackageSummary {
  const args = ['-I', VERIFIER, mode, path, '--spec', target.spec, '--language', target.language];
  if (opts.repository) args.push('--repository', opts.repository, '--tag', opts.tag ?? CATALOG_TAG);
  const r = run('python3', args, NATIVE, true);
  if (r.status !== 0) fail(`${mode} verification failed:\n${r.stderr.trim() || r.stdout.trim()}`);
  return JSON.parse(r.stdout) as PackageSummary;
}

/** Записать в dir пакет, значок и метаданные (catalog.json, mgu-store.json, SHA256SUMS). */
export function writeRelease(dir: string, tgz: string, icon: string, pkg: PackageSummary, opts: ReleaseOptions): string[] {
  copyFileSync(tgz, join(dir, pkg.file));
  copyFileSync(icon, join(dir, ICON_NAME));
  const iconSha = sha256(readFileSync(join(dir, ICON_NAME)));
  writeFileSync(join(dir, 'catalog.json'), `${JSON.stringify(buildCatalog(pkg, iconSha, opts), null, 2)}\n`);
  writeFileSync(join(dir, 'mgu-store.json'), `${JSON.stringify(buildStoreMeta(pkg, iconSha), null, 2)}\n`);
  const names = [pkg.file, ICON_NAME, 'catalog.json', 'mgu-store.json'];
  writeFileSync(join(dir, 'SHA256SUMS'), sha256sums(dir, names));
  return [...names, 'SHA256SUMS'];
}

/** Убрать прежний вывод этого приложения в vendor/idrive7-apps/dist (только его). */
function cleanVendorDist(dist: string): void {
  if (!existsSync(dist)) return;
  for (const n of readdirSync(dist)) {
    if (n === APP_ID || n.startsWith(`${APP_ID}@`)) rmSync(join(dist, n), { recursive: true, force: true });
  }
}

export function packageStore(opts: ReleaseOptions, log: (s: string) => void = console.log): PackageSummary {
  const problems = checkVendor();
  if (problems.length) fail(`vendor/idrive7-apps does not verify (npm run native:vendor):\n  ${problems.join('\n  ')}`);
  if (!existsSync(join(OUT_DIR, 'app.json'))) fail(`${join(OUT_DIR, 'app.json')} is missing — run npm run native:build first`);
  if (!existsSync(VERIFIER)) fail(`${VERIFIER} is missing`);

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
  const pkg = runVerifier('package', tgz);
  log(`verified ${pkg.file}: ${pkg.size} bytes, sha256 ${pkg.sha256}`);
  const iconSrc = join(dist, APP_ID, 'source', ...pkg.icon.split('/'));
  if (!existsSync(iconSrc)) fail(`${iconSrc} is missing`);

  // Сначала во временную папку рядом, проверка, затем замена управляемых файлов в native/release.
  mkdirSync(RELEASE_DIR, { recursive: true });
  const foreign = readdirSync(RELEASE_DIR).filter((n) => !managed(n) && n !== '.gitkeep');
  if (foreign.length) fail(`native/release contains files this tool does not manage: ${foreign.join(', ')}; not touching it`);
  const tmp = mkdtempSync(join(NATIVE, '.release-'));
  try {
    writeRelease(tmp, tgz, iconSrc, pkg, opts);
    runVerifier('release', tmp, opts);
    for (const n of readdirSync(RELEASE_DIR)) if (managed(n)) rmSync(join(RELEASE_DIR, n), { force: true });
    for (const n of readdirSync(tmp)) renameSync(join(tmp, n), join(RELEASE_DIR, n));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  runVerifier('release', RELEASE_DIR, opts);
  return pkg;
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
        ? `catalog URLs point to the ${opts.tag} release of ${opts.repository}: upload ${pkg.file} and ${ICON_NAME} there; catalog.json goes to the release tagged "${CATALOG_TAG}" with ${ICON_NAME}.`
        : 'catalog URLs are relative (a folder, USB stick or HTTPS directory holding these files); pass --repository <owner>/<name> [--tag <tag>] for GitHub release URLs.',
    );
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
