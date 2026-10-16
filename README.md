# 今日待办 · todo-today

一个极简的**每日待办清单**，可直接一键部署到 **Cloudflare Workers**，完全无服务器、无固定成本。

> **不想装命令行？** 打开 [docs/cloudflare-网页部署手册.html](./docs/cloudflare-网页部署手册.html)，
> 全程只用浏览器，粘贴一个文件就能部署。

> 演示/预览：直接用浏览器打开 `public/index.html?demo=1`（数据只存在本机浏览器，用于看界面）。

## 功能

**待办**

- 新增任务（**空白任务不会被添加**，自动 trim、限 500 字）
- 勾选 / 取消勾选，已完成的自动沉到列表底部
- 单条删除、一键「清除已完成」
- 实时**剩余计数**（底部常驻：`3 项待完成` / `全部完成 🎉`）
- 行内编辑（长按 / 双击任务文字，或点卡片上的铅笔）
- 日期切换（‹ › / 日期选择器 / 侧栏日历点选），按天隔离
- 「顺延未完成」：把以往所有没做完的事一键挪到今天
- JSON 导出 / 导入（本地备份）

**侧栏与检索（Memos 风格）**

- **侧栏**（桌面常驻、移动端抽屉）：搜索、统计、日历、标签、时间线
- **全文搜索**：跨所有日期找任务（后端 LIKE 查询），结果按日期分组展示
- **#标签**：任务标题里写 `#工作`、`#购物` 即自动成签；侧栏汇总标签与计数，点击即过滤；卡片里点标签徽片同样直达
- **迷你日历**：有任务的日期带圆点角标，点选任意日期直达当天；`‹ ›` 翻月；**点标题查看整月**
- **时间线**：按 年 → 月 聚合任务数，**点击月份打开整月视图**（该月所有任务按日期倒序分组展示，横幅显示月度统计，可一键清除整月已完成）
- **统计卡**：记录天数 / 全部任务 / 已完成
- 快捷键：`/` 聚焦新增，`Ctrl/⌘+K` 聚焦搜索

**账号**

- 用户名 + 密码注册登录，多用户数据完全隔离
- 口令用 **PBKDF2-SHA256**（10 万次迭代 + 16 字节随机盐）派生，绝不存明文
- 登录态用 **HttpOnly Cookie + D1 会话表**，30 天有效
- 支持改密码（改完自动注销其它设备）

**到期提醒（12 种推送渠道）**

任务可以设一个可选的**到期日**（与归属日期互相独立：归属日期决定它出现在哪天，
到期日决定什么时候提醒）。**新增任务时到期日默认就等于所属日期**——
10 月 16 日的待办，到期日就是 10 月 16 日，不用手动设置，当天该做的事当天就会提醒。
也可以在新增框的「到期日」按钮或卡片徽标上改成任意日期（弹层里点「清空」= 这条任务不参与提醒）；
到期日与所属日期相同的任务，徽标会以弱化样式显示。规则上线前创建的老任务
可以到 设置 › 到期提醒 的预览区点「补齐到期日」一次性按所属日期补上。
卡片上有「明天到期 / 今天到期 / 已过期 N 天」徽标，点击即可改期或清空。

支持的推送渠道：

| 渠道 | 说明 |
|---|---|
| Bark | iOS 推送，支持自建服务器 / 铃声 / 分组 |
| Gotify | 自建消息服务 |
| WxPusher | 微信推送（UID 或主题） |
| 邮件 | Resend API |
| Telegram | Bot API，支持话题群 |
| 微信机器人 | 企业微信类自定义字段 / 模板卡片接口 |
| 飞书 | 自定义机器人，支持加签 |
| 企业微信 | 群机器人 Webhook |
| Server 酱 / PushPlus | 微信服务号推送 |
| ntfy | 任意 ntfy 服务器 |
| 自定义 Webhook | 任意 HTTP 接口，可用 `{title}` `{text}` `{count}` `{items}` 模板 |

提醒行为全部可配置：

- **提前 N 天提醒**（0–365 天，0 = 只在当天推）
- **每天几点后推送**（免打扰：到点之前 Cron 不会发）
- **检查频率可调**（5–1440 分钟，默认 5）：云端定时器最快每 5 分钟醒来一次，
  调大后按你设的间隔检查，不想收得那么勤可以设成 30 或 60 分钟
