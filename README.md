# Platform — M0 技术验证

PC 优先、面向海外的游戏平台。当前仓库里是**风险最高那一环的可运行验证**：
内容寻址（CAS）分发 + 签名 manifest + 断点续传下载 + 增量更新 + 修复。

没有一行是 PPT：`npm test` 8 项全过，`npm run demo` 会真实跑完
「打包 → 安装 → 改资源 → 发布新版本 → 增量更新 → 篡改检测 → 修复」。

```
$ node --no-warnings tools/demo.mjs
v1 source      38.0 MiB
v2 source      46.0 MiB  (+8.00 MiB)
update on wire  9.1 MiB
saved          36.9 MiB (~80% vs full download)
```

（数字会随随机测试数据略有浮动；结构是确定的：更新量 ≈ 改动内容 + 新增内容。）

## 为什么先做这个

平台最大的成本不是服务器，是**带宽**。一个 20GB 游戏下载 1 万次就是 200TB。
"每两个版本生成一个 bsdiff 补丁"在版本一多后是 N² 爆炸，且无法覆盖
"玩家从 1.2 直接升到 1.7" 这种长尾。CAS 的分块去重把这个成本压到与
"改动了多少内容"成正比，而不是与"发了多少个版本"成正比。

## 运行

```bash
npm test              # 协议单元测试 + 端到端
npm run demo          # 完整演示（生成 demo/tmp/，可删）
```

手动走一遍：

```bash
# 1. 生成签名密钥（私钥只在发布机上，公钥要钉进客户端）
node tools/cas.mjs keygen --out .keys

# 2. 打包一个构建（服务端做，产物进对象存储）
node tools/cas.mjs pack ./MyGame --app 1001 --version 1.0.0 \
  --platform windows-x86_64 --out ./repo --key .keys/private.pem --entry Game.exe

# 3. 本地起分发服务（生产换成 CDN，路径完全一致）
node tools/cas.mjs serve ./repo --port 8787

# 4. 安装 / 更新（同一段代码）
node tools/cas.mjs install 1001 --server http://127.0.0.1:8787 --dest ./game

# 5. 校验与修复
node tools/cas.mjs verify ./game --app 1001 --server http://127.0.0.1:8787

# 6. 清理无引用分块
node tools/cas.mjs gc
```

## 协议

### 分块

FastCDC，参数固定（**改动即破坏所有已有 manifest**）：

| 参数 | 值 |
|---|---|
| GEAR_SEED | `0x9e3779b9` |
| MIN / NORMAL / MAX | 256 KiB / 1 MiB / 4 MiB |
| mask（< NORMAL / >= NORMAL） | 21 bit / 19 bit |

分块 ID = `sha256(明文)`。**不要**用哈希做分块边界的唯一依据——
边界只影响效率，ID 才是正确性来源。

### Manifest

```json
{
  "schema": 1,
  "appId": "1001",
  "buildId": "v1.1.0-b2",
  "platform": "windows-x86_64",
  "version": "1.1.0",
  "keyId": "67e4e8019d075daddc3319966dd8fc44",
  "createdAt": "2026-10-26T...",
  "totalSize": 48234496,
  "wireSize": 48351232,
  "entrypoint": "bin/game.exe",
  "files": [
    { "path": "bin/game.exe", "size": 12582912, "sha256": "...", "chunks": ["...", "..."] }
  ],
  "chunks": {
    "<sha256>": { "size": 1048576, "wire": 1048612, "enc": "zstd" }
  }
}
```

`files` 与 `chunks` 的键都按字典序序列化（`stableStringify`），
签名覆盖**写盘的原始字节**，客户端先验签再解析——避免跨语言的
JSON canonicalization 差异把签名搞坏。

### 签名

Ed25519，签名文件是 `manifest.json.sig`（base64）。
客户端内置公钥（`TrustStore`），校验时遍历所有已钉公钥，
**不信任 manifest 里的 keyId**（它是未验签数据，只用于事后比对）。

这一步不是可选项：manifest 决定往磁盘写什么文件，
签名缺失等于把 RCE 交给 CDN 和中间人。

### HTTP 布局

```
GET /apps/:appId/latest.json                      → { buildId, version, platform }
GET /apps/:appId/builds/:buildId/manifest.json    → ETag / 304
GET /apps/:appId/builds/:buildId/manifest.json.sig
GET /objects/:id                                   → immutable, ETag = id
```

