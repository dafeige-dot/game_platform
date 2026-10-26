/**
 * Mock adapter: the full download state machine with a simulated network.
 *
 * Phase weights, speeds and ETA mirror the real CAS client, so the store, the
 * task sheet and the aggregate status bar are exercised end to end (pause,
 * resume, cancel, completion) before the Rust core exists.
 */
import {
  type ConnectionInfo,
  type DownloadTask,
  type GameApp,
  type LauncherAPI,
  type LauncherEvents,
  type LibraryEntry,
} from './types';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TICK = 250;

/** Per-thread aggregate, in B/s. */
const BASE_SPEED = 34 * MB;
const MANIFEST_MS = 600;
const VERIFY_MS = 800;
const MATERIALIZE_PER_GB_MS = 700;
type TaskKind = 'install' | 'update';

interface TaskState extends DownloadTask {
  kind: TaskKind;
  /** Time left in the current non-download phase. */
  phaseMsLeft: number;
  seed: number;
}

function jitterFor(seed: number): number {
  const x = (seed * 1103515245 + 12345) >>> 0;
  return 0.82 + (x / 0xffffffff) * 0.4;
}

function nextSeed(seed: number): number {
  return (seed * 1664525 + 1013904223) >>> 0;
}

function startTask(game: GameApp, kind: TaskKind, progress = 0, seed = 7): TaskState {
  const total = kind === 'install' ? (game.deltaBytes ?? game.fullSizeBytes) : (game.deltaBytes ?? 64 * MB);
  const chunks = Math.ceil(total / MB);
  const partial = progress > 0;
  return {
    appId: game.appId,
    title: game.title,
    kind,
    fromVersion: kind === 'install' ? '—' : game.installedVersion ?? '—',
    toVersion: game.latestVersion,
    totalBytes: total,
    doneBytes: total * progress,
    chunkTotal: chunks,
    chunkDone: Math.floor(chunks * progress),
    threadCount: 12,
    // Resumed tasks skip manifest+queue; first runs must show the real phases.
    phase: partial ? 'downloading' : 'queued',
    phaseMsLeft: 300,
    speedBps: 0,
    seed,
  };
}

export function seedCatalog(): GameApp[] {
  const seeds: GameApp[] = [
    {
      appId: '1001', title: '星海回响', latinTitle: 'STAR ECHO',
      subtitle: '在坠落的星环上重建一座城。回合制战术 × 叙事冒险，全程手绘动画过场。',
      genres: ['战术RPG', '剧情向', '手柄'], glyph: '星', cover: 'c1',
      score: 9.2, players: 128_400, latestVersion: '1.1.0',
      fullSizeBytes: 42.6 * GB, deltaBytes: 3.1 * GB, installedVersion: '1.0.0',
      rank: 1,
    },
    {
      appId: '1002', title: '夜行电台', latinTitle: 'NIGHT RADIO',
      subtitle: '凌晨三点的城市，只剩你和一个不肯挂断的来电。多结局悬疑文字冒险。',
      genres: ['悬疑', '多结局', '配音'], glyph: '夜', cover: 'c2',
      score: 8.8, players: 84_100, latestVersion: '1.4.3',
      fullSizeBytes: 8.2 * GB, deltaBytes: 38 * MB, installedVersion: '1.4.2',
      rank: 2,
    },
    {
      appId: '1003', title: '苍蓝誓约', latinTitle: 'AZURE VOW',
      subtitle: '十二位舰灵，一段没有归途的航行。即时海战 + 养成，抢先体验开放。',
      genres: ['海战', '养成', 'Demo'], glyph: '蒼', cover: 'c3',
      score: 9.0, players: 71_200, latestVersion: '0.9.0-beta',
      fullSizeBytes: 18.4 * GB, deltaBytes: 12.4 * GB,
      rank: 3,
    },
    {
      appId: '1004', title: '月蚀列车', latinTitle: 'MOON TRAIN',
      subtitle: '在永夜中穿行，下个站点的唯一小事：开出，或者祈祷。',
      genres: ['肉鸽', '卡牌'], glyph: '蝕', cover: 'c4',
      score: 8.5, players: 56_800, latestVersion: '1.2.0',
      fullSizeBytes: 2.4 * GB, rank: 4,
    },
    {
      appId: '1005', title: '像素炼金术', latinTitle: 'PIXEL ALCHEMY',
      subtitle: '一间小铺子，一只会记账的猫，和一个总是迟到的春天。',
      genres: ['模拟经营', '像素'], glyph: '煉', cover: 'c5',
      score: 8.1, players: 49_900, latestVersion: '0.9.4',
      fullSizeBytes: 1.1 * GB, installedVersion: '0.9.4', rank: 5,
    },
    {
      appId: '1006', title: '空境航路', latinTitle: 'SKYBOUND',
      subtitle: '没有土地的世界，所有人的家都在云上。',
      genres: ['冒险', '解谜'], glyph: '空', cover: 'c1',
      score: 8.9, players: 33_500, latestVersion: '2.0.0',
      fullSizeBytes: 6.8 * GB,
    },
    {
      appId: '1007', title: '猫与星图', latinTitle: 'CAT & CHART',
      subtitle: '给一只退休的航海猫一份新工作：重新绘制所有星座。',
      genres: ['治愈', '收集'], glyph: '猫', cover: 'c2',
      score: 8.7, players: 21_700, latestVersion: '1.0.0',
      fullSizeBytes: 800 * MB,
    },
    {
      appId: '1008', title: '深海快递', latinTitle: 'DEEP EXPRESS',
      subtitle: '把货物送到一万人都不敢停靠的地方。',
      genres: ['模拟', '策略'], glyph: '深', cover: 'c4',
      score: 8.4, players: 18_900, latestVersion: '2.0.2',
      fullSizeBytes: 9.6 * GB, installedVersion: '2.0.1',
    },
  ];
  return seeds;
}

