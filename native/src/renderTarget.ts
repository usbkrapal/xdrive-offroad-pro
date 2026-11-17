// Выбор рендерера для процесса приложения (не системное окружение). Применяется bootstrap.ts — первым
// импортом main.ts: kit/runtime/renderd.js читает MGU_RENDERD_SOCKET при загрузке модуля, display.js —
// MGU_RENDERD_PROTO при подключении.
//
// Диалект НЕ выбирается: kit по умолчанию просит mgu-render/1 (HELLO "proto=mgu-render/1"). Только в нём
// kit сам ведёт экран (display.own): касание вкладок, «Настройки» вкладкой, без нижней панели. Растры в этом
// диалекте отправляет вендорный renderd.js (IMAGE 10, премультиплицированный RGBA, op 18 `x y w h r id`;
// mgu-render 0.6.21 PROTOCOL.md). Рендерер без mgu-render/1 отвечает одним READY — соединение остаётся
// upstream, растры идут сообщением 9, касания нет (статус это объясняет). MGU_RENDERD_PROTO=upstream,
// заданный снаружи (отладка), по-прежнему принудительно включает upstream-диалект.

/** Сокет установленного mgu-render 0.6.21 (PROTOCOL.md). */
export const RENDER_SOCKET = '/run/mgu-render/render.sock';

export type Env = Record<string, string | undefined>;

/**
 * Сокет — только если не задан снаружи: эмулятор kit/tools/emu.js передаёт свой MGU_RENDERD_SOCKET;
 * запись в файл (MGU_RENDERD_FILE) сокет не использует. MGU_RENDERD_PROTO не трогается.
 */
export function selectRenderTarget(env: Env): void {
  if (!env.MGU_RENDERD_SOCKET) env.MGU_RENDERD_SOCKET = RENDER_SOCKET;
}