- **到期前每天提醒**（默认）：设了「提前 5 天」，那么提前 5/4/3/2/1 天每天都会提醒；
  关掉开关则变成 **只在进入提醒窗口那天提醒一次**
- **已过期任务也提醒**（可关；开启时最多回溯 30 天）
- 设置页有**实时预览**：改配置立刻看到「当前会提醒哪些任务」
- 每个渠道都有「发送测试」按钮，没保存也能先测通
- 配置保存在账号下，**密钥永不回显**（也可以放在 `NOTIFY_*` 环境变量里）
- 由 Cloudflare Cron Triggers 驱动（复用备份的 `*/5 * * * *`），到点自动推送；
  失败的渠道下轮自动重试，成功的按 (任务, 到期日, 渠道) 去重，绝不重复打扰；
  任务改期后会自动重新提醒

**云备份（可自由配置）**

| 方式 | 说明 |
|---|---|
| `r2` | Cloudflare R2 原生绑定，**不需要任何密钥** |
| `s3` | 任意 S3 兼容存储：AWS S3、R2 的 S3 接口、MinIO、阿里云 OSS、Backblaze B2…（Worker 内手写 AWS SigV4，无 SDK 依赖） |
| `webdav` | 任意 WebDAV：坚果云、Nextcloud、群晖、Alist… |

- 支持「立即备份」「从云端恢复」「测试连接」
- 支持「变更后自动备份」，**最短备份间隔可自行设置**：
  不限流 / 1 分钟 / 5 分钟 / 15 分钟 / 30 分钟 / 1 小时 / 6 小时 / 24 小时
- 支持「**定时备份**」（不操作也会备份），周期同样可自选（5 分钟～每天）：
  由 Cloudflare Cron Triggers 驱动 —— wrangler 部署已在 `wrangler.jsonc` 里配好；
  网页控制台部署需手动到 Worker 的 **Settings › Triggers › Cron Triggers** 添加
  `*/5 * * * *`。设置页会显示定时任务的心跳状态，没生效一眼就能看出来
- **文件名带时间戳**（默认开启，可在设置里关闭）：每次备份额外写入一份
  `todo-today.backup.20261015-215730.json` 这样的历史版本，同时始终刷新固定名的
  `todo-today.backup.json` 作为「最新快照」——「从云端恢复 / 测试连接」读的就是这份，
  因此开不开时间戳都不影响恢复。时间戳按你所在时区生成（取 Cloudflare 的请求时区信息）。
  注意：历史文件会随备份次数累积，建议在 R2 / S3 存储端配置生命周期规则自动清理旧备份
- 密钥可以存在页面上，也可以放在 **Worker 环境变量 / 密钥**里（推荐，更安全）

**体验**

- 桌面双栏（侧栏 + 卡片流），移动端单列 + 侧栏抽屉；浅色 / 深色 / 跟随系统三种主题
- PWA manifest，可「添加到主屏幕」当 App 用
- 前端零依赖、零构建，`public/` 目录即静态资源
- 部署后可访问 `/api/health?check=1` 自查数据库表是否建齐

---

## 目录结构

```
todo-today/
├── wrangler.jsonc          # Cloudflare 部署配置（D1 / R2 / 静态资源）
├── schema.sql              # D1 表结构，可重复执行
├── src/
│   ├── index.js            # Worker 入口 + 路由
│   └── lib/
│       ├── http.js         # JSON 响应 / Cookie
│       ├── crypto.js       # PBKDF2、随机 ID、HMAC/SHA256
│       ├── auth.js         # 注册、登录、会话
│       ├── todos.js        # 待办 CRUD 与统计
│       ├── notify.js       # 到期提醒（12 渠道推送 / 去重 / 免打扰 / 时区）
│       └── backup.js       # 云备份（R2 / S3 SigV4 / WebDAV）
├── public/                 # 静态前端（无构建）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── icon.svg
│   ├── notify-channels.json   # 渠道目录（由 scripts/gen-notify-catalog.mjs 生成）
│   └── manifest.webmanifest
└── test/                   # 测试
    ├── d1-shim.mjs         # 用 node:sqlite 冒充 D1
    ├── run.mjs             # 主套件
    ├── notify.mjs          # 到期提醒（71 个用例：纯函数 / 各渠道报文 / 端到端）
    └── fixtures/sigv4/     # AWS 官方 SigV4 测试向量
```

