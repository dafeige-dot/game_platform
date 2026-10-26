import type { DownloadTask } from '../platform/types';
import { formatBytes, formatEta, formatSpeed, phaseLabel } from '../platform/types';
import { useLauncher } from '../store/useLauncher';

/* ── aside queue + friends ──────────────────────────────────── */

const FRIENDS: { name: string; note: string; last: string; grad: string; state: '' | 'idle' | 'off' }[] = [
  { name: 'Hoshino', note: '星海回响 · 第 3 章', last: '', grad: 'linear-gradient(140deg,#3a2a6b,#6b2a5c)', state: '' },
  { name: 'Kirisame', note: '在主菜单', last: '', grad: 'linear-gradient(140deg,#1b3a5c,#2a6b6b)', state: '' },
  { name: 'Akira', note: '闲置 14 分钟', last: '', grad: 'linear-gradient(140deg,#5c3a1b,#6b2a2a)', state: 'idle' },
  { name: 'Yuki', note: '离线 · 3 小时前', last: '', grad: 'linear-gradient(140deg,#26243a,#3a3450)', state: 'off' },
];

export function Aside() {
  const downloads = useLauncher((s) => s.downloads);
  const install = useLauncher((s) => s.install);
  const toast = useLauncher((s) => s.toast);
  const setView = useLauncher((s) => s.setView);
  const active = downloads.filter((d) => d.phase !== 'ready');

  return (
    <aside className="aside">
      <div className="aside-head">
        <h2>下载队列</h2>
        {active.length ? <span className="count">{active.length}</span> : null}
        <button className="ico-btn" onClick={() => setView('downloads')}>⋯</button>
      </div>

      {active.length === 0 ? (
        <div className="aside-empty">
          队列空闲。<br />
          内容寻址分块缓存仍在工作：<br />
          <b style={{ color: 'var(--text)' }}>重装秒装 · 更新只传改动</b>
        </div>
      ) : (
        active.map((d) => (
          <TaskCard key={d.appId} task={d} compact />
        ))
      )}

      <div className="aside-head" style={{ marginTop: 6 }}>
        <h2>好友在线</h2>
        <span className="count">{FRIENDS.filter((f) => f.state !== 'off').length}</span>
        <button className="ico-btn" onClick={() => toast({ kind: 'info', title: '好友添加', detail: '搜索用户 · 临时分组（下个里程碑）' })}>+</button>
      </div>

      {FRIENDS.map((f) => (
        <div className={`friend ${f.state}`} key={f.name} onClick={() => toast({ kind: 'info', title: `和 ${f.name} 组队`, detail: '好友邀请已发送' })}>
          <span className="av" style={{ background: f.grad }} />
          <div className="n">
            <b>{f.name}</b>
            <span>{f.note}</span>
          </div>
          <span className="play">加入</span>
        </div>
      ))}

      <div className="panel ops" style={{ marginTop: 'auto' }}>
        <h3>提示</h3>
        <button className="btn ghost" style={{ justifyContent: 'center' }} onClick={() => install('1001')}>
          试试安装一款游戏
        </button>
      </div>
    </aside>
  );
}

/* ── task card, compact (aside) and full (downloads page) ───── */

