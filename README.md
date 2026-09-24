# 拍同款 · 个人本地版（retake-ai）

把一条**爆款参考片**复刻成自己的营销短视频：**真人换脸 + 换品牌 + 音色克隆**，按参考片的剧本（分镜、台词、运镜、节奏）重新生成一条同款片。

- 形态：面向个人、**本地运行**、**自带云 Key（BYO）**、**无数据库**（一个 job 一个 JSON 文件）
- 链路：参考片 → 剧本还原（OCR/ASR/drama-script）→ 组装 prompt → Seedance 生成 → 轮询 → 成片落本机并可预览
- v1 范围：**单段 ≤15s 的真人换脸复刻 happy path 一条打穿**；>15s 分段链式、断点续跑、后期加工、桌面 UI 全部 phase 2

> 交接背景与完整实现规格见 [`docs/拍同款独立产品-交接包/`](docs/拍同款独立产品-交接包/README.md)（README + IMPLEMENTATION-SPEC）。

---

## 1. 运行环境

| 项 | 要求 |
|---|---|
| Node | ≥ 20.12（本机已验证 v22.22.3） |
| 包管理 | pnpm（本机 10.19.0） |
| ffmpeg / ffprobe | **必须有绝对路径**（本机不在 PATH 也要能跑，代码只认 `.env` 里配的路径） |
| 云账号 | 火山方舟（Seedance）+ AI MediaKit，两个 API Key 自带 |

## 2. 安装与启动

依赖由**你本人**执行安装（本仓库不预装、不自动跑安装命令）：

```powershell
cd d:\develop\HBuilderXProject\retake-ai
pnpm install            # 装 fastify / tsx / typescript（core 只用 Node 内置能力，零运行时依赖）
Copy-Item .env.example .env
notepad .env            # 填 Key 与 ffmpeg 绝对路径
pnpm start              # 或 pnpm dev（tsx watch）

# 三条自检（都不依赖云 Key）
pnpm typecheck                          # tsc --noEmit：core + server 全量类型检查
node scripts/check-imports.mjs         # 免依赖的导入图自检（名字是否真被 export）
pnpm exec tsx scripts/smoke-ffmpeg.ts  # ffmpeg 适配层离线冒烟：探测/裁切/拼接/烧字幕/坏路径报错
```

启动后浏览器打开 <http://127.0.0.1:8787> 能看到接口清单，<http://127.0.0.1:8787/api/health> 看到「加载了哪份配置」（Key 一律掩码）。

> **Windows 控制台中文乱码不是 bug**：pino 输出的是 UTF-8 字节，PowerShell 默认 GBK 代码页会把它显成乱码。
> 跑前先 `chcp 65001`（或 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`）即可正常显示；
> 重定向到文件时用 `| Set-Content -Encoding utf8`。

## 3. 开通云 Key（缺配置时服务启动会打印同样的指引）

### 3.1 火山方舟 Ark —— Seedance 视频生成

1. 到 <https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement> 开通 **Seedance 2.0 系列**模型
   （开通门槛：账户余额 > 200 元，或购买节省计划/资源包）。
2. 到 <https://console.volcengine.com/ark/region:cn-beijing/apiKey> 创建**长效 API Key** → `ARK_API_KEY`。
3. 在模型广场复制视频模型 ID（形如 `doubao-seedance-2-0-xxxxxx`）→ `SEEDANCE_MODEL`。
4. `ARK_BASE_URL` 建议保持官方直连：**第三方中转站对未知路径常返回 `200 + HTML`**，JSON 解析会误判成功。

### 3.2 AI MediaKit —— OCR / ASR / 字幕烧录 / 剧本还原 / 拼接

1. 到 <https://console.volcengine.com/mediakit> 开通并创建 API Key → `MEDIKIT_API_KEY`。
2. 账号需具备服务关联角色 **`AmkServiceLinkedRole`**，否则部分能力报 `AccessDenied/RoleNotExist`。
3. **强烈建议**配置 `MEDIKIT_OUTPUT_DEST=tos://<你的桶名>/<目录>`：
   需要在 MediaKit 控制台**单独授权「跨服务写」权限**。不配置时产物只能拿到带 `auth_key` 的 VOD 预览链
   （24h 失效，且**难以作为下一步工具的入参**），剧本还原链会在 trim/ocr/asr/burn 之间断裂。
