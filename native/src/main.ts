// Точка входа нативного приложения (становится javascript/app.js пакета MGU).
// Порядок важен: выбор рендерера — до любого require('./kit/…') (renderd.js читает окружение при загрузке);
// совместимость Node 8 — до загрузки общего доменного кода. Порядок в бандле проверяет compat-scan.
import './bootstrap';
import './compat';
import { startApp } from './app';
import type { AssetsModule } from './assets/spec';
import { monotonicNow } from './clock';
import { loadKit } from './platform/kit';

const kit = loadKit();

function loadAssets(log: { warn(...a: unknown[]): void }): AssetsModule | null {
  try {
    return require('./assets') as AssetsModule;
  } catch (e) {
    // Без растров приложение работает: вместо картинок — контуры и заглушки.
    log.warn('assets.js is missing or broken', e);
    return null;
  }
}

kit.mgu.run({
  start(ctx) {
    startApp(ctx, kit, loadAssets(ctx.log), monotonicNow());
  },
});