`latest.json` 是**指针**：灰度发布和回滚都只是改这一个文件，
不需要重新构建或重新上传。

### 更新流程

1. 拉 `latest.json` → manifest（带重试与退避）
2. 验签 → 结构校验（路径穿越、重复路径、尺寸一致性）
3. 与本地 store 求差：`需要的 chunks = manifest 里有、本地没有的`
4. 并发下载（默认 8），每块下载后校验 `sha256(解压后) === id`
5. 拼装文件到 `.cas-part` → 校验整文件 sha256 → 原子重命名
6. 记录 install/file/file_chunk 三张表，引用计数归零的块由 `gc` 回收

关键性质：
- **断点续传是天然的**：已落盘的分块就是进度，进程被杀也不丢
- **修复不花流量**：`force` 重新拼装，块都在本地（demo 里是 0 B）
- **跨版本**：任意两个版本之间直接算差，不需要预生成补丁

## 目录

```
packages/cas-core/src/
  chunker.js    FastCDC + 哈希
  manifest.js   格式、稳定序列化、结构校验
  sign.js       Ed25519 签名 / 公钥钉住
  repo.js       服务端打包（只写新块）
  store.js      客户端 CAS（sqlite 索引 + 引用计数）
  downloader.js 并发下载、重试、超时、逐块校验
  client.js     install/update/materialize/verify
  server.js     参考分发服务（CDN 替身，含故障注入）
tools/
  cas.mjs       CLI
  demo.mjs      端到端演示
tests/cas.test.mjs
apps/launcher-ui/prototype.html   界面风格原型（单文件，直接打开）
apps/launcher/                    真实界面层（React 19 + TS + Vite，见文末）
docs/platform-blueprint.md        产品与架构方案
```

## 已知边界（下一阶段）

- 只有协议参考实现（Node）；**客户端内核要用 Rust 重写**，必须复刻
  gear 表与"对原始字节验签"，并用本文档的 manifest 做交叉测试
- 分块粒度是 4 MiB，单块失败重下损失最多 4 MiB；可加 Range 续传
- 未做：P2P 辅助分发、多 CDN 测速选源、边下边玩的文件优先级、
  安装/更新暂停恢复的 UI 状态机、macOS/Linux 安装行为
- Android：APK 签名后不可打补丁，整包替换；增量只作用于资源包
- 本地索引用 sqlite 起步；百万级文件时应改为自带 B 树或 LMDB

## 下一步

1. Rust 客户端内核（chunker / CAS / downloader）+ 与 Node 参考实现交叉验证
2. 服务端：对象存储 + CDN + 发布流水线（上传 → 切块 → 审核 → 灰度）
3. Tauri 壳补齐 §3 的命令与事件
4. 账号与 entitlement（权限唯一事实来源）

---

# 界面层（M1 第一步，已完成）

`apps/launcher/` — 真实的 React 19 + TypeScript + Vite 应用，
带完整的**下载状态机与适配器层**，不是静态页面。

## 结构

```
src/
  platform/
    types.ts    领域模型 + LauncherAPI 契约（UI 依赖的唯一接口）
    mock.ts     状态机：queued→manifest→downloading→materialize→verify→完成，
                含暂停/继续/取消、逐条 toast、聚合测速
    tauri.ts    TauriAdapter：invoke + 事件（命令清单见文件头，Rust 侧待实现）
    index.ts    适配器选择：浏览器 = Mock；__TAURI_INTERNALS__ 存在 = Tauri
  store/
    useLauncher.ts  zustand：全量切片 + 选择器 + 后端引导（StrictMode 幂等）
  components/
    Chrome.tsx      TitleBar / Rail / StatusBar / ToastStack
    StoreView.tsx   Hero 轮播（CTA 直接驱动安装·更新·启动）+ 新游 + 热榜 + 活动位
    LibraryView.tsx 库：版本、游玩时长、最近游玩、一键更新
    DownloadsView.tsx 任务详情（速率/分块/线程/ETA）+ CAS 存储面板
  App.tsx / main.tsx / styles.css
```

## 关键设计

