#!/usr/bin/env node
// Тесты нативного приложения: тот же node:test + tsx, что и scripts/run-tests.mjs браузера,
// отдельным набором (npm test браузера не меняется). Upstream-рантайм (MIT kit/runtime) для
// проверки реального Recorder берётся из внешнего checkout: MGU_UPSTREAM или work/research/idrive7-apps.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = join(root, 'native', 'test');
const files = readdirSync(dir)
  .filter((f) => /\.test\.ts$/.test(f))
  .map((f) => relative(root, join(dir, f)))
  .sort();

if (files.length === 0) {
  console.error('Не найдено ни одного нативного теста');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--import', './scripts/test-assets.mjs', '--test', ...process.argv.slice(2), ...files],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
