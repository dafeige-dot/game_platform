import { useCallback, useEffect, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Toast, ViewId } from '../platform/types';
import { isTauri } from '../platform';
import { formatSpeed } from '../platform/types';
import { useLauncher } from '../store/useLauncher';

/* ── titlebar ───────────────────────────────────────────────── */
export function TitleBar() {
  const mode = useLauncher((s) => s.mode);
  // Undecorated window: drag region + wired controls; no-op outside Tauri.
  const win = () => (isTauri ? getCurrentWindow() : null);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="mark" data-tauri-drag-region><i /><span>STELLAR</span></div>
      <div className="mark-note" data-tauri-drag-region>LAUNCHER · BETA</div>
      {mode ? <span className={`mode-chip ${mode === 'mock' ? 'mock' : ''}`}>{mode.toUpperCase()}</span> : null}
      <div className="winctl">
        <b
          onClick={() => win()?.minimize()}
          onDoubleClick={() => win()?.toggleMaximize()}
          aria-label="最小化"
        >—</b>
        <b onClick={() => win()?.toggleMaximize()} aria-label="最大化">▢</b>
        <b className="x" onClick={() => win()?.close()} aria-label="关闭">✕</b>
      </div>
    </header>
  );
}

/* ── rail ───────────────────────────────────────────────────── */
const NAV: { id: ViewId; label: string; icon: ReactNode }[] = [
  { id: 'store', label: '商店', icon: <path d="M4 7h16l-1.5 12a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 7ZM9 7V5.5a3 3 0 0 1 6 0V7" /> },
  { id: 'library', label: '游戏库', icon: <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M3.5 9.5h17M8 4.5v5" /></> },
  { id: 'news', label: '社区', icon: <path d="M20.5 12a8.5 8.5 0 1 1-3.2-6.6M8.5 10.5h7M8.5 14h4.5" /> },
  { id: 'downloads', label: '下载', icon: <path d="M12 3v11m0 0 4.5-4.5M12 14l-4.5-4.5M4 18.5h16" /> },
  { id: 'settings', label: '设置', icon: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6" /></> },
];

export function Rail() {
  const view = useLauncher((s) => s.view);
  const setView = useLauncher((s) => s.setView);
  const active = useLauncher(
    (s) => s.downloads.some((d) => d.phase === 'downloading' || d.phase === 'queued'),
  );

  return (
    <nav className="rail">
      {NAV.map((n) => (
        <button
          key={n.id}
          className={`rail-btn ${view === n.id ? 'on' : ''}`}
          title={n.label}
          aria-label={n.label}
          onClick={() => setView(n.id)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {n.icon}
          </svg>
          {n.id === 'downloads' && active ? <span className="dot" style={{ background: 'var(--ok)', boxShadow: '0 0 10px var(--ok)' }} /> : null}
        </button>
      ))}
      <div className="rail-sep" />
      <div className="rail-sp" />
      <div className="avatar" title="玩家中心">K</div>
    </nav>
  );
}

/* ── statusbar ──────────────────────────────────────────────── */
export function StatusBar() {
  const conn = useLauncher((s) => s.conn);
  const taskCount = useLauncher(
    (s) => s.downloads.filter((d) => d.phase !== 'ready').length,
  );

  return (
    <footer className="status">
      <span className="live"><i />已连接 · {conn?.region ?? '—'}</span>
      <span>下载 {formatSpeed(conn?.speedBps ?? 0)}</span>
      <span>延迟 {conn?.latencyMs ?? '—'} ms</span>
      <span className="grow" />
      {taskCount > 0 ? <span>{taskCount} 个任务进行中</span> : null}
      <span style={conn?.controller ? { color: 'var(--acc-3)' } : undefined}>
        {conn?.controller ? '手柄已连接' : '手柄未连接'}
      </span>
      <span><kbd>F1</kbd> 帮助</span>
      <span>{conn?.clientVersion ?? '—'}</span>
    </footer>
  );
}

/* ── toasts ─────────────────────────────────────────────────── */
export function ToastStack() {
  const toasts = useLauncher((s) => s.toasts);
  const dismiss = useLauncher((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onClose={dismiss} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const close = useCallback(() => onClose(toast.id), [onClose, toast.id]);
  useEffect(() => {
    const h = window.setTimeout(close, toast.ms ?? 4200);
    return () => window.clearTimeout(h);
  }, [close, toast.ms]);

  return (
    <div className={`toast ${toast.kind}`}>
      <span className="dot" />
      <div className="t">
        <b>{toast.title}</b>
        {toast.detail ? <span>{toast.detail}</span> : null}
      </div>
      <button className="ico-btn" onClick={close} aria-label="关闭">✕</button>
    </div>
  );
}