- UI 只依赖 `LauncherAPI`；不出现 fetch/invoke/HTTP——换后端零组件改动
- 单一按钮语义：`开始游戏 / 更新 xx GB / 预下载 xx GB / 继续 / 进度条`，
  由 `describeAction()` 从（是否安装、是否有新版本、是否有任务）推导，
  商店卡、库、详情页共用一个真源
- Mock 的相位权重、速度、ETA 与真实 CAS 客户端一致，所以文案
  「待传输 3.1 GB（其余已在本缓存中命中）」在接真后端时依然成立

## 运行

```bash
npm run dev:ui      # http://localhost:5273（vite 绑定 IPv6 localhost）
npm run check:ui    # tsc 严格模式
npm run build:ui    # tsc -b && vite build
```

## 桌面壳（M1 第二步，已完成）

`apps/launcher/src-tauri/` — 无边框窗口 + IPC + 事件桥（`cargo check` 必须通过才提交）：

| 文件 | 内容 |
|---|---|
| `tauri.conf.json` | 窗口 1440×920、`decorations:false`（自定义标题栏）、CSP 收紧、bundle 暂关 |
| `capabilities/default.json` | 最小权限面：core + 窗口最小化/最大化/关闭/拖拽 |
| `src/model.rs` | Rust 侧领域模型，`camelCase` 与 ts 类型逐字段对齐；**这是契约不是参考** |
| `src/engine.rs` | 下载状态机（与 mock.ts 同参数），4 Hz tick + `launcher://event` 推送 patch/toast；Rust CAS 内核落地时仅替换 tick/action 实现，契约不动 |
| `src/commands.rs` | `bootstrap` / `download_action` / `launch_app` / `core_info` / `cas_selfinstall`（真实 CAS 运行时） |

桌面端与浏览器端唯一的 UI 差异：标题栏 mode chip 显示 `TAURI` 或 `MOCK`——
由 `platform/index.ts` 探测完成，组件层无感。无框窗口：`data-tauri-drag-region`
拖拽 + `getCurrentWindow()` 控制键，浏览器模式自动降级为无操作。

```bash
cd apps/launcher
npm run tauri -- dev        # 桌面客户端（开发，HMR）
npm run tauri -- build      # 出正式包（bundle 暂关）
```

# 目录服务接入（M1 第五步，已完成）

客户端不再信任内置目录：`bootstrap` 仍用本地种子先渲染（首帧不进网络），
随后 `refresh_catalog`（已在 tauri.ts init 里自动触发）从配置的源拉取
权威目录，成功后 `engine.apply_catalog()` 整体替换 games 列表——
本地已安装状态（installedVersion）优先于目录声明。

| 端 | 内容 |
|---|---|
| 服务端 `tools/cas.mjs serve --catalog <json>` | `/v1/catalog`（no-cache）/ `/v1/health`；目录未配置时返回明确 404 |
| 种子 `server/catalog.json` | 运营后台的替代品：demo=false 的条目**必须**有真实构建（1001 对接仓库里的 v1.0.0-b1，全量 8.3 MB），demo=true 的条目由状态机演示 |
| 客户端 `config.rs` | `%LOCALAPPDATA%\Stellar\config.json` 的 `catalogBase`（默认 `http://127.0.0.1:8787`）与 `installRoot` |
| 引擎 `apply_catalog` | 目录 → games 全量替换；失败降级种子（toast 提示，绝不阻塞启动） |
| UI | demo 条目带「演示数据」角标；真实构建的 1001 显示诚实尺寸（8.7 MB，不再是 42 GB 假数据） |

运行：

```bash
npm run serve:dev     # 目录 + 仓库 + 8787 端口（后台 apparent）
npm run tauri -- dev  # 桌面端，启动即拉目录，toast 报「目录已更新 · 8 款」
```

# 客户端运行时（M1 第三/四步，已完成）

`cas-core-rs` 补齐了安装管线（此前只有协议计算部分）：

| 模块 | 内容 |
|---|---|
| `store.rs` | 客户端 CAS：对象库（分块前缀两级目录）+ sqlite 索引 + 引用计数 GC + `diff()` |
| `client_runtime.rs` | `Fetcher` 抽象（HttpFetcher=ureq / LocalFetcher=磁盘测试）、install 状态机、materialize、verify_installed |
| `tests/install.rs` | 对着 Node 打出的签名仓储做**真实端到端安装**（本地 + 内嵌 HTTP 服务器两种传输） |
| `tests/common/mod.rs` | 零依赖 HTTP/1.0 服务器：latest/manifest/sig/objects 与生产端点同形 |

