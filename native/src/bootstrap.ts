// Побочный эффект при загрузке: только окружение этого процесса, до любого require('./kit/…').
// Отдельный модуль, чтобы тесты могли импортировать renderTarget.ts, не меняя своё окружение.
import { selectRenderTarget } from './renderTarget';

selectRenderTarget(process.env);
