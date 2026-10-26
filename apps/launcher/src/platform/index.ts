import { MockAdapter } from './mock';
import { TauriAdapter } from './tauri';
import { type LauncherAPI, type LauncherEvents } from './types';

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type AdapterMode = 'tauri' | 'mock';

export interface AdapterInfo {
  api: LauncherAPI;
  mode: AdapterMode;
  note?: string;
}

/**
 * Pick the real backend when we are inside the Tauri shell. Anything else
 * (vite dev / plain browser) gets the mock on purpose, not by accident, and
 * the status bar shows which mode is running.
 */
export async function createAdapter(events: LauncherEvents): Promise<AdapterInfo> {
  if (!isTauri) {
    const api = new MockAdapter();
    await api.init(events);
    return {
      api,
      mode: 'mock',
      note: '浏览器开发模式：数据为模拟 CDN，状态机与真实客户端一致',
    };
  }

  try {
    const api = new TauriAdapter();
    await api.init(events);
    return { api, mode: 'tauri' };
  } catch (err) {
    const api = new MockAdapter();
    await api.init(events);
    return {
      api,
      mode: 'mock',
      note: `Tauri 后端未就绪（${String(err).slice(0, 120)}），已回退 Mock`,
    };
  }
}
