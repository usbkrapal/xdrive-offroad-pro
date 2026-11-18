// xop-camera-bridge: точка входа (systemd, root, /usr/bin/node). Только привязка Bridge к настоящим сокетам, процессам и
// файлам; логика и проверки — в bridge.ts / cluster.ts / camcluster.ts (с тестами).
// Окружение (задаёт systemd-юнит):
//   XOP_CTL_GROUP=<имя>        группа приложений (юнит: tm_oap_app), ищется в /etc/group: ctl-сокет root:<gid> 0660;
//   XOP_BRIDGE_GID=<gid>       то же числом (главнее имени). Ни того, ни другого / группы нет — 0600 и ошибка в журнале
//                              (bridge.ts socketAccess); 0666 не бывает;
//   XOP_BRIDGE_CAMCLUSTER=1    только разработка: запасной путь mgu-camcluster (в рабочем наборе его нет).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { CTL_DIR, CTL_SOCKET } from '../../src/camera/ctl';
import { Bridge, PRODUCTION_PRODUCERS, socketAccess, WITH_CAMCLUSTER, type ChildLike, type Deps, type Peer, type VideoFile } from './bridge';
import { CLUSTER_SOCKET } from './camcluster';

function peerOf(s: net.Socket): Peer {
  return {
    send: (d) => {
      if (!s.destroyed) s.write(d);
    },
    close: () => s.destroy(),
  };
}

function listen(path: string, mode: number, onConn: (s: net.Socket) => void, gid: number | null = null): net.Server {
  try {
    if (fs.lstatSync(path).isSocket()) fs.unlinkSync(path);
  } catch {
    /* нет */
  }
  const srv = net.createServer(onConn);
  srv.listen(path, () => {
    // сбой chown/chmod не роняет службу (иначе цикл перезапусков): сокет остаётся только для root, ошибка в журнале
    try {
      if (gid !== null) fs.chownSync(path, 0, gid);
      fs.chmodSync(path, mode);
    } catch (e) {
      console.log(`ERROR: ${path}: ${String(e)}: socket root-only (0600)`);
      try {
        fs.chmodSync(path, 0o600);
      } catch {
        /* не удалось и это */
      }
    }
  });
  return srv;
}

const deps: Deps = {
  fs: { realpathSync: (p) => fs.realpathSync(p), lstatSync: (p) => fs.lstatSync(p), existsSync: (p) => fs.existsSync(p) },
  readHeader(path) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const b = Buffer.alloc(64);
      fs.readSync(fd, b, 0, 64, 0);
      return { bytes: b, size: st.size };
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  },
  spawn(file, args, hooks): ChildLike {
    // без оболочки, с минимальным окружением; аргументы — массив
    const c = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' }, shell: false, detached: false });
    const lines = (stream: 'out' | 'err') => {
      let buf = '';
      return (d: Buffer) => {
        buf = (buf + d.toString('utf8')).slice(-8192);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          hooks.onLine(stream, buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      };
    };
    if (c.stdout) c.stdout.on('data', lines('out'));
    if (c.stderr) c.stderr.on('data', lines('err'));
    if (c.stdin) c.stdin.on('error', () => undefined);
    c.on('exit', (code, sig) => hooks.onExit(code, sig));
    c.on('error', (e) => hooks.onLine('err', `spawn: ${String(e)}`));
    return {
      pid: c.pid || 0,
      write: (l) => {
        if (c.stdin && !c.stdin.destroyed) c.stdin.write(l);
      },
      endInput: () => {
        if (c.stdin) c.stdin.end();
      },
      kill: (sig) => {
        try {
          c.kill(sig);
        } catch {
          /* уже вышел */
        }
      },
    };
  },
  openVideo(path, bytes): VideoFile {
    // файл кадров root, 0644 (рендерер, запущенный от root, принимает файлы root); без перехода по ссылке
    try {
      if (fs.lstatSync(path).isSymbolicLink()) fs.unlinkSync(path);
    } catch {
      /* нет */
    }
    const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o644);
    fs.ftruncateSync(fd, bytes);
    return {
      write: (data, pos) => {
        fs.writeSync(fd, Buffer.from(data.buffer, data.byteOffset, data.length), 0, data.length, pos);
      },
      close: () => fs.closeSync(fd),
    };
  },
  unlink: (p) => fs.unlinkSync(p),
  now: () => {
    const t = process.hrtime();
    return t[0] * 1000 + t[1] / 1e6;
  },
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  log: (l) => console.log(l),
};

let etcGroup: string | null = null;
try {
  etcGroup = fs.readFileSync('/etc/group', 'utf8');
} catch {
  /* нет /etc/group: только числовой XOP_BRIDGE_GID */
}
const access = socketAccess(process.env, etcGroup);
const appGid = access.gid;
const withCamcluster = process.env.XOP_BRIDGE_CAMCLUSTER === '1';
const bridge = new Bridge(deps, withCamcluster ? WITH_CAMCLUSTER : PRODUCTION_PRODUCERS);
try {
  fs.mkdirSync(CTL_DIR, 0o755);
} catch {
  /* RuntimeDirectory= его создаёт */
}
const ctl = listen(CTL_SOCKET, access.mode, (s) => {
  const p = peerOf(s);
  if (!bridge.connect(p)) return;
  s.setEncoding('utf8');
  s.on('data', (d: string) => bridge.data(p, d));
  s.on('close', () => bridge.disconnect(p));
  s.on('error', () => bridge.disconnect(p));
}, appGid);
const cluster = !withCamcluster ? null : listen(CLUSTER_SOCKET, 0o600, (s) => {
  const p = peerOf(s);
  if (!bridge.clusterConnect(p)) return;
  s.on('data', (d: Buffer) => bridge.clusterData(p, d));
  s.on('close', () => bridge.clusterClosed(p));
  s.on('error', () => bridge.clusterClosed(p));
});
deps.log(`xop-camera-bridge: ctl ${CTL_SOCKET}: ${access.note}${cluster ? `, cluster ${CLUSTER_SOCKET}` : ''}`);

const quit = () => {
  bridge.shutdown();
  ctl.close();
  if (cluster) cluster.close();
  setTimeout(() => process.exit(0), 6000).unref();
};
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