4. 配了上一步就同时填 `TOS_PUBLIC_ENDPOINT`（如 `tos-cn-beijing.volces.com`，不含桶名），用于 `tos://` → `https://`。

### 3.3 素材入云：本地版最重要的一条边界

云端能力只接受**公网可访问 URL** 与方舟私域素材，因此：

| 输入 | v1 怎么给 |
|---|---|
| 参考片 | `POST /api/materials` 带 `url`（公网 http(s) 直链）。`/api/materials/upload` 只做本机留档，之后用 `POST /api/materials/:id/retry` 带 `url` 补地址 |
| 人像 | **必须是 `asset://asset-xxx`**：方舟私域人像库（先完成真人认证拿 `GroupId`，再 `CreateAsset`）。Seedance 2.0/2.5 不接受含真人人脸的普通 http 参考图 |
| 音色 | 同上，drama 链路的 `reference_audio` 只吃 `asset://` |

> 为什么不做「本机文件直传云端」：源项目靠自有 TOS + `FileApi` 做这一步，那是 SaaS 地基（规格 §2.3 明确不移植）。
> 个人版把这条边界**摊开写清楚**而不是偷偷做个半吊子上传。若你已配好 `MEDIKIT_OUTPUT_DEST`，
> 中间产物会直接落在你自己的 TOS 上，链路是云端自洽的，只有**首帧输入**需要你给 URL。

## 4. 一条链怎么跑通（v1 验收口径）

```powershell
# 1) 登记参考片（≤15 秒、中文真人口播；也可用 /api/materials/upload 先留档再补 url）
curl.exe -X POST http://127.0.0.1:8787/api/materials -H "Content-Type: application/json" -d '{\"name\":\"参考片\",\"url\":\"https://your-cdn.com/ref.mp4\",\"trimTailSeconds\":2}'

# 2) 轮询剧本还原进度：analyzeStatus 依次 script_pending → script_running → script_ready
#    prepareStage 依次 init → trim → ocr → asr → burn → drama → persist
curl.exe http://127.0.0.1:8787/api/materials/<materialId>

# 3) 建 job（人像/音色用方舟 asset://；立即返回，不在 HTTP 线程里跑流水线）
curl.exe -X POST http://127.0.0.1:8787/api/jobs -H "Content-Type: application/json" -d '{\"materialId\":\"<materialId>\",\"aspectRatio\":\"9:16\",\"portraits\":[{\"castId\":\"p1\",\"url\":\"asset://asset-xxxx\"}],\"voiceUrl\":\"asset://asset-yyyy\"}'

# 4) 轮询任务：status 依次 script_preparing → script_generating → script_preview → script_done
curl.exe http://127.0.0.1:8787/api/jobs/<jobId>
```

完成后 `resultVideoUrl` 是本机文件（`<RETAKE_HOME>/artifacts/...`），`previewUrl` 可直接在浏览器播（`/files/...`）。
任一阶段失败/超时：`status=script_failed` 且 `errorMessage` 说清是哪一步、为什么、下一步做什么（不会白屏卡在 running）。

## 5. 目录结构

```
retake-ai/
├─ packages/
│  ├─ core/        引擎：状态机 + prompt + planner + adapters + store（无 HTTP、无 UI，可单测）
│  │  └─ src/
│  │     ├─ types.ts config.ts paths.ts deps.ts
│  │     ├─ store/      job-store（原子写 + CAS）、material-store、json-file 底座
│  │     ├─ adapters/   mediakit / seedance / artifact / ffmpeg / ark-chat
│  │     ├─ prompt/     seedance-prompt（核心资产）、understand-prompt、压缩器、装配器
│  │     ├─ cast/ script/ planner/   人像上限、剧本包解析与映射、硬字幕判定、画幅、分段
│  │     └─ pipeline/   stages（状态真源）、prepare（素材预处理）、state-machine（出片）
│  └─ server/      本地 HTTP（Fastify）+ 3s 轮询调度器
├─ docs/拍同款独立产品-交接包/   交接 README + 实现规格（只读参照）
└─ data/           运行时生成（已 .gitignore）：jobs/ materials/ artifacts/ scripts/
```

