// Версия приложения (app.json version). Отдельно от manifest.ts: её читает и app.ts (лист поддержки), а manifest.ts
// импортирует app.ts — без отдельного модуля был бы цикл. Номер следующего выпуска согласует root.
export const APP_VERSION = '0.1.4';
