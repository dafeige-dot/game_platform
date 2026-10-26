import { useEffect, useRef, useState } from 'react';
import { useLauncher } from './store/useLauncher';
import { Rail, StatusBar, TitleBar, ToastStack } from './components/Chrome';
import { StoreView } from './components/StoreView';
import { LibraryView } from './components/LibraryView';
import { Aside, DownloadsView } from './components/DownloadsView';

export default function App() {
  const ready = useLauncher((s) => s.ready);
  const view = useLauncher((s) => s.view);
  const boot = useLauncher((s) => s.boot);
  const spot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    const el = spot.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      el.style.opacity = '1';
      el.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

  if (!ready) {
    return (
      <>
        <div className="bg" />
        <div className="boot">
          <div className="mark"><i style={{ width: 34, height: 34 }} /><span>STELLAR</span></div>
          <p>正在连接平台后端…</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bg" />
      <div className="spot" ref={spot} />
      <div className="app">
        <TitleBar />
        <div className="shell">
          <Rail />
          <main className="main">
            {view === 'store' ? <StoreView /> : null}
            {view === 'library' ? <LibraryView /> : null}
            {view === 'downloads' ? <DownloadsView /> : null}
            {view === 'news' ? <NewsView /> : null}
            {view === 'settings' ? <SettingsView /> : null}
          </main>
          <Aside />
        </div>
        <StatusBar />
      </div>
      <ToastStack />
    </>
  );
}

function NewsView() {
  const setView = useLauncher((s) => s.setView);
  return (
    <div className="aside-empty" style={{ padding: 40, alignSelf: 'auto' }}>
      <h2 style={{ letterSpacing: '.1em', marginBottom: 14 }}>社区（规划中）</h2>
      <p style={{ lineHeight: 1.9 }}>
        动态 Feed、评测（带游玩时长权重）、成就与车队邀请都会落在这里。<br />
        现在可以先回去看看 <b style={{ color: 'var(--text)' }} onClick={() => setView('store')}>商店</b>。
      </p>
    </div>
  );
}

function SettingsView() {
  const setView = useLauncher((s) => s.setView);
  const mode = useLauncher((s) => s.mode);
  const toast = useLauncher((s) => s.toast);
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [target, setTarget] = useState('');

  const selfCheck = async () => {
    if (!isDesktop) {
      toast({ kind: 'info', title: '桌面端功能', detail: '真实引擎自检只在 Tauri 壳里运行' });
      return;
    }
    const raw = target.trim();
    const isUrl = /^https?:\/\//i.test(raw);
    const base_url = isUrl ? raw : undefined;
    const repo_dir = raw && !isUrl ? raw : undefined;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cas_selfinstall', { app_id: '1001', base_url, repo_dir: base_url ? undefined : repo_dir });
    } catch (err) {
      toast({ kind: 'error', title: '自检启动失败', detail: String(err) });
    }
  };

  return (
    <div className="aside-empty" style={{ padding: 40, alignSelf: 'auto' }}>
      <h2 style={{ letterSpacing: '.1em', marginBottom: 14 }}>设置（规划中）</h2>
      <p style={{ lineHeight: 1.9 }}>
        当前后端：<b style={{ color: 'var(--acc, #7c5cff)' }}>{mode ?? '—'}</b> ·
        引擎：<b style={{ color: 'var(--acc-3, #35e6ff)' }}>cas-core-rs</b><br />
        安装路径 / 限速 / 开机自启 / 静默更新 / 成就私密档<br />
        <span style={{ cursor: 'pointer' }} onClick={() => setView('downloads')}>下载与存储 →</span>
      </p>

      <label style={{ display: 'block', fontSize: 11, color: '#8e8cad', margin: '10px 0 6px' }}>
        分发源（留空 = 内置签名仓库 · 输入路径用 LocalFetcher · 输入 http(s):// 用 HttpFetcher）
      </label>
      <input
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="D:\repo 或 http://127.0.0.1:8787"
        style={{ width: '100%', maxWidth: 420, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(255,255,255,.04)', color: 'var(--text)', outline: 'none' }}
      />

      <button className="btn primary" style={{ marginTop: 12 }} onClick={selfCheck}>
        真实引擎自检安装 → %LOCALAPPDATA%\Stellar\dev-install
      </button>

      <p style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: 10, lineHeight: 1.7 }}>
        HTTP 源先跑：<code>npm run cas serve packages/cas-core-rs/tests/fixtures/repo --port 8787</code>
        ——调用 cas-core-rs 的 HttpFetcher（与生产 CDN 同一契约），进度在任务队列可见。
      </p>
    </div>
  );
}
