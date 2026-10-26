import { useMemo, useState } from 'react';
import type { GameApp, LibraryEntry } from '../platform/types';
import { formatBytes } from '../platform/types';
import { useLauncher } from '../store/useLauncher';
import { ActionButton } from './shared';

const MAX_PLAY_SHOWN = 160 * 3600; // play bar ceiling in seconds

interface Item {
  entry: LibraryEntry;
  game: GameApp;
}

function hours(sec: number): string {
  return sec >= 3600 ? `${Math.floor(sec / 3600)} 小时` : `${Math.round(sec / 60)} 分钟`;
}

function relative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 6e4) return '刚刚';
  if (diff < 36e5) return `${Math.round(diff / 6e4)} 分钟前`;
  if (diff < 86400e3) return `${Math.round(diff / 36e5)} 小时前`;
  return `${Math.round(diff / 86400e3)} 天前`;
}

export function LibraryView() {
  const games = useLauncher((s) => s.games);
  const library = useLauncher((s) => s.library);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'update' | 'recent'>('all');

  const items = useMemo<Item[]>(() => {
    let out: Item[] = Object.values(library)
      .map((entry) => ({ entry, game: games.find((g) => g.appId === entry.appId) }))
      .filter((x): x is Item => Boolean(x.game));
    if (only === 'update') out = out.filter((x) => x.game.latestVersion !== x.entry.version);
    if (only === 'recent') {
      out = [...out].sort((a, b) => (b.entry.lastPlayedAt ?? 0) - (a.entry.lastPlayedAt ?? 0)).slice(0, 4);
    }
    const needle = q.trim();
    if (needle) out = out.filter((x) => x.game.title.includes(needle));
    return out;
  }, [games, library, only, q]);

  return (
    <>
      <div className="topbar">
        <label className="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
          </svg>
          <input placeholder="搜索库中的游戏…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="chips">
          <button className={`chip ${only === 'all' ? 'on' : ''}`} onClick={() => setOnly('all')}>
            全部 {Object.keys(library).length}
          </button>
          <button className={`chip ${only === 'update' ? 'on' : ''}`} onClick={() => setOnly('update')}>有更新</button>
          <button className={`chip ${only === 'recent' ? 'on' : ''}`} onClick={() => setOnly('recent')}>最近游玩</button>
        </div>
      </div>

      <div className="sec-head">
        <h2>我的库</h2>
        <span className="en">Library</span>
        <span className="more">
          {formatBytes(Object.values(library).reduce((n, e) => n + e.sizeBytes, 0))} 已安装
        </span>
      </div>

      <div className="lib-grid">
        {items.map(({ entry, game }) => {
          const needUpdate = game.latestVersion !== entry.version;
          return (
            <div className="lib-item" key={entry.appId}>
              <div className="bar-top" data-cover={game.cover} />
              <div className="lib-row">
                <div className="cover" data-cover={game.cover}>
                  <div className="glyph">{game.glyph}</div>
                </div>
                <div className="lib-info">
                  <b>{game.title}</b>
                  <span>
                    v{entry.version}
                    {needUpdate ? ` → v${game.latestVersion} 可用` : ' · 已是最新'}
                  </span>
                </div>
              </div>
              <div className="playbar">
                <i style={{ width: `${Math.min(100, (entry.playtimeSec / MAX_PLAY_SHOWN) * 100)}%` }} />
              </div>
              <div className="lib-foot">
                <span className="lib-stat"><b>{hours(entry.playtimeSec)}</b></span>
                <span className="lib-stat">
                  {entry.lastPlayedAt ? `上次 ${relative(entry.lastPlayedAt)}` : '从未启动'}
                </span>
                <div style={{ flex: 1 }} />
                <ActionButton game={game} small />
              </div>
            </div>
          );
        })}
      </div>

      {items.length === 0 ? (
        <div className="aside-empty">
          没有匹配的内容。<br />去商店逛逛，或把已有游戏拖进来（本地导入在下一个里程碑）。
        </div>
      ) : null}
    </>
  );
}