---

## 部署到 Cloudflare（约 5 分钟）

前置：本机装有 Node.js 18+ 与 npm。

```bash
cd todo-today
npm install
npx wrangler login
```

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create todo-today
```

命令会输出一个 `database_id`，把它填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "todo-today", "database_id": "<粘贴这里>" }
]
```

### 2. 初始化表结构

```bash
npx wrangler d1 execute todo-today --remote --file=./schema.sql
```

### 3. （可选）启用 R2 原生备份

```bash
npx wrangler r2 bucket create todo-backups
```

然后在 `wrangler.jsonc` 中取消这段注释：

```jsonc
"r2_buckets": [
  { "binding": "BACKUPS", "bucket_name": "todo-backups" }
]
```

> 不想用 R2 也完全可以，用 S3 兼容存储或 WebDAV 做备份即可。

### 4. （可选）把备份密钥放进 Worker 密钥

```bash
npx wrangler secret put BACKUP_S3_SECRET_KEY
npx wrangler secret put BACKUP_WEBDAV_PASSWORD
```

留空直接回车表示不设置；此时密钥就必须在网页的设置面板里填。

到期提醒的各渠道密钥同样支持环境变量兜底（设置页没填时生效）：

```bash
npx wrangler secret put NOTIFY_BARK_KEY            # Bark Device Key
npx wrangler secret put NOTIFY_GOTIFY_TOKEN        # Gotify App Token
npx wrangler secret put NOTIFY_WXPUSHER_APPTOKEN   # WxPusher AppToken
npx wrangler secret put NOTIFY_TELEGRAM_BOT_TOKEN  # Telegram Bot Token
npx wrangler secret put NOTIFY_SERVERCHAN_KEY      # Server 酱 SendKey
npx wrangler secret put NOTIFY_PUSHPLUS_TOKEN      # PushPlus Token
npx wrangler secret put NOTIFY_RESEND_API_KEY      # 邮件（Resend）API Key
```

### 5. 部署

```bash
npx wrangler deploy
```

完成后会输出形如 `https://todo-today.<你的子域>.workers.dev` 的地址，打开注册一个账号即可开始用。

