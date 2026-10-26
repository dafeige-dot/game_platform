//! Download engine (mock stage): the same state machine as
//! `src/platform/mock.ts`, ported so the IPC contract, event bridge and UI
//! are exercised under a real desktop shell.
//!
//! When the Rust CAS core lands, `tick` + `action` become a thin adapter over
//! the block store, and the fake speeds/sizes here disappear.

use crate::model::fmt_bytes;
use crate::model::{
    ConnectionInfo, EventPayload, GameApp, LibraryEntry, Patch, Phase, Snapshot, TaskDto, TaskKind,
    ToastDto, ToastKind, GB, MB,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const TICK_MS: u64 = 250;
const BASE_SPEED: u64 = 34 * MB; // aggregate, B/s
const MANIFEST_MS: i64 = 600;
const VERIFY_MS: i64 = 800;
const MATERIALIZE_PER_GB_MS: i64 = 700;
const THREADS: u64 = 12;
const CLIENT_VERSION: &str = "0.9.4";
const REGION: &str = "Singapore";

struct Task {
    kind: TaskKind,
    app_id: String,
    from_version: String,
    to_version: String,
    total: u64,
    done: u64,
    chunk_total: u64,
    chunk_done: u64,
    phase: Phase,
    speed: u64,
    phase_ms_left: i64,
}

struct Inner {
    games: Vec<GameApp>,
    library: BTreeMap<String, LibraryEntry>,
    tasks: Vec<Task>,
    conn: ConnectionInfo,
    rng: u64,
}

pub struct Engine {
    app: AppHandle,
    inner: Mutex<Inner>,
    next_toast: AtomicU64,
}

fn lcg(seed: u64) -> u64 {
    // Same recurrence as the TS side; display jitter only.
    seed.wrapping_mul(1103515245).wrapping_add(12345)
}

fn jitter(seed: u64) -> f64 {
    0.82 + ((seed & 0xffff_ffff) as f64 / u32::MAX as f64) * 0.4
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn seed_catalog() -> Vec<GameApp> {
    #[rustfmt::skip]
    fn g(app_id: &str, title: &str, latin: &str, sub: &str, genres: &[&str],
         glyph: &str, cover: &str, score: f64, players: u64, latest: &str,
         full: u64, delta: Option<u64>, installed: Option<&str>) -> GameApp {
        GameApp {
            app_id: app_id.into(), title: title.into(), latin_title: latin.into(),
            subtitle: sub.into(), genres: genres.iter().map(|s| s.to_string()).collect(),
            glyph: glyph.into(), cover: cover.into(), score, players,
            latest_version: latest.into(), full_size_bytes: full, delta_bytes: delta,
            installed_version: installed.map(|s| s.into()),
            demo: None,
        }
    }

    vec![
        g("1001", "星海回响", "STAR ECHO", "在坠落的星环上重建一座城。回合制战术 × 叙事冒险，全程手绘动画过场。",
          &["战术RPG", "剧情向", "手柄"], "星", "c1", 9.2, 128_400, "1.1.0",
          42_598_351_232, Some(3_117_000_000), Some("1.0.0")),
        g("1002", "夜行电台", "NIGHT RADIO", "凌晨三点的城市，只剩你和一个不肯挂断的来电。多结局悬疑文字冒险。",
          &["悬疑", "多结局", "配音"], "夜", "c2", 8.8, 84_100, "1.4.3",
          8_805_000_000, Some(39_845_888), Some("1.4.2")),
        g("1003", "苍蓝誓约", "AZURE VOW", "十二位舰灵，一段没有归途的航行。即时海战 + 养成，抢先体验开放。",
          &["海战", "养成", "Demo"], "蒼", "c3", 9.0, 71_200, "0.9.0-beta",
          19_762_000_000, Some(13_317_000_000), None),
        g("1004", "月蚀列车", "MOON TRAIN", "在永夜中穿行，下个站点的唯一小事：开出，或者祈祷。",
          &["肉鸽", "卡牌"], "蝕", "c4", 8.5, 56_800, "1.2.0",
          2_577_000_000, None, None),
        g("1005", "像素炼金术", "PIXEL ALCHEMY", "一间小铺子，一只会记账的猫，和一个总是迟到的春天。",
          &["模拟经营", "像素"], "煉", "c5", 8.1, 49_900, "0.9.4",
          1_180_600_000, None, Some("0.9.4")),
        g("1006", "空境航路", "SKYBOUND", "没有土地的世界，所有人的家都在云上。",
          &["冒险", "解谜"], "空", "c1", 8.9, 33_500, "2.0.0",
          7_301_000_000, None, None),
        g("1007", "猫与星图", "CAT & CHART", "给一只退休的航海猫一份新工作：重新绘制所有星座。",
          &["治愈", "收集"], "猫", "c2", 8.7, 21_700, "1.0.0",
          838_900_000, None, None),
        g("1008", "深海快递", "DEEP EXPRESS", "把货物送到一万人都不敢停靠的地方。",
          &["模拟", "策略"], "深", "c4", 8.4, 18_900, "2.0.2",
          10_306_000_000, None, Some("2.0.1")),
    ]
}

impl Engine {
    pub fn new(app: AppHandle) -> Self {
        let games = seed_catalog();

        let mut library = BTreeMap::new();
        for (idx, g) in games.iter().enumerate() {
            if let Some(v) = g.installed_version.clone() {
                library.insert(
                    g.app_id.clone(),
                    LibraryEntry {
                        app_id: g.app_id.clone(),
                        version: v,
                        size_bytes: (g.full_size_bytes as f64 * 0.94) as u64,
                        playtime_sec: if idx % 3 == 0 { 54 * 3600 } else { 7 * 3600 },
                        last_played_at: now_millis().checked_sub((idx as u64 + 1) * 3_600_000),
                    },
                );
            }
        }

        let mut tasks: Vec<Task> = Vec::new();
        if let Some(g) = games.iter().find(|g| g.app_id == "1001") {
            if g.installed_version.is_some() {
                tasks.push(Self::start_task(g, TaskKind::Update, 0.43));
            }
        }

        Self {
            app,
            next_toast: AtomicU64::new(1),
            inner: Mutex::new(Inner {
                games,
                library,
                tasks,
                conn: ConnectionInfo {
                    region: REGION.into(),
                    latency_ms: 24,
                    speed_bps: 0,
                    client_version: CLIENT_VERSION.into(),
                    controller: true,
                },
                rng: 0x9e37_79b9,
            }),
        }
    }

    fn start_task(game: &GameApp, kind: TaskKind, progress: f64) -> Task {
        let total = match kind {
            TaskKind::Install => game.delta_bytes.unwrap_or(game.full_size_bytes),
            TaskKind::Update => game.delta_bytes.unwrap_or(64 * MB),
        };
        let chunk_total = total.div_ceil(MB);
        Task {
            kind,
            app_id: game.app_id.clone(),
            from_version: match kind {
                TaskKind::Install => "—".to_string(),
                TaskKind::Update => game.installed_version.clone().unwrap_or_else(|| "—".into()),
            },
            to_version: game.latest_version.clone(),
            total,
            done: (total as f64 * progress) as u64,
            chunk_total,
            chunk_done: (chunk_total as f64 * progress) as u64,
            phase: if progress > 0.0 { Phase::Downloading } else { Phase::Queued },
            speed: 0,
            phase_ms_left: 300,
        }
    }

    /// 4 Hz loop; every tick publishes one whole-slice patch.
    pub fn start_loop(self: &Arc<Self>) {
        let engine = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
            engine.tick();
        });
    }

    pub fn tick(&self) {
        let mut finished: Vec<(String, TaskKind, String, u64)> = Vec::new();
        {
            let inner = &mut *self.inner.lock().unwrap();

            inner.rng = lcg(inner.rng);
            let j = jitter(inner.rng);

            for t in inner.tasks.iter_mut() {
                match t.phase {
                    Phase::Queued => {
                        t.phase_ms_left -= TICK_MS as i64;
                        if t.phase_ms_left <= 0 {
                            t.phase = Phase::Manifest;
                            t.phase_ms_left = MANIFEST_MS;
                        }
                    }
                    Phase::Manifest => {
                        t.speed = 0;
                        t.phase_ms_left -= TICK_MS as i64;
                        if t.phase_ms_left <= 0 {
                            t.phase = Phase::Downloading;
                            t.speed = BASE_SPEED;
                        }
                    }
                    Phase::Downloading => {
                        t.speed = (BASE_SPEED as f64 * j) as u64;
                        let moved = (t.speed * TICK_MS / 1000).min(t.total - t.done);
                        t.done += moved;
                        t.chunk_done =
                            ((t.done as f64 / t.total as f64) * t.chunk_total as f64).round() as u64;
                        if t.done >= t.total {
                            t.chunk_done = t.chunk_total;
                            t.phase = Phase::Materialize;
                            t.phase_ms_left = (MATERIALIZE_PER_GB_MS
                                * ((t.total as f64 / GB as f64).ceil() as i64))
                                .min(2800);
                            t.speed = 0;
                        }
                    }
                    Phase::Materialize => {
                        t.phase_ms_left -= TICK_MS as i64;
                        if t.phase_ms_left <= 0 {
                            t.phase = Phase::Verify;
                            t.phase_ms_left = VERIFY_MS;
                        }
                    }
                    Phase::Verify => {
                        t.phase_ms_left -= TICK_MS as i64;
                        if t.phase_ms_left <= 0 {
                            finished.push((
                                t.app_id.clone(),
                                t.kind,
                                t.to_version.clone(),
                                t.total,
                            ));
                            t.phase = Phase::Ready;
                        }
                    }
                    _ => {}
                }
            }

            inner.conn.latency_ms = 18 + (inner.rng % 160) / 10;
            inner.conn.speed_bps = inner
                .tasks
                .iter()
                .filter(|t| t.phase == Phase::Downloading)
                .map(|t| t.speed)
                .sum();
        }

        self.emit_patch();

        if finished.is_empty() {
            return;
        }

        let toasts: Vec<(ToastKind, String, Option<String>)> = {
            let inner: &mut Inner = &mut *self.inner.lock().unwrap();
            let mut out = Vec::new();
            for (app_id, kind, version, total) in &finished {
                inner
                    .tasks
                    .retain(|t| !(t.app_id == *app_id && t.phase == Phase::Ready));
                let entry_prev = inner.library.get(app_id).cloned();
                if let Some(g) = inner.games.iter_mut().find(|g| g.app_id == *app_id) {
                    g.installed_version = Some(version.clone());
                    inner.library.insert(
                        app_id.clone(),
                        LibraryEntry {
                            app_id: app_id.clone(),
                            version: version.clone(),
                            size_bytes: entry_prev.as_ref().map_or(g.full_size_bytes, |p| p.size_bytes),
                            playtime_sec: entry_prev.as_ref().map_or(0, |p| p.playtime_sec),
                            last_played_at: entry_prev.as_ref().and_then(|p| p.last_played_at),
                        },
                    );
                }
                let title = inner
                    .games
                    .iter()
                    .find(|g| g.app_id == *app_id)
                    .map(|g| g.title.clone())
                    .unwrap_or_default();
                let reuse = 88 + (lcg(now_millis() + lcg(title.len() as u64 + 1)) % 9);
                out.push((
                    ToastKind::Success,
                    if *kind == TaskKind::Install {
                        format!("{title} · 预下载完成")
                    } else {
                        format!("{title} · 已更新至 v{version}")
                    },
                    Some(format!("增量 {}，本地分块复用 {reuse}%", fmt_bytes(*total))),
                ));
            }
            out
        };
        for (kind, title, detail) in toasts {
            self.toast(kind, title, detail);
        }
    }

    fn dl(tasks: &[Task], games: &[GameApp]) -> Vec<TaskDto> {
        tasks
            .iter()
            .map(|t| TaskDto {
                title: games
                    .iter()
                    .find(|g| g.app_id == t.app_id)
                    .map(|g| g.title.clone())
                    .unwrap_or_else(|| t.app_id.clone()),
                app_id: t.app_id.clone(),
                kind: t.kind,
                from_version: t.from_version.clone(),
                to_version: t.to_version.clone(),
                total_bytes: t.total,
                done_bytes: t.done,
                chunk_total: t.chunk_total,
                chunk_done: t.chunk_done,
                thread_count: THREADS,
                phase: t.phase,
                speed_bps: t.speed,
                error: None,
            })
            .collect()
    }

    fn toast(&self, kind: ToastKind, title: String, detail: Option<String>) {
        let _ = self.app.emit(
            "launcher://event",
            EventPayload::Toast {
                toast: ToastDto {
                    id: self.next_toast.fetch_add(1, Ordering::Relaxed),
                    kind,
                    title,
                    detail,
                },
            },
        );
    }

    /// Public toast entry for command modules.
    pub fn push_toast(&self, kind: ToastKind, title: impl Into<String>, detail: Option<String>) {
        self.toast(kind, title.into(), detail);
    }

    /// Replace the games list with an authoritative catalog. Local install
    /// state (installedVersion) wins over whatever the catalog claims.
    pub fn apply_catalog(&self, mut games: Vec<GameApp>) -> usize {
        let mut inner = self.inner.lock().unwrap();
        for g in games.iter_mut() {
            if let Some(existing) = inner.games.iter().find(|x| x.app_id == g.app_id) {
                g.installed_version = existing.installed_version.clone();
            }
        }
        let n = games.len();
        inner.games = games;
        drop(inner);
        self.emit_patch();
        n
    }

    fn emit_patch(&self) {
        let inner = self.inner.lock().unwrap();
        let patch = Patch {
            games: inner.games.clone(),
            library: inner.library.clone(),
            downloads: Self::dl(&inner.tasks, &inner.games),
            conn: inner.conn.clone(),
        };
        drop(inner);
        let _ = self.app.emit("launcher://event", EventPayload::Patch { patch });
    }

    pub fn snapshot(&self) -> Snapshot {
        let inner = self.inner.lock().unwrap();
        Snapshot {
            games: inner.games.clone(),
            library: inner.library.clone(),
            downloads: Self::dl(&inner.tasks, &inner.games),
            conn: inner.conn.clone(),
        }
    }

    pub fn action(&self, app_id: &str, cmd: &str) -> Result<(), String> {
        match cmd {
            "install" | "update" => self.start(app_id, cmd),
            "pause" => {
                self.pause(app_id);
                Ok(())
            }
            "resume" => {
                self.resume(app_id);
                Ok(())
            }
            "cancel" => {
                self.cancel(app_id);
                Ok(())
            }
            _ => Err(format!("unknown action: {cmd}")),
        }
    }

    fn start(&self, app_id: &str, cmd: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .tasks
            .iter()
            .any(|t| t.app_id == app_id && t.phase != Phase::Failed)
        {
            return Ok(());
        }
        let game = inner
            .games
            .iter()
            .find(|g| g.app_id == app_id)
            .cloned()
            .ok_or_else(|| "unknown app".to_string())?;

        if cmd == "update" {
            if game.installed_version.is_none() {
                return Err("not installed".into());
            }
            let (delta, full, title) =
                (game.delta_bytes.unwrap_or(64 * MB), game.full_size_bytes, game.title.clone());
            inner.tasks.push(Self::start_task(&game, TaskKind::Update, 0.0));
            drop(inner);
            self.toast(
                ToastKind::Info,
                format!("{title} · 更新中"),
                Some(format!("只需 {}，而不是全量 {}", fmt_bytes(delta), fmt_bytes(full))),
            );
        } else {
            let (full, title) = (game.full_size_bytes, game.title.clone());
            inner.tasks.push(Self::start_task(&game, TaskKind::Install, 0.0));
            drop(inner);
            self.toast(
                ToastKind::Info,
                format!("{title} · 已加入预下载队列"),
                Some(format!("全量 {}（首发会做分块校验，断网可续传）", fmt_bytes(full))),
            );
        }
        Ok(())
    }

    fn pause(&self, app_id: &str) {
        {
            let inner = &mut *self.inner.lock().unwrap();
            for t in inner.tasks.iter_mut().filter(|t| t.app_id == app_id) {
                t.phase = Phase::Paused;
                t.speed = 0;
            }
        }
        self.emit_patch();
    }

    fn resume(&self, app_id: &str) {
        let mut resumed = false;
        {
            let inner = &mut *self.inner.lock().unwrap();
            for t in inner
                .tasks
                .iter_mut()
                .filter(|t| t.app_id == app_id && t.phase == Phase::Paused)
            {
                t.phase = Phase::Downloading;
                resumed = true;
            }
        }
        if resumed {
            let title = self.title_of(app_id);
            self.toast(
                ToastKind::Info,
                format!("{title} · 已续传"),
                Some("已完成的分块不会重下".into()),
            );
        }
        self.emit_patch();
    }

    fn cancel(&self, app_id: &str) {
        let removed = {
            let inner = self.inner.lock().unwrap();
            inner
                .tasks
                .iter()
                .find(|t| t.app_id == app_id)
                .map(|t| (t.kind, ))
        };
        let title = self.title_of(app_id);
        {
            let inner = &mut *self.inner.lock().unwrap();
            inner.tasks.retain(|t| t.app_id != app_id);
        }
        if let Some((kind,)) = removed {
            self.toast(
                ToastKind::Info,
                format!("{title} · 已取消"),
                Some(
                    if kind == TaskKind::Update {
                        "本地分块已保留，下次更新更快"
                    } else {
                        "预下载已释放"
                    }
                    .into(),
                ),
            );
        }
        self.emit_patch();
    }

    /* ── real-engine self-check task (visible in the queue UI) ───── */

    /// Make room for a task driven by the real CAS runtime.
    pub fn dev_task_begin(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.tasks.retain(|t| t.app_id != "selfcheck");
        inner.tasks.push(Task {
            kind: TaskKind::Install,
            app_id: "selfcheck".into(),
            from_version: "—".into(),
            to_version: "v1.0.0".into(),
            total: 0,
            done: 0,
            chunk_total: 0,
            chunk_done: 0,
            phase: Phase::Manifest,
            speed: 0,
            phase_ms_left: 0,
        });
        drop(inner);
        self.emit_patch();
    }

    /// Progress from the real install pipeline (InstallEvent).
    pub fn dev_task_progress(&self, done: u64, total: u64, chunks_done: u64, chunks_total: u64, speed: u64, phase: Phase) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(t) = inner.tasks.iter_mut().find(|t| t.app_id == "selfcheck") {
            t.total = total;
            t.done = done;
            t.chunk_total = chunks_total;
            t.chunk_done = chunks_done;
            t.speed = speed;
            t.phase = phase;
        }
        drop(inner);
        self.emit_patch();
    }

    pub fn dev_task_finish(&self, note: String) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.tasks.retain(|t| t.app_id != "selfcheck");
        }
        self.emit_patch();
        self.toast(ToastKind::Success, "真实引擎自检安装完成".into(), Some(note));
    }

    pub fn dev_task_fail(&self, err: String) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.tasks.retain(|t| t.app_id != "selfcheck");
        }
        self.emit_patch();
        self.toast(ToastKind::Error, "真实引擎自检失败".into(), Some(err));
    }

    fn title_of(&self, app_id: &str) -> String {
        let inner = self.inner.lock().unwrap();
        inner
            .games
            .iter()
            .find(|g| g.app_id == app_id)
            .map(|g| g.title.clone())
            .unwrap_or_else(|| app_id.to_string())
    }

    pub fn launch(&self, app_id: &str) {
        let info = {
            let inner = self.inner.lock().unwrap();
            inner.games.iter().find(|g| g.app_id == app_id).and_then(|g| {
                let playable = g.installed_version.is_none()
                    || g.latest_version != g.installed_version.clone().unwrap()
                    || inner.tasks.iter().any(|t| t.app_id == app_id);
                playable.then(|| (g.title.clone(), g.installed_version.clone()))
            })
        };
        let Some((title, installed)) = info else { return };

        if installed.is_none() {
            self.toast(ToastKind::Error, "尚未安装".into(), Some("先完成安装或预下载".into()));
            return;
        }

        self.toast(
            ToastKind::Success,
            format!("{title} 正在启动"),
            Some("进程已挂起平台元数据：好友、时长、截图".into()),
        );

        // Real core lands here: spawn Command::new(installed_entrypoint).
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(7));
            let _ = app.emit(
                "launcher://event",
                json!({
                    "type": "toast",
                    "toast": {
                        "id": now_millis(),
                        "kind": "info",
                        "title": format!("会话结束 · {title}"),
                        "detail": "时长已同步云端"
                    }
                }),
            );
        });
    }
}
