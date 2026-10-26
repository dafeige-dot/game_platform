/**
 * Platform-facing domain model + the contract the UI depends on.
 *
 * The UI never talks to HTTP, Tauri or the filesystem directly — it talks to a
 * LauncherAPI. Today that is MockAdapter (runs anywhere); the Tauri shell
 * satisfies the same later.
 */

export type ViewId = 'store' | 'library' | 'downloads' | 'news' | 'settings';

export type CoverTheme = 'c1' | 'c2' | 'c3' | 'c4' | 'c5';

/** What the launcher offers for this app right now. */
export type AppPhase =
  | 'storefront' // not owned: install / preorder
  | 'updating'   // owned, newer version available
  | 'upToDate'   // owned, nothing to do
  | 'running';

export interface FeaturedContent {
  kicker: string;
  kickerNote: string;
  tagline: string;
  hlKanji: string;
  badges: string[];
  ctaPrimary: string;
  theme: CoverTheme;
}

export interface GameApp {
  appId: string;
  title: string;
  latinTitle: string;
  subtitle: string;
  genres: string[];
  glyph: string;
  cover: CoverTheme;
  score: number;
  players: number;
  /** Content of the newest published build. */
  latestVersion: string;
  /** Bytes of the *newest complete* build (what a fresh install costs). */
  fullSizeBytes: number;
  /** Bytes on the wire for upgrading from the installed version (CAS diff). */
  deltaBytes?: number;
  installedVersion?: string | null;
  /** No real build behind the entry: client-side state-machine demo. */
  demo?: boolean;
  featured?: FeaturedContent;
  rank?: number;
}

export type DownloadPhase =
  | 'queued'
  | 'manifest'
  | 'downloading'
  | 'materialize'
  | 'verify'
  | 'ready'
  | 'paused'
  | 'failed';

export interface DownloadTask {
  appId: string;
  title: string;
  kind: 'install' | 'update';
  fromVersion: string;
  toVersion: string;
  /** Because of CAS this is "what is left to move", not the full build size. */
  totalBytes: number;
  doneBytes: number;
  chunkTotal: number;
  chunkDone: number;
  threadCount: number;
  phase: DownloadPhase;
  speedBps: number;
  error?: string;
}

export interface LibraryEntry {
  appId: string;
  version: string;
  sizeBytes: number;
  playtimeSec: number;
  lastPlayedAt: number | null;
}

export interface ConnectionInfo {
  region: string;
  latencyMs: number;
  speedBps: number;
  clientVersion: string;
  controller: boolean;
}

export interface PlatformSnapshot {
  games: GameApp[];
  library: Record<string, LibraryEntry>;
  downloads: DownloadTask[];
  conn: ConnectionInfo;
}

export type ToastKind = 'info' | 'success' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  ms?: number;
}

export type ToastInput = Omit<Toast, 'id'>;

export interface LauncherEvents {
  /** Whole-slice patches; slices are small (≤ a few hundred entries). */
  patch(patch: Partial<PlatformSnapshot>): void;
  toast(t: ToastInput): void;
}

export interface LauncherAPI {
  readonly name: string;
  init(events: LauncherEvents): Promise<void>;
  install(appId: string): void;
  /** Same command, smaller delta — CAS decides, the UI does not care. */
  update(appId: string): void;
  pause(appId: string): void;
  resume(appId: string): void;
  cancel(appId: string): void;
  launch(appId: string): void;
  dispose(): void;
}

export const formatBytes = (n: number, digits = 1): string => {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
};

export const formatEta = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};

export const formatSpeed = (bps: number): string => bps > 0 ? `${formatBytes(bps, 1)}/s` : '—';

export const phaseLabel: Record<DownloadPhase, string> = {
  queued: '排队',
  manifest: '拉取清单',
  downloading: '增量下载',
  materialize: '拼装文件',
  verify: '校验修复',
  ready: '完成',
  paused: '已暂停',
  failed: '失败',
};