export function seedLibrary(games: GameApp[]): Record<string, LibraryEntry> {
  const entries: Record<string, LibraryEntry> = {};
  for (const g of games) {
    if (!g.installedVersion) continue;
    entries[g.appId] = {
      appId: g.appId,
      version: g.installedVersion,
      sizeBytes: Math.round(g.fullSizeBytes * 0.94),
      playtimeSec: Number(g.appId) % 3 === 0 ? 54 * 3600 : 7 * 3600,
      lastPlayedAt: Date.now() - Number(g.appId) * 36e5,
    };
  }
  return entries;
}

export class MockAdapter implements LauncherAPI {
  name = 'mock';

  private ev!: LauncherEvents;
  private games: GameApp[] = [];
  private library: Record<string, LibraryEntry> = {};
  private tasks: TaskState[] = [];
  private timer: number | undefined;
  private conn: ConnectionInfo = {
    region: 'Singapore',
    latencyMs: 24,
    speedBps: 0,
    clientVersion: '0.9.4',
    controller: true,
  };

  async init(ev: LauncherEvents): Promise<void> {
    this.ev = ev;
    this.games = seedCatalog();
    this.library = seedLibrary(this.games);
    // Land on a launcher that already did something.
    updating: {
      const g = this.games.find((x) => x.appId === '1001' && x.installedVersion);
      if (g) this.tasks = [startTask(g, 'update', 0.43)];
    }
    this.sync();
    this.timer = window.setInterval(() => this.tick(), TICK);
  }

  dispose(): void {
    if (this.timer) window.clearInterval(this.timer);
  }

  install(appId: string): void {
    const game = this.games.find((g) => g.appId === appId);
    if (!game || this.taskFor(appId)) return;
    this.tasks.push(startTask(game, 'install'));
    this.ev.toast({
      kind: 'info',
      title: `${game.title} · 已加入预下载队列`,
      detail: `全量 ${fmt(game.fullSizeBytes)}（首发会做分块校验，断网可续传）`,
    });
    this.sync();
  }

  update(appId: string): void {
    const game = this.games.find((g) => g.appId === appId);
    if (!game || this.taskFor(appId) || !game.installedVersion) return;
    this.tasks.push(startTask(game, 'update'));
    this.ev.toast({
      kind: 'info',
      title: `${game.title} · 更新中`,
      detail:
        game.deltaBytes
          ? `只需 ${fmt(game.deltaBytes)}，而不是全量 ${fmt(game.fullSizeBytes)}`
          : '增量分包生成中',
    });
    this.sync();
  }

  pause(appId: string): void {
    const t = this.taskFor(appId);
    if (!t || t.phase === 'paused') return;
    t.phase = 'paused';
    t.speedBps = 0;
    this.sync();
  }

  resume(appId: string): void {
    const t = this.taskFor(appId);
    if (!t || t.phase !== 'paused') return;
    t.phase = 'downloading';
    this.ev.toast({ kind: 'info', title: `${t.title} · 已续传`, detail: '已完成的分块不会重下' });
    this.sync();
  }

