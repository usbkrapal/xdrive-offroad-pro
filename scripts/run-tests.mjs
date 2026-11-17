#!/usr/bin/env node
// Запуск тестов: встроенный node:test + tsx (TypeScript/JSX). Файлы ищутся здесь,
// а не glob-шаблоном CLI, чтобы не зависеть от версии Node и оболочки.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** src/**\/*.test.ts(x) — приложение; scripts/*.test.mjs — упаковщик. */
const find = (dir, pattern) =>
  readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => relative(root, join(e.parentPath ?? e.path, e.name)))
    .sort();
const files = [...find('src', /\.test\.tsx?$/), ...find('scripts', /\.test\.mjs$/)];

if (files.length === 0) {
  console.error('Не найдено ни одного теста');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--import', './scripts/test-assets.mjs', '--test', ...process.argv.slice(2), ...files],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
