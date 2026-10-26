import { useEffect, useMemo, useState } from 'react';
import type { GameApp } from '../platform/types';
import { useLauncher } from '../store/useLauncher';
import { ActionButton, Spark, trend } from './shared';

/* ── hero ───────────────────────────────────────────────────── */

function fmtShort(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n)} B`;
}

function phaseText(p: string): string {
  const map: Record<string, string> = {
    queued: '排队', manifest: '清单', downloading: '下载中', materialize: '拼装', verify: '校验',
  };
  return map[p] ?? p;
}

function actionKind(g: GameApp): 'play' | 'update' | 'install' {
  if (!g.installedVersion) return 'install';
  if (g.latestVersion !== g.installedVersion) return 'update';
  return 'play';
}

function heroLabel(g: GameApp, task?: { phase: string; doneBytes: number; totalBytes: number }): string {
  if (task) {
    return `${phaseText(task.phase)} ${Math.round((task.doneBytes / task.totalBytes) * 100)}%`;
  }
  const k = actionKind(g);
  if (k === 'install') return `预下载 ${fmtShort(g.deltaBytes ?? g.fullSizeBytes)}`;
  if (k === 'update') return `开始更新 ${fmtShort(g.deltaBytes ?? 0)}`;
  return '开始游戏';
}

export function HeroCarousel() {
  const games = useLauncher((s) => s.games);
  const downloads = useLauncher((s) => s.downloads);
  const toast = useLauncher((s) => s.toast);
  const install = useLauncher((s) => s.install);
  const update = useLauncher((s) => s.update);
  const launch = useLauncher((s) => s.launch);

  const featured = useMemo(() => games.filter((g) => g.rank && g.rank <= 3), [games]);
  const [cur, setCur] = useState(0);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (hover || featured.length < 2) return undefined;
    const h = window.setInterval(() => setCur((c) => (c + 1) % featured.length), 7000);
    return () => window.clearInterval(h);
  }, [hover, featured.length]);

  return (
    <section className="hero" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {featured.map((g, i) => {
        const task = downloads.find((d) => d.appId === g.appId);
        const kind = actionKind(g);
        return (
          <div key={g.appId} className={`slide ${i === cur ? 'on' : ''}`} data-i={i}>
            <div className="art" />
            <div className="hero-grid" />
            <div className="scan" />
            <div className="kanji">{g.glyph}</div>
            <div className="glow-line" />
            <div className="hero-copy">
              <div className="kicker">
                <b>
                  {!g.installedVersion
                    ? '抢先体验'
                    : g.latestVersion !== g.installedVersion
                      ? '新版本已发布'
                      : '编辑精选'}
                </b>
                <span>{g.latinTitle} · v{g.latestVersion}</span>
              </div>
              <h1><em>{g.title}</em></h1>
              <p className="sub">{g.subtitle}</p>
              <div className="tags">
                {g.genres.map((x) => (
                  <span key={x} className="tag">{x}</span>
                ))}
                {g.installedVersion && g.latestVersion !== g.installedVersion
                  ? <span className="tag hot">增量更新 · 只传改动</span>
                  : null}
              </div>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={Boolean(task)}
                  onClick={() =>
                    kind === 'play'
                      ? launch(g.appId)
                      : kind === 'update'
                        ? update(g.appId)
                        : install(g.appId)}
                >
                  {heroLabel(g, task)}
                </button>
                <button
                  className="btn ghost"
                  onClick={() =>
                    toast({ kind: 'info', title: `${g.title} · 已加入愿望单`, detail: '降价与发售时会推送' })}
                >
                  加入愿望单
                </button>
              </div>
            </div>
          </div>
        );
      })}
      <div className="hero-dots">
        {featured.map((_, i) => (
          <i key={i} className={i === cur ? 'on' : ''} onClick={() => setCur(i)} />
        ))}
      </div>
    </section>
  );
}

/* ── store page ─────────────────────────────────────────────── */

const FILTERS = ['全部', '战术RPG', '悬疑', '肉鸽', '模拟经营', '治愈'] as const;
const SPARK_COLORS = ['#ff4fa3', '#35e6ff', '#4ff0b7', '#ffb545', '#9d7bff'];

export function StoreView() {
  const games = useLauncher((s) => s.games);
  const downloads = useLauncher((s) => s.downloads);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部');

  const list = useMemo(() => {
    let out = [...games].sort((a, b) => (b.rank ?? 99) - (a.rank ?? 99));
    if (filter !== '全部') out = out.filter((g) => g.genres.includes(filter));
    const needle = q.trim();
    if (needle) {
      out = out.filter(
        (g) => g.title.includes(needle) || g.latinTitle.toLowerCase().includes(needle.toLowerCase()),
      );
    }
    return out.slice(0, 4);
  }, [games, filter, q]);

  const trending = useMemo(
    () => games.filter((g) => g.rank).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).slice(0, 5),
    [games],
  );

  return (
    <>
      <div className="topbar">
        <label className="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
          </svg>
          <input placeholder="搜索游戏、开发者、标签…" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd>Ctrl K</kbd>
        </label>
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      <HeroCarousel />

      <div className="sec-head">
        <h2>{q ? '搜索结果' : '新游推荐'}</h2>
        <span className="en">New Arrivals</span>
        <span className="more">查看全部 →</span>
      </div>

      <div className="row">
        {list.map((g) => (
          <article
            key={g.appId}
            className="card"
            style={downloads.some((d) => d.appId === g.appId) ? { borderColor: 'rgba(53,230,255,.45)' } : undefined}
          >
            <div className="badge new">NEW</div>
            {g.demo ? <div className="badge warn">演示数据</div> : null}
            <div className="score">{g.score.toFixed(1)}</div>
            <div className="cover" data-cover={g.cover}>
              <div className="glyph">{g.glyph}</div>
              <div className="sheen" />
            </div>
            <div className="meta">
              <h3>{g.title}</h3>
              <p>{g.latinTitle}</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <ActionButton game={g} small />
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="sec-head">
        <h2>本周热榜</h2>
        <span className="en">Trending</span>
        <span className="more">榜单规则 →</span>
      </div>

      <div className="split">
        <div className="panel rank">
          {trending.map((g, i) => (
            <div className="rank-row" key={g.appId}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <span className="thumb" data-cover={g.cover} aria-hidden />
              <div className="info">
                <b>{g.title}</b>
                <span>{g.genres[0]} · {(g.players / 10000).toFixed(1)} 万人在玩</span>
              </div>
              <Spark points={trend(i + 3)} color={SPARK_COLORS[i % SPARK_COLORS.length]} />
            </div>
          ))}
        </div>

        <div className="panel ops">
          <h3>进行中的活动</h3>
          <div className="event">
            <strong>秋季独立游戏节</strong>
            <span>38 款独立作品限时 −40%，含 6 款首发</span>
            <span className="go">剩余 4 天 →</span>
          </div>
          <div className="event teal">
            <strong>云存档 2.0 上线</strong>
            <span>跨设备秒同步，冲突自动保留双版本</span>
            <span className="go">了解详情 →</span>
          </div>
        </div>
      </div>
    </>
  );
}
