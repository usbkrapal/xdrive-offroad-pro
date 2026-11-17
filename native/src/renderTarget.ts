// Выбор рендерера для процесса приложения (не системное окружение). Применяется bootstrap.ts — первым
// импортом main.ts: kit/runtime/renderd.js читает MGU_RENDERD_SOCKET при загрузке модуля, display.js —
// MGU_RENDERD_PROTO при подключении. Без "upstream" kit просит диалект mgu-render/1, а в нём RenderClient отбрасывает
// все растровые изображения (op 18) — у приложения пропали бы рендеры, приборы и камеры.
// mgu-render 0.6.21 понимает upstream IMAGE (9) и op 18 по обычному HELLO (PROTOCOL.md, «Telling them apart»).

/** Сокет установленного mgu-render 0.6.21 (PROTOCOL.md). */
export const RENDER_SOCKET = '/run/mgu-render/render.sock';
export const RENDER_PROTO = 'upstream';

export type Env = Record<string, string | undefined>;

/**
 * Диалект — всегда upstream (иначе изображения теряются). Сокет — только если не задан снаружи:
 * эмулятор kit/tools/emu.js передаёт свой MGU_RENDERD_SOCKET; запись в файл (MGU_RENDERD_FILE)
 * сокет не использует.
 */
export function selectRenderTarget(env: Env): void {
  env.MGU_RENDERD_PROTO = RENDER_PROTO;
  if (!env.MGU_RENDERD_SOCKET) env.MGU_RENDERD_SOCKET = RENDER_SOCKET;
}