不变量（全部断言过）：验签先于解析；每块下载后解压缩再校验 sha256（对抗性 CDN 模式）；
文件拼接后整文件哈希 → 原子改名 → 入口文件最后写；重装是 no-op；
修复（force）0 字节流量；缺失恰好 1 块时只重取 1 块；未引用分块被 GC 回收。

接入桌面壳：设置页「真实引擎自检安装」→ `cas_selfinstall` 命令 →
分发源三选一（留空 = 内置签名仓库 LocalFetcher / 输入路径 = 指定仓库 /
输入 http(s):// = **HttpFetcher，与生产 CDN 同一契约**），InstallEvent 经
`launcher://event` 推到下载队列 UI（新的任务项 `selfcheck`），完成后 toast。

```bash
npm run test:rs        # 13 项（8 parity + 5 实装，含真 HTTP socket）
npm run check:rs       # 桌面壳整体
# 手测 HTTP 源：
npm run cas serve packages/cas-core-rs/tests/fixtures/repo --port 8787
npm run check:rs       # 桌面壳整体
```

已知边界：无虚拟化列表（超过几百项再上）、无 i18n 框架（文案直写中文，
接 i18next 时统一提取）、截图占位为渐变 + 字形（正式另起插画管线）。

---

# 协议核心 Rust 移植（M1 第三步，已完成）

`packages/cas-core-rs/` — 纯 Rust crate，与 Node 参考实现做**字节级**交叉验证，
`cargo test` 8/8 通过、零警告。已链入桌面壳（`src-tauri` 依赖它，`core_info`
命令回传分块常量）。

| 模块 | 内容 | 交叉验证 |
|---|---|---|
| `chunker.rs` | FastCDC：gear 表/apps 参数逐值同源 | 4 个确定性数据集切点逐块相等；流式路径 == 缓冲路径；前缀插入只重切邻域 |
| `manifest.rs` | 结构 + 校验（路径安全/去重/账目一致）+ 流式文件哈希器 | fixture 清单解析校验；改一个字节必须验签失败 |
| `trust.rs` | Ed25519 验签 + keyId 推导（SPKI 前缀拼接后 sha256，与 `keyIdOf` 同值） | 参考清单真实签名 ✔；篡改即拒 |

向量维护：`npm run vectors`（`tools/gen-vectors.mjs`）——确定性 PRNG 重建字节 + 调用真实的
`packBuild` 产出签名仓储（11 个分块对象），落到 `packages/cas-core-rs/tests/fixtures/`。
数据集改用 `parts`（PRNG 流拼接）描述，测试端表驱动重建；**没有特例路径**。

红线：要动 chunker 常量（gear 种子 / mask / MIN·NORMAL·MAX）必须同时
`npm run vectors` 重新生成夹具并 bump schema——否则 CI 直接拦下。

```bash
npm run vectors        # 重新生成夹具（.keys 已存在则复用信任根）
npm run test:rs        # Rust 交叉验证
npm run check:rs       # 桌面壳整体 check
```

# 仓库卫生

`.gitignore` 按依赖 / 构建产物 / 运行时数据 / 密钥分块，已用 `git init` + `add -A -n` 实测：

| 规则 | 理由 |
|---|---|
| `node_modules/` `target/` `dist/` `gen/schemas/` `*.tsbuildinfo` | 三种工具链的构建产物，全部可再生 |
| `.keys/` | **私钥（信任根）永不入库**；重生成 `.keys` 等于轮换换密钥（旧签名全失效） |
| `demo/` `tools/tmp/` `/repo/` `*.sqlite*` `*.log` | `npm run demo` / `npm run vectors` / `cas pack` 的可再生产物 |
| `!packages/cas-core-rs/tests/fixtures/repo/` | **刻意豁免**：字节级交叉验证的数据契约随仓库走（`/repo/` 只锚定根目录） |
| `icons/icon.ico` 虽是生成物 | 提交它保证全新 `cargo build` 不需要 node |
| `package-lock.json` `Cargo.lock` | 依赖锁，确定性 CI |

`git add .` 干净；想做全量审计：`git init; git add -A -n | Measure-Object`。