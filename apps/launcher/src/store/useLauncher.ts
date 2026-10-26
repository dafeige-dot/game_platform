import { create } from 'zustand';
import { createAdapter, type AdapterMode } from '../platform';
import {
  phaseLabel,
  type ConnectionInfo,
  type DownloadTask,
  type GameApp,
  type LauncherAPI,
  type LibraryEntry,
  type PlatformSnapshot,
  type Toast,
  type ToastInput,
  type ViewId,
} from '../platform/types';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

interface LauncherState {
  ready: boolean;
  mode: AdapterMode | null;
  games: GameApp[];
  library: Record<string, LibraryEntry>;
  downloads: DownloadTask[];
  conn: ConnectionInfo | null;
  view: ViewId;
  toasts: Toast[];

  boot(): void;
  setView(view: ViewId): void;

  install(appId: string): void;
  update(appId: string): void;
  pause(appId: string): void;
  resume(appId: string): void;
  cancel(appId: string): void;
  launch(appId: string): void;

  dismiss(id: number): void;
  toast(t: ToastInput): void;
}

let nextToast = 1;
let api: LauncherAPI | null = null;
let booted = false;

export const useLauncher = create<LauncherState>((set, get) => ({
  ready: false,
  mode: null,
  games: [],
  library: {},
  downloads: [],
  conn: null,
  view: 'store',
  toasts: [],

  boot: () => {
    if (booted) return;
    booted = true;
    void createAdapter({
      patch: (patch: Partial<PlatformSnapshot>) => set(patch),
      toast: (t: ToastInput) => get().toast(t),
    }).then(({ api: adapter, mode: m, note }) => {
      api = adapter;
      set({ mode: m, ready: true });
      if (note) get().toast({ kind: 'info', title: '后端状态', detail: note });
    });
  },

  setView: (view) => set({ view }),

  install: (appId) => api?.install(appId),
  update: (appId) => api?.update(appId),
  pause: (appId) => api?.pause(appId),
  resume: (appId) => api?.resume(appId),
  cancel: (appId) => api?.cancel(appId),
  launch: (appId) => api?.launch(appId),

  toast: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: nextToast++ }] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/* ── selectors ──────────────────────────────────────────────── */

export const selectFeatured = (s: LauncherState) =>
  s.games.filter((g) => g.rank && g.rank <= 3);

export const selectNewArrivals = (s: LauncherState) =>
  [...s.games]
    .sort((a, b) => (b.rank ?? 99) - (a.rank ?? 99))
    .slice(0, 4)
    .reverse();

export const selectTrending = (s: LauncherState) =>
  s.games.filter((g) => g.rank).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).slice(0, 5);

export const selectInstalled = (s: LauncherState) =>
  Object.values(s.library)
    .map((entry) => ({ entry, game: s.games.find((g) => g.appId === entry.appId) }))
    .filter((x): x is { entry: LibraryEntry; game: GameApp } => Boolean(x.game));

export const selectActiveTask = (s: LauncherState, appId: string) =>
  s.downloads.find((d) => d.appId === appId);

/** What the user can do with this app right now; shared by every panel. */
export function describeAction(
  game: GameApp,
  downloads: DownloadTask[],
  library: Record<string, LibraryEntry>,
): Action {
  const task = downloads.find((d) => d.appId === game.appId);
  if (task) {
    if (task.phase === 'paused') return { kind: 'resume', label: '继续' };
    return { kind: 'progress', label: phaseLabel[task.phase] ?? task.phase };
  }
  if (!game.installedVersion) {
    const preload = (game.deltaBytes ?? game.fullSizeBytes) >= 10 * GB;
    return { kind: 'install', label: preload ? '预下载' : '安装' };
  }
  if (game.latestVersion !== game.installedVersion) {
    return { kind: 'update', label: game.deltaBytes ? `更新 ${fmtShort(game.deltaBytes)}` : '更新' };
  }
  return { kind: 'play', label: library[game.appId] ? '开始游戏' : '安装' };
}

export type Action =
  | { kind: 'play'; label: string }
  | { kind: 'update'; label: string }
  | { kind: 'install'; label: string }
  | { kind: 'resume'; label: string }
  | { kind: 'progress'; label: string };

function fmtShort(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
  return `${n} B`;
}