> 上面是**命令行部署**。如果你用 **Git 自动构建（Workers Builds）**，
> 请对照 [附录 · Git 自动构建的同步清单](#附录--git-自动构建的同步清单) 逐项检查，
> 那里列出了每次改动需要跟着更新哪些文件。

---

## 本地开发

```bash
npm run db:local      # 在本地 .wrangler 里建表
npm run dev           # 启动 wrangler dev
```

打开 <http://localhost:8787>。

> 需要本地也用上 D1 吗？`wrangler dev` 默认就是本地 SQLite 模拟，直接可用，无需真实 `database_id`。
>
> 想在本地调渠道密钥，把 `.dev.vars.example` 复制成 `.dev.vars` 再填
> （`.dev.vars` 已在 `.gitignore` 里，不会被提交）。

## 跑测试

```bash
npm test
```

- 用 Node 22 内置的 `node:sqlite` 冒充 D1，把 Worker 的 `fetch()` 全流程跑一遍（注册/登录/增删改查/计数/顺延/导入导出/备份配置/到期提醒/多用户隔离…）
- SigV4 签名部分用 **AWS 官方 `aws-sig-v4-test-suite` 测试向量**做回归，逐字节比对规范请求、待签字符串与最终 Authorization 头
- 到期提醒单独有 71 个用例：纯函数（时区换算 / 去重 / 掩码）、12 个渠道的请求报文（换掉全局 `fetch` 逐字段断言）、以及端到端流程（建表 / 推送 / 去重 / 失败重试 / Cron 隔离 / 老库降级 / 空结果诊断 / 到期日默认值与历史数据补齐 / 每天提醒与 v1 配置迁移 / Bark 自检回显）
- **两条部署路径对照**（`test/deploy-parity.mjs`，9 项）：把「Git 自动构建」和「网页粘贴单文件」当两个真实 Worker，各跑一遍完整业务流程并逐条 diff 响应，确保功能不分叉；同时校验静态资源逐字节一致、Cron 表达式一致、演示模式渠道清单不漂移
- UI 冒烟用真实 headless Chrome 走一遍主要交互（`scripts/smoke-ui.mjs`，31 项）

当前 166 个后端用例 + 32 项 UI 检查全部通过。

---

## 云备份怎么填

### Cloudflare R2（原生绑定）

设置面板选 **Cloudflare R2（原生绑定）**，对象键名留空即可（默认 `todo-today.backup.json`）。
前提是已完成上面第 3 步的 `r2_buckets` 绑定。

### S3 兼容存储

| 字段 | 示例 |
|---|---|
| Endpoint | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`（R2）<br>`https://s3.us-east-1.amazonaws.com`（AWS）<br>`http://127.0.0.1:9000`（MinIO） |
| Region | R2 填 `auto`；AWS 填如 `us-east-1` |
| Bucket | `todo-backups` |
| Access Key ID / Secret | 在对应平台的 API 令牌页生成 |
| 路径前缀 | 可空，如 `todo/` |
| Path-Style | MinIO 等自建服务一般要勾上；AWS / R2 不勾 |

寻址规则：默认**虚拟主机式** `https://<bucket>.<endpoint 域名>/<key>`；勾选 Path-Style 后为 `https://<endpoint>/<bucket>/<key>`。

### WebDAV

| 字段 | 示例 |
|---|---|
| 目录地址 | 坚果云：`https://dav.jianguoyun.com/dav/我的坚果云/todo`<br>Nextcloud：`https://cloud.example.com/remote.php/dav/files/<用户名>/todo` |
| 用户名 / 密码 | 坚果云需在「安全选项」里生成**应用密码** |

> 目标目录需已存在（WebDAV 一般不会自动建目录）。

---

## 变量与密钥

| 名称 | 类型 | 说明 |
|---|---|---|
| `APP_NAME` | 变量 | 站点名，默认 `今日待办` |
| `ALLOW_REGISTRATION` | 变量 | 设为 `"false"` 可关闭注册（单人自用推荐） |
| `BACKUP_S3_SECRET_KEY` | 密钥 | S3 Secret Access Key 的兜底值 |
| `BACKUP_WEBDAV_PASSWORD` | 密钥 | WebDAV 密码的兜底值 |
| `NOTIFY_BARK_KEY` | 密钥 | Bark Device Key 的兜底值 |
| `NOTIFY_GOTIFY_TOKEN` | 密钥 | Gotify App Token 的兜底值 |
| `NOTIFY_WXPUSHER_APPTOKEN` | 密钥 | WxPusher AppToken 的兜底值 |
| `NOTIFY_TELEGRAM_BOT_TOKEN` | 密钥 | Telegram Bot Token 的兜底值 |
| `NOTIFY_SERVERCHAN_KEY` | 密钥 | Server 酱 SendKey 的兜底值 |
| `NOTIFY_PUSHPLUS_TOKEN` | 密钥 | PushPlus Token 的兜底值 |
| `NOTIFY_RESEND_API_KEY` | 密钥 | 邮件（Resend）API Key 的兜底值 |

页面上填了密钥则优先用页面上的；留空则回落到上面的环境密钥。

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查（是否绑定 DB / R2） |
| `POST` | `/api/auth/register` \| `/login` \| `/logout` | 注册 / 登录 / 退出 |
| `GET` | `/api/auth/me` | 当前用户 |
| `POST` | `/api/auth/password` | 改密码 |
| `GET` | `/api/todos?date=YYYY-MM-DD` | 某天列表 + 剩余计数 |
| `POST` | `/api/todos` | 新增 `{title, date, dueDate?}` |
| `PATCH` | `/api/todos/:id` | 改 `{done?, title?, date?, dueDate?}` |
| `DELETE` | `/api/todos/:id?date=` | 删除 |
| `POST` | `/api/todos/batch` | `clear-completed` / `toggle-all` / `carry-over` / `reorder` |
| `GET` | `/api/todos/stats?days=30` | 按日期统计 |
| `GET/PUT` | `/api/notify/config` | 读取 / 保存提醒配置（密钥永不回显，响应带渠道目录与预览） |
| `POST` | `/api/notify/test` | 向单个渠道发测试消息（可带未保存的表单） |
| `POST` | `/api/notify/run` | 立即检查一次到期任务（不受免打扰时间限制） |
| `GET/PUT` | `/api/backup/config` | 读取 / 保存备份配置（密钥永不回显） |
| `POST` | `/api/backup/test` \| `/run` \| `/restore` | 测试连接 / 立即备份 / 云端恢复 |
| `GET` | `/api/export` · `POST` `/api/import` | 本地导出 / 导入 |

---

## 安全设计

- 口令：PBKDF2-SHA256，10 万次迭代 + 每用户独立随机盐
- 会话：32 字节 CSPRNG token，仅存于 `HttpOnly; SameSite=Lax` Cookie（HTTPS 下自动加 `Secure`）
- 授权：所有 `/api/*`（除健康检查与认证接口）都要求有效会话，且每条 SQL 都带 `user_id` 过滤
- 密钥：备份密钥写入后**永不回显**给前端，只返回「已配置 / 来自环境变量」的布尔标记
- XSS：前端所有动态文本走 `textContent`，不拼 HTML

## 附录 · Git 自动构建的同步清单

两种部署方式（网页粘贴 / Git 自动构建）**共用同一份 Worker 代码**，功能完全一致。
区别只在静态资源怎么分发：

- **网页粘贴**：把 `dist/worker.cloudflare-dashboard.js` 单个文件粘进在线编辑器，
  前端资源是打包时 base64 内联进去的 → **改完前端必须重新打包再粘贴**。
- **Git 自动构建**：Workers Builds 直接读仓库，`wrangler.jsonc` 里的 `assets` 指向
  `public/`，静态文件由 CDN 提供 → **只要 `public/` 推上去了就生效，不用打包**。

### 怎么确认两条路径跑出来是一样的

访问 `/api/health`，`deploy` 字段会自报家门：

```json
{ "ok": true, "notify": true,
  "deploy": { "assets": "assets", "cron": ["*/5 * * * *"] } }
```

- `deploy.assets`：`assets` = 静态资源由 CDN 提供（Git 部署）；`inline` = 由单文件内联表提供（网页粘贴）。
  这是两条路径**唯一**设计上的差异。
- `deploy.cron`：定时表达式，两条路径必须相同。

除这两项之外，`test/deploy-parity.mjs` 会把两条路径当两个真实 Worker 各跑一遍
「注册 → 建待办（含到期日）→ 搜索/标签 → 到期提醒配置/预览/测试/手动跑 → Cron →
备份配置 → 导出」全流程，并把每一步的响应体逐条 diff。
**任何一个业务响应出现分叉，测试都会失败**，差异白名单里只有 `health.deploy.assets` 一项。

### 提交前对照检查

| 你改了什么 | Git 自动构建要做的事 |
|---|---|
| `src/**`（后端逻辑、新增渠道） | 直接 push，构建会自动部署 |
| `public/**`（前端） | 直接 push。**注意 `public/notify-channels.json` 也要一起提交** |
| 渠道字段定义（`CHANNEL_FIELDS`） | 先 `npm run gen:catalog` 重新生成 `public/notify-channels.json`，再连它一起 push |
| `schema.sql` | 需要**手动**在 D1 上执行一次（见下） |
| `wrangler.jsonc` | 直接 push；改了 `crons` / 绑定后会自动重新部署 |
| 新增 `src/lib/*.js` | 如果只走 Git 部署则无需额外操作；但为了让 `dist/` 单文件版也能构建，记得加进 `scripts/build-dashboard.mjs` 的 `MODULES` |

### 必须手动做的两件事

**1. 建表（新增了 `notifications` / `notify_log` 两张表）**

Git 构建只部署代码，**不会自动建表**。到控制台
**存储和数据库 › D1 SQL Database › todo-today › Console** 把最新的
`schema.sql` 全文粘进去执行：

```bash
# 或者用命令行
npm run db:remote
```

验证：访问 `https://你的地址/api/health?check=1`，看到
`"missing":[]` 且表清单里有 `notifications`、`notify_log` 才算齐了。

**2. Cron Trigger（网页粘贴部署才需要）**

Git 部署的 `crons` 来自 `wrangler.jsonc`，已经在仓库里配好了 `*/5 * * * *`，**无需手动添加**。
（网页粘贴部署因为不读 `wrangler.jsonc`，必须到
*Settings › Triggers › Cron Triggers* 手动加。）

### 隔离与数据一致性

Git 部署不影响多账号隔离：隔离由服务端会话校验 + 所有查询强制带 `user_id` 保证，
与前端资源怎么分发无关。但请确认 `.gitignore` 里**没有** `public/`——
如果 `public/` 没被提交，线上会白屏或停在旧版本（一个 `app.js` 改了这个、`index.html` 还是老的）。
仓库自带的 `.gitignore` 已经只忽略 `node_modules/`、`.wrangler/`、`.dev.vars`、`dist/`。

> `dist/` 被忽略是故意的：单文件产物只服务于「网页粘贴」这条路径，Git 部署不需要它。
> 如果你两条路径都在用，改完前端记得执行 `npm run build:dashboard` 保持 `dist/` 与 `public/` 同步
> ——`test/deploy-parity.mjs` 会在两者不一致时直接失败，避免「修了这个没修那个」。

---

## 常见问题

**Q: 注册时报 `D1_ERROR: no such table: users: SQLITE_ERROR`？**
数据库建好了，但**表还没建**。这一条最常见，补上第 2 步即可：

```bash
npx wrangler d1 execute todo-today --remote --file=./schema.sql
```

如果你是在 Cloudflare 网页控制台部署的，去 **D1 → 选中该数据库 → Console 标签页**，
把 `schema.sql` 全文粘进去点 Execute。执行完访问 `/api/health?check=1`，
看到 `"schema":{"ok":true,...}` 就说明表齐了。

> 注意别在「本地实例 / Local」里执行——要选远程的那个数据库，否则线上还是空表。

**Q: Git 自动部署时报 `D1 binding 'DB' references database '…' which was not found [code: 10181]`？**
仓库里 `wrangler.jsonc` 的 `database_id` 不是你账号里的 D1 数据库 ID（这个 UUID 每个账号不同，不能照抄别人的）。
正确 ID 的位置：控制台 **存储和数据库 › D1 SQL Database** → 点进 `todo-today` → 概览页右侧 **Database ID** 复制，
填回仓库的 `wrangler.jsonc` 并提交，Workers Builds 会自动重新部署。
务必选线上在用的那个库——绑到新的空库会「部署成功但数据为空」，还要对新库补执行 `schema.sql`。

**Q: 换成 Git 自动构建（方案 B）后，多账号数据隔离还有效吗？**
有效，而且和网页粘贴方案完全一致。两个方案共用同一个 Worker 入口 `src/index.js`，
账号隔离由服务端的会话校验 + 所有查询强制带 `user_id` 保证，与前端资源怎么分发无关。
唯一区别是静态资源来源：方案 B 直接读取仓库里的 `public/` 目录，
所以推送前务必确认 `public/app.js`、`public/index.html`、`public/style.css` 都已提交
（`.gitignore` 里不要包含 `public/`），否则页面会空白或停留在旧版本。

**Q: 怎么确认后台是否健康？**
访问 `/api/health` 看绑定，访问 `/api/health?check=1` 会真的连一次库并列出缺失的表。

**Q: 部署后打开是登录页但注册报错？**
先确认第 2 步的建表命令在 `--remote` 上执行过；看日志：`npx wrangler tail`。

**Q: 想改成只给自己用？**
在 `wrangler.jsonc` 里把 `ALLOW_REGISTRATION` 设为 `"false"`，然后用第一个注册的账号登录即可（注册第一个账号后再改也来得及）。

**Q: 备份文件里有什么？**
完整 JSON：`{ app, version, exportedAt, user, stats, todos[] }`，可直接被「导入 JSON」或「从云端恢复」读回。

**Q: 想换成别的 S3 服务 / 自建 MinIO？**
直接在设置面板改 Endpoint 与 Bucket，勾上 Path-Style，点「测试连接」验证即可，无需改代码。

**Q: 开了到期提醒但一直没收到？**
按顺序排查：

1. **设置页显示「尚未检测到定时任务心跳」**：提醒由 Cloudflare Cron Triggers 驱动。
   Git 部署（方案 A）已在 `wrangler.jsonc` 里配好；网页粘贴部署（方案 B）需要手动到
   Worker 的 **Settings › Triggers › Cron Triggers** 添加 `*/5 * * * *` 并保存。
2. **任务没设到期日**：新任务的到期日默认等于所属日期（10-16 的待办到期日就是 10-16），
   规则上线前创建的老任务不会自动补——打开 设置 › 到期提醒，预览区会显示
   「另有 N 条未完成任务的到期日为空」，点「补齐到期日」即可一次性补上。
   注意侧栏月历里加粗的日期只代表「那天有任务」，与到期日无关。
3. **没过免打扰时间**：「每天几点后推送」设的是 09:00 就要等到 9 点之后。
   想立刻验证请点「立即检查」，它不受免打扰限制。
4. **进入提醒窗口后每天都提醒**（默认）：设了提前 5 天，则提前 5/4/3/2/1 天每天各推一次；
   关掉「到期前每天提醒」才变成只在进窗口那天推一次。
5. **渠道参数错误**：点「发送测试」看具体报错（后端会把上游返回的错误原因带回来）。
   状态栏还会回显**实际发出的请求**（方法、URL、JSON 字段），
   据此可确认 Worker 跑的是最新代码。

**Q: Bark 收到通知但正文是空的 / 显示成 "push"？**
这是「Device Key 放错位置」的典型症状：Bark 官方 API 要求 `device_key` 放在
`POST /push` 的 **JSON 请求体**里。若改用自定义请求头（如 `x-bark-key`），
部分 bark-server 不认，会回退解析 URL 路径，把路径段 `push` 当成正文。
本项目已按官方格式发送；**升级后请重新部署**（网页粘贴方案需重新粘贴单文件，
Git 方案 push 即可），并在 设置 › 到期提醒 点「发送测试」确认状态栏回显里
`JSON 字段` 含 `device_key/title/body`。

> 拿不准原因时点「立即检查」：现在它会把**具体原因**直接说出来——
> 「任务没设置到期日」「到期日超出了提前 N 天的窗口」「提醒未开启」「还没选推送渠道」各有一句专属提示；
> 预览框为空时同样会显示原因。「立即检查」用的是面板里**当前的表单值**（与「发送测试」一致），
> 改动还没保存也能先验证。

**Q: Server 酱「发送测试」报上游 404？**
SendKey 的两代接口 URL 完全不同，本项目按前缀自动选择（与官方文档一致）：
`sctp` 开头（Server酱³）→ `https://{uid}.push.ft07.com/send/{SendKey}.send`，
其中 `uid` 是 key 里 `sctp` 与 `t` 之间的数字；`SCT` 等其它开头（Turbo）→
`https://sctapi.ftqq.com/{SendKey}.send`。若你用的是旧版本，端点写法有误
（把整个 key 当子域名），会得到 404——重新部署后即可。点「发送测试」时状态栏
会回显实际请求的 URL，可据此核对端点格式是否正确。

**Q: 到期日和归属日期有什么区别？**
归属日期决定任务出现在哪一天的清单里（可顺延）；到期日是这件事**必须完成的截止日**，
只用于提醒。默认情况下到期日就等于所属日期（新建时自动填好），
需要提前量时再改：比如周一建了「周五前交报告」，把到期日改成周五——
提前 N 天的提醒从周三前后开始推，不用等到周五当天。
顺延未完成任务时，还没手动改过的到期日会跟着一起顺延。

**Q: 提醒会在每天固定时间发吗？**
不一定。Cron 每 5 分钟跑一轮，任务「进入窗口」后的第一轮就会推（哪怕这几天没打开过网页也不会漏），
所以实际发出时间 = 你设的免打扰起点之后的第一轮 Cron。「每天提醒一次」模式下每天最多推一条。
如果嫌检查得太勤，可以把设置里的「检查频率」调大（比如 30 分钟），到点后的第一轮检查才会推。