export function TaskCard({ task, compact = false }: { task: DownloadTask; compact?: boolean }) {
  const pause = useLauncher((s) => s.pause);
  const resume = useLauncher((s) => s.resume);
  const cancel = useLauncher((s) => s.cancel);
  const run = task.phase !== 'paused' && task.phase !== 'verify' && task.phase !== 'materialize';
  const pct = Math.min(100, (task.doneBytes / task.totalBytes) * 100);
  const eta = task.phase === 'downloading' && task.speedBps > 0
    ? formatEta(((task.totalBytes - task.doneBytes) / task.speedBps) * 1000) + ''
    : '—';

  const inner = (
    <>
      <div className="head">
        <span className="thumb" data-cover={coverOf(task)} aria-hidden />
        <div className="t">
          <b>{task.title}</b>
          <span>
            {task.kind === 'install' ? `预下载 v${task.toVersion}` : `v${task.fromVersion} → v${task.toVersion}`} ·{' '}
            {Math.min(100, Math.round((task.doneBytes / task.totalBytes) * 100))}%
          </span>
        </div>
        <span className={`phase ${task.phase === 'paused' ? 'paused' : ''}`}>{phaseLabel[task.phase]}</span>
        <div className="ictl">
          {task.phase === 'paused' ? (
            <button className="ico-btn" title="继续" onClick={() => resume(task.appId)}>▶</button>
          ) : (
            <button className="ico-btn" title="暂停" disabled={!run} onClick={() => pause(task.appId)}>⏸</button>
          )}
          <button className="ico-btn danger" title="取消" onClick={() => cancel(task.appId)}>✕</button>
        </div>
      </div>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="foot">
        <span>
          {formatSpeed(task.speedBps)} · 剩余 {eta}
        </span>
        <span>
          {task.chunkDone}/{task.chunkTotal} 分块
        </span>
      </div>
    </>
  );

  if (compact) {
    return (
      <div className={`task ${task.phase === 'downloading' ? 'running' : ''}`}>
        {inner}
      </div>
    );
  }
  return (
    <div className="dl-task">
      <div className="head">
        <span className="thumb" data-cover={coverOf(task)} aria-hidden />
        <div className="t">
          <h3>{task.title}</h3>
          <p>
            {task.kind === 'install' ? '全新安装' : '增量更新'} · 内容寻址 · 待传输{' '}
            {formatBytes(task.totalBytes)}（其余部分已在本缓存中命中）
          </p>
        </div>
      </div>
      {inner}
      <div className="dl-nums">
        <div className="dl-num"><b>{formatSpeed(task.speedBps)}</b><span>实时速率</span></div>
        <div className="dl-num"><b>{formatBytes(task.totalBytes)}</b><span>待传输</span></div>
        <div className="dl-num"><b>{task.threadCount}</b><span>线程</span></div>
        <div className="dl-num"><b>{eta}</b><span>预计剩余</span></div>
      </div>
    </div>
  );
}

function coverOf(task: { appId: string }): string {
  const s = useLauncher.getState();
  const g = s.games.find((x) => x.appId === task.appId);
  return g?.cover ?? 'c1';
}

/* ── downloads page ─────────────────────────────────────────── */

export function DownloadsView() {
  const downloads = useLauncher((s) => s.downloads);
  const library = useLauncher((s) => s.library);
  const toast = useLauncher((s) => s.toast);

  const installed = Object.values(library);
  const totalInstalled = installed.reduce((n, e) => n + e.sizeBytes, 0);

  return (
    <>
      <div className="sec-head" style={{ marginTop: 0 }}>
        <h2>下载与存储</h2>
        <span className="en">Downloads</span>
        <span className="more" onClick={() => toast({ kind: 'info', title: '限速设置', detail: '空闲时段自动更新 / 限速曲线（设置页，两个里程碑后）' })}>
          下载设置 →
        </span>
      </div>

      <div className="dl-grid">
        <div>
          {downloads.map((d) => (
            <TaskCard key={d.appId} task={d} />
          ))}
          {downloads.length === 0 ? (
            <div className="aside-empty">
              队列空闲。<br />
              有更新可领取时，会自动出现在这里并按策略静默更新。
            </div>
          ) : null}
        </div>

        <div className="panel storage">
          <h3>本地 CAS 存储</h3>
          <div className="store-row"><span className="n">已安装 · {installed.length} 款</span><b>{formatBytes(totalInstalled)}</b></div>
          <div className="store-row"><span className="n">共享分块缓存</span><b>与上面高度重叠</b></div>
          <div className="store-row"><span className="n">可回收（引用计数 0）</span><b>空闲时段自动</b></div>
          <button
            className="btn ghost small"
            style={{ marginTop: 8 }}
            onClick={() => toast({ kind: 'info', title: 'GC 已计划', detail: '引用计数为 0 的分块将在空闲时段回收' })}
          >
            回收未引用分块
          </button>
          <p style={{ fontSize: 10.5, color: 'var(--faint)', lineHeight: 1.7, marginTop: 10 }}>
            分块按内容寻址（id = sha256(明文)），多款游戏共用同一缓存，被杀进程也不丢进度；
            磁盘放大和“为什么更新只要 3 GB”的疑问都在此化解。
          </p>
        </div>
      </div>
    </>
  );
}
