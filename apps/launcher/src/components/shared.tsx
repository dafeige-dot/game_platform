import { useLauncher } from '../store/useLauncher';
import type { GameApp } from '../platform/types';

/** Gradient poster with the app glyph — stand-in for real key art. */
export function Cover({ game, className = 'thumb' }: { game: GameApp; className?: string }) {
  return (
    <span className={className} data-cover={game.cover} aria-hidden>
      <span className="glyph">{game.glyph}</span>
    </span>
  );
}

export function Spark({ points, color }: { points: number[]; color: string }) {
  const step = 62 / Math.max(1, points.length - 1);
  const max = Math.max(...points) || 1;
  const min = Math.min(...points);
  const span = Math.max(1, max - min);
  const path = points
    .map((p, i) => `${(i * step).toFixed(1)},${(18 - ((p - min) / span) * 16).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" viewBox="0 0 62 22">
      <polyline points={path} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

/** Down trend for stable demo data. */
export const trend = (seed: number, n = 8): number[] =>
  Array.from({ length: n }, (_, i) => 40 - ((i * seed) % 11) - Math.sin(i + seed) * 6);

const DL_ICON = (
  <svg viewBox="0 0 24 24">
    <path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/**
 * The one button that means the same thing everywhere: play, update, install,
 * resume, or a live progress chip.
 */
export function ActionButton({ game, small }: { game: GameApp; small?: boolean }) {
  const downloads = useLauncher((s) => s.downloads);
  const launch = useLauncher((s) => s.launch);
  const update = useLauncher((s) => s.update);
  const install = useLauncher((s) => s.install);
  const resume = useLauncher((s) => s.resume);

  const task = downloads.find((d) => d.appId === game.appId);
  const cls = small ? 'btn small' : 'btn';

  if (task) {
    if (task.phase === 'paused') {
      return <button className={`${cls} ghost`} onClick={() => resume(game.appId)}>继续</button>;
    }
    return (
      <button className={`${cls} primary`} disabled>
        {pct(task)}% · {phaseText(task.phase)}
      </button>
    );
  }
  if (!game.installedVersion) {
    const preload = (game.deltaBytes ?? game.fullSizeBytes) >= 10 * 1024 ** 3;
    return (
      <button className={cls} onClick={() => install(game.appId)}>
        {DL_ICON}
        {preload ? '预下载' : '安装'} {fmtShort(game.deltaBytes ?? game.fullSizeBytes)}
      </button>
    );
  }
  if (game.latestVersion !== game.installedVersion) {
    return (
      <button className={`${cls} primary`} onClick={() => update(game.appId)}>
        {DL_ICON}
        更新 {fmtShort(game.deltaBytes ?? 0)}
      </button>
    );
  }
  return (
    <button className={`${cls} go`} onClick={() => launch(game.appId)}>
      <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" /></svg>
      开始游戏
    </button>
  );
}

const pct = (d: { doneBytes: number; totalBytes: number }) =>
  `${Math.min(100, Math.round((d.doneBytes / d.totalBytes) * 100))}`;

function phaseText(p: string): string {
  const map: Record<string, string> = {
    queued: '排队',
    manifest: '拉清单',
    downloading: '下载中',
    materialize: '拼装',
    verify: '校验',
    ready: '完成',
    paused: '已暂停',
    failed: '失败',
  };
  return map[p] ?? p;
}

function fmtShort(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${n} B`;
}
