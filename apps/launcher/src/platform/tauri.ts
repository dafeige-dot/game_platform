/**
 * Tauri adapter — talks to the Rust shell over IPC.
 *
 * Command surface (to be implemented in src-tauri, next milestone):
 *   bootstrap            -> PlatformSnapshot
 *   download_action      -> { appId, action: install|update|pause|resume|cancel }
 *   launch_app           -> { appId }
 *   event launcher://event -> { type:'patch', patch } | { type:'toast', toast }
 *
 * If any Rust command is missing we fail loudly in dev (console) and the
 * factory in index.ts falls back to MockAdapter so the UI keeps running.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  type LauncherAPI,
  type LauncherEvents,
  type PlatformSnapshot,
} from './types';

export class TauriAdapter implements LauncherAPI {
  name = 'tauri';

  private ev!: LauncherEvents;
  private unlisten: UnlistenFn | null = null;

  async init(ev: LauncherEvents): Promise<void> {
    this.ev = ev;
    const initial = (await invoke<PlatformSnapshot>('bootstrap')) as PlatformSnapshot;
    this.ev.patch(initial);

    this.unlisten = await listen<{ type: 'patch'; patch: Partial<PlatformSnapshot> } | {
      type: 'toast';
      toast: Omit<import('./types').Toast, 'id'>;
    }>('launcher://event', ({ payload }) => {
      if (payload.type === 'patch') this.ev.patch(payload.patch);
      else this.ev.toast(payload.toast);
    });

    // Catalog is authoritative and async: never blocks first paint. A dead
    // server degrades to the local seed (the Rust side reports via toast).
    void invoke('refresh_catalog').catch((err) => console.warn('[tauri] refresh_catalog', err));
  }

  private action(appId: string, action: string): void {
    void invoke('download_action', { appId, action }).catch((err) => {
      console.warn(`[tauri] download_action(${action}) failed`, err);
      this.ev.toast({ kind: 'error', title: '命令失败', detail: String(err) });
    });
  }

  install(appId: string): void {
    this.action(appId, 'install');
  }
  update(appId: string): void {
    this.action(appId, 'update');
  }
  pause(appId: string): void {
    this.action(appId, 'pause');
  }
  resume(appId: string): void {
    this.action(appId, 'resume');
  }
  cancel(appId: string): void {
    this.action(appId, 'cancel');
  }
  launch(appId: string): void {
    void invoke('launch_app', { appId }).catch((err) => {
      this.ev.toast({ kind: 'error', title: '启动失败', detail: String(err) });
    });
  }

  dispose(): void {
    this.unlisten?.();
  }
}