  cancel(appId: string): void {
    const t = this.taskFor(appId);
    if (!t) return;
    this.tasks = this.tasks.filter((x) => x !== t);
    this.ev.toast({
      kind: 'info',
      title: `${t.title} · 已取消`,
      detail: t.kind === 'update' ? '本地分块已保留，下次更新更快' : '预下载已释放',
    });
    this.sync();
  }

  launch(appId: string): void {
    const game = this.games.find((g) => g.appId === appId);
    if (!game) return;
    if (
      game.installedVersion &&
      game.latestVersion !== game.installedVersion &&
      !this.taskFor(appId)
    ) {
      this.ev.toast({
        kind: 'error',
        title: '需要先完成更新',
        detail: `v${game.latestVersion} 已就绪，还差最后一次校验`,
      });
      return;
    }
    this.ev.toast({
      kind: 'success',
      title: `${game.title} 正在启动`,
      detail: '进程已挂起平台元数据：好友、时长、截图',
    });
    window.setTimeout(() => {
      this.ev.toast({ kind: 'info', title: `会话结束 · ${game.title}`, detail: '时长已同步云端' });
      this.sync();
    }, 7000);
  }

  private taskFor(appId: string): TaskState | undefined {
    return this.tasks.find((t) => t.appId === appId);
  }

  private tick(): void {
    this.tasks.forEach((t) => {
      const jitter = jitterFor(t.seed);
      t.seed = nextSeed(t.seed);

      switch (t.phase) {
        case 'queued':
          t.phaseMsLeft -= TICK;
          if (t.phaseMsLeft <= 0) {
            t.phase = 'manifest';
            t.phaseMsLeft = MANIFEST_MS;
          }
          break;

        case 'manifest':
          t.speedBps = 0;
          t.phaseMsLeft -= TICK;
          if (t.phaseMsLeft <= 0) {
            t.phase = 'downloading';
            t.speedBps = BASE_SPEED;
          }
          break;

        case 'paused':
          t.speedBps = 0;
          break;

        case 'downloading': {
          t.speedBps = BASE_SPEED * jitter;
          const moved = Math.min(t.totalBytes - t.doneBytes, (t.speedBps * TICK) / 1000);
          t.doneBytes += moved;
          t.chunkDone = Math.round((t.doneBytes / t.totalBytes) * t.chunkTotal);
          if (t.doneBytes >= t.totalBytes) {
            t.chunkDone = t.chunkTotal;
            t.phase = 'materialize';
            t.phaseMsLeft = Math.min(2800, MATERIALIZE_PER_GB_MS * Math.ceil(t.totalBytes / GB));
            t.speedBps = 0;
          }
          break;
        }

        case 'materialize':
          t.phaseMsLeft -= TICK;
          if (t.phaseMsLeft <= 0) {
            t.phase = 'verify';
            t.phaseMsLeft = VERIFY_MS;
          }
          break;

        case 'verify':
          t.phaseMsLeft -= TICK;
          if (t.phaseMsLeft <= 0) {
            this.finish(t);
          }
          break;

        case 'failed':
        case 'ready':
          break;
      }
    });

    this.conn.latencyMs = Math.round(18 + Math.random() * 16);
    this.conn.speedBps = this.tasks
      .filter((t) => t.phase === 'downloading')
      .reduce((n, t) => n + t.speedBps, 0);

    this.sync();
  }

  private finish(t: TaskState): void {
    this.tasks = this.tasks.filter((x) => x !== t);
    const game = this.games.find((g) => g.appId === t.appId);
    if (game) {
      game.installedVersion = t.toVersion;
      const prev = this.library[t.appId];
      this.library[t.appId] = {
        appId: t.appId,
        version: t.toVersion,
        sizeBytes: prev?.sizeBytes ?? game.fullSizeBytes,
        playtimeSec: prev?.playtimeSec ?? 0,
        lastPlayedAt: prev?.lastPlayedAt ?? null,
      };
    }
    this.ev.toast({
      kind: 'success',
      title: t.kind === 'install' ? `${t.title} · 预下载完成` : `${t.title} · 已更新至 v${t.toVersion}`,
      detail: `增量 ${fmt(t.totalBytes)}，本地分块复用 ${88 + Math.floor(Math.random() * 9)}%`,
    });
  }

  /** Whole-slice publish; slices are tiny, React diffing is cheap. */
  private sync(): void {
    this.ev.patch({
      games: [...this.games],
      library: { ...this.library },
      downloads: this.tasks.map(({ phaseMsLeft, seed, ...t }) => ({ ...t })),
      conn: { ...this.conn },
    });
  }
}

function fmt(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${Math.round(n)} B`;
}