## 6. 移植口径与已知取舍

- **prompt 与业务常量逐字照搬源仓库**（`DramaScriptSeedancePromptBuilder`、`BrandShootSamePromptBuilder`、
  `DramaShootSameStatuses`、时长/人像上限常量等），保留原注释与常量名，便于与 Java 侧一对一对照。
- **状态取值带 `script_` 前缀**（`script_preparing/script_generating/script_preview/script_done`），
  不改成 `preparing/generating`：源实现刻意如此，避免旧链路误领取。
- **`script_preview` 与 `script_done` 的区分是本地版新增**：源实现停在 preview，本地版多一次 ffprobe 校验本机文件才升 done。
- **v1 单段**：`planSingle` 把整片当一段（一次 Seedance 调用出全片）。源实现是按细镜头切点 + 尾帧链式衔接的完整规划器，
  属 phase 2；`planner/segment-planner.ts` 保留了同一套时间口径工具与 `Segment` 值对象。
- **`topicsOfCue` 里保留了源项目针对具体爆款样本写的品牌词特例**（小米之家/拍个视频/扫地机器人…）：
  按「逐字照搬」移植，泛化成可配置词表是 phase 2 的事。
- **砍掉不移植**（规格 §2.3）：Token 钱包计费、多租户、登录鉴权、FileApi/TOS 转存、MyBatis/MySQL。
- prompt 超长压缩：配了 `ARK_CHAT_MODEL` 走 LLM（与源一致，只压画面块、对白块原样拼回并校验）；
  没配则走 `compactVisual` 的确定性压缩，**不会**因此失败。

### 6.1 本机已验证到的程度（证据边界）

| 项 | 状态 |
|---|---|
| 依赖安装 | ✅ Node v22.22.3 + pnpm 10.19.0，`pnpm install` 成功（91 包；pnpm 默认忽略 esbuild 构建脚本，实测不影响 tsx 运行） |
| 类型检查 | ✅ `pnpm typecheck` 零 error（core + server） |
| 启动链路 | ✅ 配置缺失时**拒绝启动**并打印开通指引；用临时环境变量注 Key 后 boot 正常：建目录→路由→静态挂载→3s 调度器→listen |
| 接口行为 | ✅ `/api/health` Key 掩码为 `sk-v******0000` 形态；列表空结果；`POST /api/jobs` 缺参 400；不存在资源 404（错误文案为人话） |
| 本地媒体 | ✅ `scripts/smoke-ffmpeg.ts` 6 项全通过：生成/探测/精确裁切/硬切拼接/srt 烧录/坏路径必报错；路径含空格与中文也不坏 |
| 本机 ffmpeg | ✅ `D:\develop\ffmpeg` 下的 `ffmpeg.exe` / `ffprobe.exe`（9.0.2 essentials，**含 libx264**），已写入 `.env` |
| **真实云调用** | ⚠️ **未验证**：drama-script 产物包、Seedance 生成、`asset://` 人像与音色必须用你本人的 Key 才能跑，端到端成片尚待你跑一次验收（§4） |

## 7. 合规红线

- **不得复制 `hypit/` 的任何代码或包**（其 LICENSE 禁止衍生作品商用、强制保留其品牌/版权）。Hypit 仅作竞品情报。
- **不做多租户、不做对外托管**：这是个人本地版定位，也避开 Hypit 的 license 雷区。
- 用户自带的 Key 只落本地 `.env`（已 `.gitignore`）；代码里任何日志与 `/api/health` 回显**必须掩码**。
- **生成内容的版权与平台合规由使用者负责**：本产品仅供对**自有素材**做合规复刻，请勿用于未经授权的他人肖像、品牌或内容搬运。

## 8. phase 2 备忘（v1 故意不做）

>15s 长视频分段链式生成（切点规划 + 尾帧衔接 + 断点续跑 + 失败精确到段）· 后期加工（字幕/Logo/滤镜/超分/暗水印）·
Vue 向导复用（改 API base 指 localhost）· 素材预处理失败自愈完整化 · `index.jsonl` 换单文件 SQLite · 本地文件到 TOS 的自动上传。
