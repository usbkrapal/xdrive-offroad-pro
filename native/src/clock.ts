// Монотонные часы для Node 8: process.hrtime() → мс. performance.now() в Node 8 не глобален,
// Date.now() может прыгать при синхронизации времени головного устройства.

export type Now = () => number;

export function monotonicNow(hrtime: (prev?: [number, number]) => [number, number] = process.hrtime): Now {
  const start = hrtime();
  return () => {
    const d = hrtime(start);
    return d[0] * 1000 + d[1] / 1e6;
  };
}
