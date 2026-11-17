// npm run native:stage -- [--upstream <idrive7-apps checkout>] [--preview] [--installable]
//
// Копирует ТОЛЬКО это приложение (native/dist/xdrive_offroad_pro) во внешний checkout:
// <upstream>/apps/xdrive_offroad_pro. Другие приложения не трогаются; чужой каталог с тем же
// именем (без нашей метки) не перезаписывается.
//   --preview      затем python3 kit/tools/build.py --language ru --preview-only xdrive_offroad_pro
//                  (офлайн-превью без BMW SDK; НЕ устанавливаемый пакет)
//   --installable  только если в checkout есть извлечённый владельцем oap-sdk: официальный build.py
//                  --language ru (без --preview-only). Никаких команд развёртывания на автомобиль.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { APP_ID, LOGGING_ID } from '../src/manifest';
import { ROOT } from './bundle';
import { APP_FILES, OUT_DIR } from './build';

/** Закреплённый checkout рядом с проектом (work/research/idrive7-apps). */
export const DEFAULT_UPSTREAM = resolve(ROOT, '..', '..', 'work', 'research', 'idrive7-apps');
export const MARKER = '.xop-staged';

export interface StageResult {
  readonly target: string;
  readonly files: readonly string[];
}

function fail(msg: string): never {
  throw new Error(`stage: ${msg}`);
}

/** Проверить, что каталог — checkout idrive7-apps, и вернуть безопасный путь apps/<id>. */
export function resolveTarget(upstream: string): string {
  const up = realpathSync(resolve(upstream));
  for (const f of ['kit/tools/build.py', 'kit/runtime/mgu.js', 'kit/runtime/record.js', 'kit/runtime/gauges.js']) {
    if (!existsSync(join(up, f))) fail(`${up} does not look like an idrive7-apps checkout (missing ${f})`);
  }
  const apps = join(up, 'apps');
  if (!existsSync(apps) || !lstatSync(apps).isDirectory()) fail(`${apps} is not a directory`);
  const appsReal = realpathSync(apps);
  if (dirname(appsReal) !== up) fail(`${apps} resolves outside the checkout (${appsReal})`);
  const target = join(appsReal, APP_ID);
  if (basename(target) !== APP_ID || dirname(target) !== appsReal || relative(appsReal, target).includes('..') || relative(appsReal, target).includes(sep)) {
    fail(`refusing unexpected target ${target}`);
  }
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) fail(`${target} exists and is not a plain directory`);
    if (!existsSync(join(target, MARKER))) fail(`${target} exists but was not created by this tool (no ${MARKER}); not overwriting`);
    const unexpected = readdirSync(target).filter((f) => f !== MARKER && f !== LEGACY_LICENSE && !(APP_FILES as readonly string[]).includes(f));
    if (unexpected.length) fail(`${target} contains files this tool did not stage: ${unexpected.join(', ')}; not overwriting`);
  }
  return target;
}

/** Уникальность loggingId среди остальных приложений checkout. */
export function checkLoggingId(appsDir: string): void {
  for (const d of readdirSync(appsDir)) {
    if (d === APP_ID) continue;
    const f = join(appsDir, d, 'app.json');
    if (!existsSync(f)) continue;
    try {
      const spec = JSON.parse(readFileSync(f, 'utf8')) as { loggingId?: string };
      if (spec.loggingId === LOGGING_ID) fail(`loggingId ${LOGGING_ID} is already used by apps/${d}`);
    } catch (e) {
      if (String(e).includes('loggingId')) throw e;
    }
  }
}

/** Прежнее имя уведомления (build.py его не копировал); в ранее подготовленном каталоге — наш файл. */
const LEGACY_LICENSE = 'LICENSE.idrive7-apps';

export function stage(upstream: string, src: string = OUT_DIR): StageResult {
  for (const f of APP_FILES) if (!existsSync(join(src, f))) fail(`${join(src, f)} is missing — run npm run native:build first`);
  const target = resolveTarget(upstream);
  checkLoggingId(dirname(target));
  if (existsSync(target)) rmSync(target, { recursive: true });
  mkdirSync(target);
  writeFileSync(join(target, MARKER), `staged by terrain-monitor native/scripts/stage.ts at ${new Date().toISOString()}\n`);
  for (const f of APP_FILES) copyFileSync(join(src, f), join(target, f));
  return { target, files: APP_FILES.slice() };
}

/** Есть ли извлечённый владельцем SDK (kit/tools/extract_sdk.js → oap-sdk/index.js + package.json). */
export function ownerSdkPresent(upstream: string): boolean {
  const sdk = join(resolve(upstream), 'oap-sdk');
  try {
    if (!existsSync(join(sdk, 'index.js'))) return false;
    const pkg = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as { name?: string };
    return typeof pkg === 'object' && pkg !== null && readFileSync(join(sdk, 'index.js')).length > 0;
  } catch {
    return false;
  }
}

function runBuildPy(upstream: string, previewOnly: boolean): number {
  const args = ['kit/tools/build.py', '--language', 'ru', ...(previewOnly ? ['--preview-only'] : []), APP_ID];
  console.log(`$ (cd ${upstream} && python3 ${args.join(' ')})`);
  const r = spawnSync('python3', args, { cwd: upstream, stdio: 'inherit' });
  return r.status ?? 1;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] && /native[\\/]scripts[\\/]stage\.ts$/.test(process.argv[1]);
if (isMain) {
  try {
    const upstream = resolve(arg('--upstream') ?? process.env.MGU_UPSTREAM ?? DEFAULT_UPSTREAM);
    const res = stage(upstream);
    console.log(`staged ${res.files.join(', ')} -> ${res.target}`);
    if (process.argv.includes('--installable')) {
      if (!ownerSdkPresent(upstream)) {
        console.error('installable build refused: no owner-extracted oap-sdk/ in the checkout (kit/tools/extract_sdk.js). Nothing was packaged.');
        process.exit(2);
      }
      process.exit(runBuildPy(upstream, false));
    } else if (process.argv.includes('--preview')) {
      const code = runBuildPy(upstream, true);
      if (code === 0) console.log(`preview stage: ${join(upstream, 'dist', APP_ID)} (NO SDK, NOT INSTALLABLE)`);
      process.exit(code);
    } else {
      console.log(`preview build: (cd ${upstream} && python3 kit/tools/build.py --language ru --preview-only ${APP_ID})`);
    }
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
