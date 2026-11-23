# MoonTVPlus 部署到 EdgeOne Pages/Makers（Turso 存储 · 含皮肤）

> 本文比 README 的「EdgeOne Pages 部署」章节详细得多：从零建库、拿 Token、配 Secrets、启用并触发 workflow、
> 验证皮肤生效、到 18 类常见报错的处理，全部按「复制粘贴就能跑」的标准写。
>
> 读完你会得到：
> 一个跑在 EdgeOne 边缘网络上的 MoonTVPlus，数据存在 Turso（免费 SQLite 云），
> 登录页/注册页用的是本仓库 `.skin/` 里的皮肤版，主站配色也是皮肤版。

- [0. 先看结论](#0-先看结论)
- [1. 架构与依赖关系](#1-架构与依赖关系)
- [2. 前置条件](#2-前置条件)
- [3. 第一步：Fork 仓库并克隆到本地](#3-第一步fork-仓库并克隆到本地)
- [4. 第二步：创建 Turso 数据库](#4-第二步创建-turso-数据库)
- [5. 第三步：初始化数据库表结构](#5-第三步初始化数据库表结构)
- [6. 第四步：获取 EdgeOne API Token](#6-第四步获取-edgeone-api-token)
- [7. 第五步：配置 GitHub Secrets](#7-第五步配置-github-secrets)
- [8. 第六步：启用 workflow](#8-第六步启用-workflow)
- [9. 第七步：触发部署](#9-第七步触发部署)
- [10. 第八步：验证部署结果](#10-第八步验证部署结果)
- [11. 皮肤到底是怎么上的](#11-皮肤到底是怎么上的)
- [12. 日常运维](#12-日常运维)
- [13. 排错手册](#13-排错手册)
- [14. 附录](#14-附录)

---

## 0. 先看结论

如果你只想最快跑通，按这个顺序执行（细节在后面的章节）：

```
# 1. Turso 建库（在装了 turso CLI 的机器上）
turso db create moontvplus
turso db show moontvplus --url        # → libsql://moontvplus-xxx.turso.io
turso db tokens create moontvplus     # → eyJhbGci...

# 2. GitHub Secrets（在本仓库目录执行）
gh secret set TURSO_URL       -b "libsql://moontvplus-xxx.turso.io"
gh secret set TURSO_TOKEN     -b "eyJhbGci..."
gh secret set NEXT_PUBLIC_STORAGE_TYPE -b "turso"
gh secret set USERNAME        -b "admin"
gh secret set PASSWORD        -b "你的强密码"
gh secret set EDGEONE_API_TOKEN -b "EdgeOne 控制台生成的 Token"

# 3. 初始化数据库（第一次必须先跑迁移，否则站点打开就是空表报错）
gh workflow run turso-migrate.yml

# 4. 启用并触发部署
gh workflow enable edgeone-deploy.yml
gh workflow run edgeone-deploy.yml -f project_name=moontvplus -f area=overseas -f sync_environment=true

# 5. 看进度
gh run watch
```

跑完 Actions 的 Summary 里会打印 `Deploy URL`，打开它 → 登录页就是皮肤版。

---

## 1. 架构与依赖关系

```
GitHub 仓库（你的 fork）
   │
   │  .github/workflows/edgeone-deploy.yml   ← 手动触发（workflow_dispatch）
   ▼
GitHub Actions (ubuntu-latest, Node 24, pnpm 10.14.0)
   │
   ├─ 1. pnpm install --frozen-lockfile
   ├─ 2. node scripts/skin-overlay.mjs           ← 皮肤覆盖（本文 11 章）
   ├─ 3. node scripts/skin-overlay.mjs --check   ← 皮肤断言，失败即中断
   ├─ 4. 把 ~60 个 Secrets 导进 $GITHUB_ENV
   ├─ 5. pnpm run build:edgeone
   │       └─ node scripts/edgeone-build.mjs
   │            ├─ 再调一次 skin-overlay（平台侧构建也会命中，见 11.2）
   │            ├─ next build  (BUILD_TARGET=edgeone EDGEONE_PAGES=1)
   │            ├─ 输出 .edgeone/（含 cloud-functions/ssr-node + 静态资源）
   │            └─ 修补 edge function 的 env 注入 / 路由 / handler 状态码
   ├─ 6. pnpm exec edgeone makers deploy .edgeone -n <项目名> -t <Token>
   │       └─ 输出 EDGEONE_DEPLOY_URL= / EDGEONE_PROJECT_ID=
   ├─ 7. edgeone makers env set <KEY> <VALUE> 逐个同步环境变量
   ├─ 8. 再 deploy 一次（让第 7 步的变量真的进到运行实例）
   └─ 9. 写 $GITHUB_STEP_SUMMARY

EdgeOne Makers 边缘节点
   ├─ 静态资源（HTML/CSS/JS、/icons/skin/*.mp4 → 皮肤背景视频）
   └─ cloud-functions/ssr-node（Next.js SSR 运行时）
          │
          └─ @libsql/client/http  →  HTTPS  →  Turso（libSQL，SQLite 语法）
```

三个关键结论，先记住，后面会反复用到：

1. **EdgeOne 不自带数据库**。所以必须外接 Turso（或 Upstash Redis），否则 `NEXT_PUBLIC_STORAGE_TYPE`
   只能退化到 `localstorage`——那是纯浏览器本地存储，换设备就丢数据，多用户也无法共享。
2. **Secrets 只负责「构建期」**。`NEXT_PUBLIC_*` 变量会在 `next build` 时被烤进客户端 bundle，
   所以它们是 Secrets 而不是 Project Env；服务端变量（`TURSO_URL`、`TURSO_TOKEN`）虽然构建期也要，
   但真正运行时读的是第 7 步 `env set` 同步进去的那一份。这就是为什么要部署两次。
3. **皮肤是在构建期「文件覆盖」实现的**，不是运行时开关。想不带皮肤部署，见 11.3。

---

## 2. 前置条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| GitHub 账号 | 有 Actions 额度 | 私有仓库每月 2000 分钟免费，公开仓库不限 |
| 腾讯云 / EdgeOne 账号 | 已开通 Makers | <https://edgeone.ai/pages/new> |
| Turso 账号 | 免费套餐够用 | <https://turso.tech/>，免费档有 500 个库、总容量 5GB 量级 |
| 本地 Node.js | ≥ 20（CI 用 24） | 只为本地跑 `scripts/*.mjs` 和 `init:turso` |
| 本地 pnpm | 10.14.0（见 `packageManager`） | `corepack enable` 后自动按 package.json 取版本 |
| gh CLI | 建议装 | 本文大量用 `gh secret set` / `gh workflow run`，比点网页快 |

验证本地环境：

```bash
node -v          # v20.x 或更高
pnpm -v          # 10.14.0
gh --version     # 任一新版本
gh auth status   # 应显示 Logged in to github.com account <你的账号>
```

> **国内网络提示**：`gh`、`git`、`pnpm install`、`turso` 都可能被墙。
> 若你本地有混合代理端口（例如 Clash 的 10808），在每个新终端里显式导出：
>
> ```powershell
> # PowerShell
> $env:HTTPS_PROXY="http://127.0.0.1:10808"; $env:HTTP_PROXY="http://127.0.0.1:10808"
> ```
>
> ```bash
> # bash / zsh
> export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808
> ```
>
> gh CLI 读 `HTTPS_PROXY`；`git` 的 **schannel** 后端在代理下会报
> `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`，
> 换 openssl 后端即可：`git -c http.sslBackend=openssl clone ...`。

---

## 3. 第一步：Fork 仓库并克隆到本地

### 3.1 Fork

网页点 Fork，或用 CLI：

```bash
gh repo fork Weiming31/MoonTVPlus --clone=false
```

Fork 之后你的仓库会继承 `main` 分支上的全部内容，包括：

- `.skin/` 皮肤源文件（**本仓库相对上游 mtvpls/MoonTVPlus 多出来的一坨**）
- `.github/workflows/skin-image.yml`（Docker 镜像，自带皮肤）
- `.github/workflows/edgeone-deploy.yml`（EdgeOne 部署，构建时也会套皮肤，见 11 章）
- `.github/workflows/turso-migrate.yml`（Turso 建表）
- `.github/workflows/sync-upstream.yml`（每天北京时间 03:10 自动同步上游）

### 3.2 克隆

```bash
# 走代理 + openssl 后端（Windows 上 schannel 有坑，见 2 章提示）
git -c http.sslBackend=openssl clone https://github.com/<你的账号>/MoonTVPlus.git
cd MoonTVPlus

# 补一个 upstream，方便后续手动同步
git remote add upstream https://github.com/mtvpls/MoonTVPlus.git
git remote -v
```

### 3.3 装依赖

```bash
corepack enable
pnpm install --frozen-lockfile
```

> `--frozen-lockfile` 是 CI 用的严格模式：`pnpm-lock.yaml` 与 `package.json` 对不上就直接失败。
> 本地想改依赖就换成 `pnpm install`。

---

## 4. 第二步：创建 Turso 数据库

Turso 是 libSQL（SQLite 分支）的托管服务，HTTP 协议在边缘环境里可用，这是选它的核心原因：
Cloudflare Workers / EdgeOne 这类运行时**不能跑原生 SQLite 二进制**，只能走 HTTP。

### 4.1 装 Turso CLI

```bash
# macOS
brew install tursodatabase/tap/turso

# Linux / macOS 通用兜底
curl -sSfL https://get.tur.so/install.sh | bash

# Windows：Turso 没有原生 Windows 二进制，必须先装 WSL
#   PowerShell 里执行 wsl，进入 Linux 后：
curl -sSfL https://get.tur.so/install.sh | bash
```

验证：

```bash
turso --version
```

**不想装 CLI 也行**，Turso 有 Web 控制台：<https://turso.tech/app> → Create Database。
建完在数据库详情页能直接看到 URL 和创建 Token 的按钮。CLI 只是快。

### 4.2 登录

```bash
turso auth login
```

会拉起浏览器。没有图形界面的环境（WSL、远程服务器、CI）用：

```bash
turso auth login --headless
turso auth whoami       # 确认真登录上了
```

### 4.3 建库

```bash
turso db create moontvplus
```

- 名字随你，但**后面所有 Secrets 要保持一致**，本文统一用 `moontvplus`。
- 不写名字时 Turso 会用你当前项目目录名，容易搞混，建议显式写。
- 有多个 group 时必须加 `--group <group-name>`。
- 常用可选参数：`--size-limit 1gb`（限额）、`-w/--wait`（等就绪再返回）。

### 4.4 拿 URL

```bash
turso db show moontvplus --url
```

输出形如：

```
libsql://moontvplus-<组织名>.turso.io
```

这一串就是 `TURSO_URL`。注意：

- **协议是 `libsql://`，不是 `https://`**。项目里 `@libsql/client/http` 会自己转成 HTTPS，
  写 `https://` 也能用，但 `libsql://` 是官方推荐。
- 库名/组织名部分带随机后缀，别手工猜。

### 4.5 拿 Token

```bash
turso db tokens create moontvplus
```

输出一长串 JWT，这就是 `TURSO_TOKEN`。

参数：

| 参数 | 含义 |
| --- | --- |
| `-e, --expiration` | 有效期，`never` 或 `7d` / `7d3h2m1s` |
| `-r, --read-only` | 只读 Token |

**建议**：`turso db tokens create moontvplus -e never`，否则到期后站点直接 500，而且报错很难懂
（`HTTP 401: unable to authenticate your request`）。若你坚持设过期，就在日历上记一天轮换。

> 想立刻验一下这两个值对不对：
>
> ```bash
> curl -sS -X POST "$TURSO_URL/v2/pipeline" \
>   -H "Authorization: Bearer $TURSO_TOKEN" \
>   -H "Content-Type: application/json" \
>   -d '{"requests":[{"type":"execute","stmt":{"sql":"select sqlite_version()"}},{"type":"close"}]}'
> ```
>
> 返回里有 `"type":"ok"` 和版本号就说明 URL/Token 都对。返回 `Unauthorized` 就是 Token 错。

### 4.6 不装 CLI 的替代路径：REST API

```bash
# 建库（TOKEN 是 Turso 平台 Token，不是数据库 Token）
curl -X POST "https://api.turso.tech/v1/organizations/<org-slug>/databases" \
  -H "Authorization: Bearer $TURSO_PLATFORM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"moontvplus","group":"default"}'

# 给这个库建数据库 Token
curl -X POST "https://api.turso.tech/v1/organizations/<org-slug>/databases/moontvplus/auth/tokens" \
  -H "Authorization: Bearer $TURSO_PLATFORM_TOKEN" \
  -d '{}'
```

---

## 5. 第三步：初始化数据库表结构

**这一步不能跳。** 空库直接部署，站点能打开但一切读写都会报 `no such table: users`。

### 5.1 `scripts/init-turso.js` 到底干了什么

读一下会比盲跑放心（逻辑就在这一个文件里，205 行）：

1. 用 `require('@libsql/client/http')` 连库（**只取 http 子入口**，避免把原生 libsql 二进制拉进来）。
2. 建 `schema_migrations(filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)` 记录表。
3. 按文件名排序遍历 `migrations/*.sql`（**16 个**，001 → 016），逐个执行：
   - 已记录在 `schema_migrations` 的跳过；
   - 语句级容错：`table ... already exists`、`index ... already exists`、`duplicate column name` 三类错误忽略；
   - 其它错误直接抛，退出码 1。
4. 老库兼容（`MIGRATION_BASELINE_CUTOFF = '008_web_push_notifications.sql'`）：
   如果库里**已经有 `users` 表但 `schema_migrations` 是空的**（说明是从旧版本迁过来的），
   就把 001–007 全部标记为已应用，只从 008 往后跑。避免在老数据上重复建表炸掉。
5. 建默认站长：读 `USERNAME`（默认 `admin`）/ `PASSWORD`（默认 `123456789`），
   用 `crypto.createHash('sha256')` 哈希，插一行 `role='owner'`。
   用户名已存在就跳过（**不会覆盖你改过的密码**）。

> ⚠️ **`PASSWORD` 必须在第一次跑迁移之前就设好**。
> 因为它是「已存在则跳过」，等你部署完再去改 Secret，站长密码不会跟着变——
> 得进后台改，或者手工 `delete from users where username='admin'` 后重跑。

### 5.2 方式 A：GitHub Actions（推荐）

仓库里 `.github/workflows/turso-migrate.yml` 就是干这个的，它跑之前会先校验四个 Secret 是否齐全：

```
TURSO_URL / TURSO_TOKEN / USERNAME / PASSWORD
```

缺任何一个会直接 `::error::Missing required GitHub secret: XXX` 并退出。

```bash
gh secret set TURSO_URL   -b "libsql://moontvplus-xxx.turso.io"
gh secret set TURSO_TOKEN -b "你的 token"
gh secret set USERNAME    -b "admin"
gh secret set PASSWORD    -b "你的强密码"

gh workflow run turso-migrate.yml
gh run watch
```

看到 `🎉 Turso database is ready!` 就成功。

### 5.3 方式 B：本地跑

```bash
export TURSO_URL="libsql://moontvplus-xxx.turso.io"
export TURSO_TOKEN="你的 token"
export USERNAME="admin"
export PASSWORD="你的强密码"

pnpm install
node scripts/init-turso.js      # 等价于 pnpm init:turso
```

PowerShell：

```powershell
$env:TURSO_URL="libsql://..."; $env:TURSO_TOKEN="..."; $env:USERNAME="admin"; $env:PASSWORD="强密码"
node scripts/init-turso.js
```

### 5.4 验证表建好了

```bash
turso db shell moontvplus "select name from sqlite_master where type='table' order by name;"
turso db shell moontvplus "select filename from schema_migrations order by filename;"
turso db shell moontvplus "select username, role, length(password_hash) from users;"
```

期望：

- 表清单里有 `users`、`play_records`、`favorites`、`skip_configs`、`schema_migrations` 等；
- `schema_migrations` 有 16 行；
- `users` 里有一行 `admin | owner | 64`（sha256 十六进制长度）。

---

## 6. 第四步：获取 EdgeOne API Token

路径：Makers 控制台 → 左侧 **API Token** 标签页 → **Create API Token**

1. `Token description`：随便写，建议写清楚用途，例如 `github-actions-moontvplus`；
2. `expiration time`：下拉从 **1 天到 1 年**。**流水线用的 Token 别选 1 天**，选 1 年并记好到期日；
3. Submit，然后**立刻复制**（列表页之后只显示末几位）。

几个容易踩的点：

- Token 是 **Makers 平台**的，不是腾讯云 API 密钥（SecretId/SecretKey）——两套体系，别拿错。
- Token 有区域属性。你本地 `edgeone login` 时选的 `--site china|global` 决定它属于哪个站，
  **在 A 站申请的 Token 去 B 站部署会 401**。本仓库的 workflow 默认 `area=overseas`，用 Global 站点的 Token。
- Token 泄露 = 别人能用你的 Makers 额度。轮换方式见 12.4。

---

## 7. 第五步：配置 GitHub Secrets

路径：仓库 → **Settings → Secrets and variables → Actions → New repository secret**。

### 7.1 必需项（少一个就部署失败）

| Secret | 作用 | 取值 |
| --- | --- | --- |
| `EDGEONE_API_TOKEN` | 部署凭证 | 第 6 章拿到的 Token |
| `TURSO_URL` | 数据库地址 | `libsql://moontvplus-xxx.turso.io` |
| `TURSO_TOKEN` | 数据库凭证 | 第 4.5 节的 JWT |
| `NEXT_PUBLIC_STORAGE_TYPE` | 选存储后端 | **`turso`**（写错成 `localstorage` 就是纯前端存储） |
| `USERNAME` | 站长账号 | 例如 `admin` |
| `PASSWORD` | 站长密码 | 强密码，**迁移前设好**（见 5.1 警告） |

### 7.2 强烈建议一起配（不配会有功能残缺）

| Secret | 说明 |
| --- | --- |
| `NEXT_PUBLIC_SITE_NAME` | 站点名，显示在标题栏、PWA 名称 |
| `NEXT_PUBLIC_SITE_DESC` / `ANNOUNCEMENT` | 公告文本 |
| `TMDB_API_KEY` | 豆瓣/TMDB 元数据，不配则海报和简介抓不到 |
| `SITE_BASE` | 你的最终域名，例如 `https://tv.example.com` |
| `NEXT_PUBLIC_APP_URL` | 同上，用于生成绝对链接（推送到 PWA、分享） |
| `CRON_PASSWORD` | 定时任务（如自动抓取）的校验口令 |
| `ENABLE_REGISTER` | `true` 才开放注册 |

### 7.3 用 gh CLI 一次配完

这个 workflow 里有个 step 会把**约 60 个** Secret 逐个写进 `$GITHUB_ENV`（`edgeone-deploy.yml:148-168` 的 `keys` 数组），
**你填了几个它就导出几个，没填的自动跳过**。所以只配必需项也能跑，不会因为缺变量而报错。

```bash
gh secret set EDGEONE_API_TOKEN -b "EdgeOne Token"
gh secret set TURSO_URL -b "libsql://moontvplus-xxx.turso.io"
gh secret set TURSO_TOKEN -b "你的 JWT"
gh secret set NEXT_PUBLIC_STORAGE_TYPE -b "turso"
gh secret set USERNAME -b "admin"
gh secret set PASSWORD -b "你的强密码"

# 可选
gh secret set NEXT_PUBLIC_SITE_NAME -b "MoonTVPlus"
gh secret set TMDB_API_KEY -b "你的 key"
gh secret set SITE_BASE -b "https://tv.example.com"

# 核对
gh secret list
```

> **`NEXT_PUBLIC_*` 为什么必须是 Secret 而不是 Variable？**
> 它们在 `next build` 时被静态替换进客户端 JS。真正的 GitHub *Variables* 也会注入到 runner 环境，
> 但这个 workflow 的导出逻辑只读 `secrets.*`（见 `env:` 段），所以走 Variables 不会被带上。
>
> **例外**：仓库变量 `SKIN_OVERLAY`（见 11.3）是故意读 `vars.SKIN_OVERLAY` 的，用于临时关皮肤。

### 7.4 关于 "sync_environment"

部署第 7 步会用 `edgeone makers env set` 把这些变量写进 **EdgeOne 项目**的环境变量，
第 8 步再部署一次让运行实例读到它们。这个行为由 `sync_environment` 输入控制，默认 `true`。

- 第一次部署：**保持 `true`**，否则运行时读不到 `TURSO_URL/TURSO_TOKEN`，站点必然 500。
- 后续只改了代码没改变量：可以设 `false` 省一次部署时间（约省 1–2 分钟）。
- 改了任何 Secret：必须 `true`。

---

## 8. 第六步：启用 workflow

**这是新手最容易卡住的地方**：仓库里明明有 `edgeone-deploy.yml`，
但 Actions 页面左侧找不到它。

原因：GitHub 对 `workflow_dispatch` 类 workflow，如果历史上被禁用过（或从 fork 继承时处于
`disabled_manually` 状态），它不会出现在默认列表里。`gh workflow list` 默认只列 active 的。

先看全量：

```bash
gh workflow list -a
```

再看带状态的完整清单：

```bash
gh api repos/<你的账号>/MoonTVPlus/actions/workflows \
  --jq '.workflows[] | [.id, .name, .path, .state] | @tsv'
```

典型输出（本仓库）：

```
426838719  Android TV Build        .github/workflows/android-tv.yml        disabled_manually
426838720  Deploy to Cloudflare    .github/workflows/cloudflare-deploy.yml disabled_manually
426838721  Docker Image (dev)      .github/workflows/docker-image-dev.yml  disabled_manually
426838723  Docker Image (lite)     .github/workflows/docker-image-lite.yml disabled_manually
426838724  Docker Image            .github/workflows/docker-image.yml      disabled_manually
426838725  Deploy to EdgeOne       .github/workflows/edgeone-deploy.yml    active
426838726  Turso Database Migration .github/workflows/turso-migrate.yml    active
426846648  Build skin image        .github/workflows/skin-image.yml        active
426846650  Sync upstream           .github/workflows/sync-upstream.yml     active
```

启用：

```bash
gh workflow enable edgeone-deploy.yml
gh workflow enable turso-migrate.yml

# 确认
gh workflow list
```

> 只想用 EdgeOne 的话，`docker-image*` / `cloudflare-deploy` / `android-tv` 保持 disabled 就行，
> 它们每周都会因为 cron 白跑一次，白烧 Actions 分钟数。

---

## 9. 第七步：触发部署

workflow 有三个输入（`edgeone-deploy.yml:4-23`）：

| 输入 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `project_name` | string | `moontvplus` | EdgeOne 项目名，**不存在会自动创建** |
| `area` | choice：`overseas` / `global` | `overseas` | 部署区域。`overseas` = 全球可用区（不含中国大陆）；`global` = 全球可用区 |
| `sync_environment` | boolean | `true` | 是否同步环境变量并二次部署 |

### 9.1 网页触发

Actions → 左侧 **Deploy to EdgeOne** → 右上 **Run workflow** → 选分支 `main` → 填三个输入 → Run。

### 9.2 CLI 触发

```bash
gh workflow run edgeone-deploy.yml \
  -f project_name=moontvplus \
  -f area=overseas \
  -f sync_environment=true

# 看实况
gh run list --workflow=edgeone-deploy.yml --limit 3
gh run watch
```

### 9.3 一次成功的运行长什么样

12 个 step 依次是（`python -c "import yaml..."` 可自行校验结构）：

```
Checkout source code
Setup pnpm
Setup Node.js
Install dependencies
Apply skin overlay          ← 皮肤覆盖
Verify skin overlay         ← 皮肤断言（失败即中断）
Export build environment variables
Build for EdgeOne
Deploy to EdgeOne
Sync EdgeOne environment variables
Redeploy after environment sync
Deployment summary
```

`Apply skin overlay` 的日志应当出现：

```
[skin] 覆盖 16 个皮肤文件到仓库根
[skin] 主题皮肤 → public/icons/skin/theme.css（28.9 KB）
[skin] 校验通过：登录/注册页、auth-skin 组件、6 个背景资源、PWA 图标齐全
[skin] 主站主题皮肤已就位：部署后在后台自定义 CSS 粘一行 @import url("/icons/skin/theme.css");
```

`Verify skin overlay` 会额外打印 `git status --porcelain`，让你看清覆盖动了哪些文件，例如：

```
M public/favicon.ico
M public/icons/icon-192x192.png
M public/icons/icon-256x256.png
M public/icons/icon-384x384.png
M public/icons/icon-512x512.png
M src/app/login/page.tsx
M src/app/register/page.tsx
?? public/icons/skin/
?? src/components/auth-skin/
```

`Deploy to EdgeOne` 的日志末尾会有：

```
EDGEONE_DEPLOY_URL=https://moontvplus-xxx.edgeone.app
EDGEONE_PROJECT_ID=pages-xxxxxxxxxxxx
```

这两个值被写进 `$GITHUB_OUTPUT`，最后汇总到 Summary。

> **关于 `-a` / `--area`**：本仓库 workflow 用的是 `edgeone makers deploy .edgeone -n ... -t ... -a "$EDGEONE_AREA"`。
> 官方 CLI 文档目前列的是 `--site china|global`，`-a` 属于仓库里在用的写法。
> 如果你的 CLI 版本报 `unknown option '-a'`，把该 step 改成
> `--site global`（`edgeone makers deploy -h` 是最终依据）。

---

## 10. 第八步：验证部署结果

按顺序验，出问题能立刻定位是哪一层坏了。

### 10.1 站点能打开

```bash
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://<deploy-url>/
```

期望 `200`，否则见 13 章 `HTTP 5xx`。

### 10.2 皮肤生效（登录页）

打开 `https://<deploy-url>/login`，应看到：

- 全屏背景视频在播（1440 或 640 档，随视口宽度切换）；
- 标题「登录」居中（`auth-title--center`）；
- 底部有版本号徽标（`VersionBadge`）；
- 不是上游那套白底卡片表单。

浏览器控制台执行：

```js
// 皮肤组件在不在
document.querySelector('.auth-shell') !== null        // true
document.querySelector('.auth-title--center') !== null // true
// 背景资源 200 而不是 404
await fetch('/icons/skin/login-bg-poster-1440.webp').then(r => r.status)
```

### 10.3 主站主题皮肤（配色）

皮肤版主题 CSS 已经随构建落到 `/icons/skin/theme.css`。启用方式：

1. 用站长账号登录，进 **后台 → 主题设置**；
2. `启用自定义 CSS`（或让内置主题关闭）；
3. 在 `customCSS` 里粘一行：

   ```css
   @import url("/icons/skin/theme.css");
   ```

4. 保存，刷新首页。主色应变成 `#ef2657`（浅色）/ `#ff3d6e`（深色），次色 `#6440f0` / `#7b5cff`。

验证：

```bash
curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" https://<deploy-url>/icons/skin/theme.css
# 期望 200 和 ~29000 字节

curl -sS https://<deploy-url>/api/theme/css | head -c 200
# 期望看到 @import url("/icons/skin/theme.css");
```

### 10.4 数据库真的通了

这是最容易被忽略的一步——皮肤对了不代表存储对了。

1. 登录 → 随便收藏一个条目 → 刷新页面 → 收藏还在；
2. 换一个浏览器（或隐身窗口）登录同一账号 → 收藏同步可见（说明不是 localStorage）；
3. 直接查库：

   ```bash
   turso db shell moontvplus "select count(*) from favorites;"
   turso db shell moontvplus "select username, role from users;"
   ```

   数字随你操作变化 = Turso 链路通。

### 10.5 环境变量就位

```bash
# 需要一个能打 EdgeOne API 的上下文；最简单是看 Actions 里 Sync step 的日志，
# 应逐行打印 "Syncing TURSO_URL" / "Syncing NEXT_PUBLIC_STORAGE_TYPE" ...
```

或者在浏览器里验证：站点「关于/版本」页若能看到站点名（来自 `NEXT_PUBLIC_SITE_NAME`），
说明构建期变量生效了。

---

## 11. 皮肤到底是怎么上的

本章是「为什么这个 fork 和上游不一样」的完整解释。只想用不想改可以跳过，但排错时会用到。

### 11.1 皮肤由什么组成

```
.skin/
├── theme.css                                   # 主站主题（409 行，全部 !important 覆盖 tailwind）
└── files/                                      # 按仓库相对路径组织，覆盖即生效（16 个文件）
    ├── public/
    │   ├── favicon.ico
    │   ├── icons/icon-{192,256,384,512}x*.png  # PWA / iOS 主屏图标
    │   └── icons/skin/
    │       ├── login-bg-1440.{av1,h264}.mp4     # 1440 档背景视频（AV1 + H.264 双编码）
    │       ├── login-bg-640.{av1,h264}.mp4      # 640 档（窄屏，体积小）
    │       ├── login-bg-poster-1440.webp        # 视频首帧占位
    │       └── login-bg-poster-640.webp
    └── src/
        ├── app/login/page.tsx                   # 整页替换的皮肤版登录页
        ├── app/register/page.tsx                # 整页替换的皮肤版注册页
        └── components/auth-skin/
            ├── AuthShell.tsx                    # 背景层组件（LQIP → poster → video 三段降级）
            ├── VersionBadge.tsx                 # 版本号徽标
            └── auth-skin.css                    # .auth-* 前缀的样式，19KB
```

设计上刻意遵守两条纪律：

1. **只做文件覆盖，不改任何业务逻辑、不改任何 `className`。**
   皮肤版 `page.tsx` 是上游页面的等价重写（同样的 hooks、同样的 API 调用），
   只是把渲染层换成 `<AuthShell>`。所以上游修 bug 时，`sync-upstream.yml` 合并通常不冲突；
   一旦上游动了这两个页面，workflow 会打 `::warning::上游改动了登录/注册页，皮肤版可能落后于新逻辑`。
2. **`AuthShell.tsx` 的三层背景是刻意的**：LQIP（内联 data-URI 极小图）先铺底色 →
   poster（webp）立刻可见 → 视频加载完成后淡入。任何一层缺失都会降级而不是白屏。
   视频 `<source>` 的 `type` 只写 `video/mp4`，**不带 `codecs=`**——写错会导致浏览器
   `NETWORK_NO_SOURCE` 直接不播（源码里有注释专门记了这个坑）。

### 11.2 三条部署路径怎么共用一份皮肤

| 部署方式 | 谁做覆盖 | 在哪一行 |
| --- | --- | --- |
| Docker 镜像 | `skin-image.yml` 里 `cp -rv .skin/files/. ./` + 一组 grep 断言 | 构建 step |
| **EdgeOne（Actions）** | `node scripts/skin-overlay.mjs` | `edgeone-deploy.yml` 的 `Apply skin overlay` step |
| **EdgeOne（平台侧构建）** | `scripts/edgeone-build.mjs` 模块作用域直接调 `applySkinOverlay()` | 构建脚本入口 |

第三条为什么必须存在：EdgeOne 平台有自己的构建器，当它拿仓库去构建时会直接执行
`edgeone.json` 里的 `buildCommand: pnpm edgeone:build`，**完全不经过 GitHub Actions 的 step**。
所以只改 workflow 是盖不住的——覆盖逻辑必须嵌进 `edgeone-build.mjs` 本身。

`scripts/skin-overlay.mjs` 的行为（207 行，全部逻辑一个文件）：

```bash
node scripts/skin-overlay.mjs            # 覆盖 + 断言
node scripts/skin-overlay.mjs --check    # 只断言当前工作区是不是皮肤版（不写盘）
node scripts/skin-overlay.mjs --quiet    # 静音（仍会输出错误）
SKIN_OVERLAY=0 node scripts/skin-overlay.mjs   # 显式跳过，返回 0
```

断言清单（任一失败 → 退出码 1，让流水线立刻红，**绝不把半覆盖产物静默发出去**）：

- `src/app/login/page.tsx` 含 `AuthShell`
- `src/app/register/page.tsx` 含 `AuthShell`
- 存在 `src/components/auth-skin/AuthShell.tsx`
- 存在 `src/components/auth-skin/auth-skin.css`
- 登录页含 `auth-title--center`
- 登录页**不含** `className='auth-sub'`（注意必须带引号精确匹配，因为按钮类名 `auth-submit`
  也含 `auth-sub` 子串，裸匹配会误判）
- 6 个 `public/icons/skin/login-bg-*` 都存在且非空
- 4 个 `public/icons/icon-{192,256,384,512}x*.png` 都存在且非空
- `public/favicon.ico` 存在

跑完还会把 `.skin/theme.css` 复制到 `public/icons/skin/theme.css`（约 28.9 KB），
这样 `/icons/skin/theme.css` 这个 URL 才是真的 200，后台只要粘一行 `@import` 即可
（Docker 镜像过去要求用户手动粘 30KB 全文，这里省掉那步）。

### 11.3 想临时部署「不带皮肤」的版本

仓库变量（**不是** Secret）：

```
Settings → Secrets and variables → Actions → Variables → New repository variable
Name:  SKIN_OVERLAY
Value: 0
```

`edgeone-deploy.yml` 的 `Apply skin overlay` step 读的是 `${{ vars.SKIN_OVERLAY }}`，
值为 `0` 或 `false` 时脚本打印「跳过皮肤覆盖（将部署上游原生外观）」并返回 0。

注意两点：

- 改完变量**要重新跑一次部署**才生效（构建期决定）。
- 平台侧构建（不经 Actions）走的是 `edgeone-build.mjs`，它读的是进程环境里的 `SKIN_OVERLAY`，
  在 EdgeOne 项目环境变量里设 `SKIN_OVERLAY=0` 也能关掉。

### 11.4 本地想预览皮肤效果

```bash
node scripts/skin-overlay.mjs     # 先把皮肤铺到工作区
pnpm dev                          # 普通 Next 开发服务器
# 或
pnpm preview:edgeone              # BUILD_TARGET=edgeone EDGEONE_PAGES=1 的 EdgeOne 预览
```

跑完记得回滚，别把覆盖产物提交上去（它们本身是 `.skin/files/` 的镜像，
提交会让 `sync-upstream` 的 merge 变难）：

```bash
git checkout -- public/favicon.ico public/icons/icon-*.png \
                src/app/login/page.tsx src/app/register/page.tsx
rm -rf src/components/auth-skin public/icons/skin
```

> `.gitignore` 里**没有**忽略 `public/icons/skin/`——这是刻意的，皮肤资源本身需要提交；
> 但 `theme.css` 是 overlay 产物，如果你不想让它进版本库，就手工加一行忽略。

---

## 12. 日常运维

### 12.1 改了代码怎么重新部署

```bash
git add -A && git commit -m "feat: xxx" && git push origin main
gh workflow run edgeone-deploy.yml -f sync_environment=false
```

> 想 push 到 main 更省事：`workflow_dispatch` 只手动触发，没有 `push` 触发器；
> 如果你希望 push 即部署，自己在 `on:` 里加：
>
> ```yaml
> on:
>   push:
>     branches: [main]
> ```

### 12.2 同步上游

`sync-upstream.yml` 每天 UTC 19:10（北京时间 03:10）自动跑：

1. `git ls-remote https://github.com/mtvpls/MoonTVPlus.git refs/heads/main` 取上游 HEAD；
2. `git cat-file -e` 判断这个 commit 是否已在本地（已含则跳过）；
3. `git merge --no-edit upstream/main`；
4. 冲突则 `git merge --abort` + `::error::上游改动与皮肤分支冲突，请手动合并后再推送` + 退出 1；
5. 检测上游是否改过 `src/app/login/page.tsx` / `src/app/register/page.tsx`，改过就打 warning；
6. `git push origin HEAD:main`。

冲突了怎么办：

```bash
git fetch upstream
git merge upstream/main
# 冲突文件里优先保留「皮肤的渲染层 + 上游的业务逻辑」
git add -A && git commit && git push origin main
```

皮肤文件相关冲突的判定原则：`AuthShell.tsx` / `auth-skin.css` 是新增文件，不会冲突；
冲突一定在 `login/page.tsx` / `register/page.tsx` 的「整页替换」上——以皮肤版为骨架，
把上游新增的 hooks / 状态 / API 调用搬进去。

### 12.3 备份数据库

两种方式，看你要「快照」还是「可读 SQL」。

```bash
# 方式一：导出为本地 SQLite 快照（官方推荐）
turso db export moontvplus --output-file backup-$(date +%F).db
# 默认输出 ./<database>.db；已存在会报错，需加 --overwrite；--with-metadata 带上元数据

# 方式二：导出为纯 SQL 文本（可读、可 diff、可跨版本重建）
turso db shell moontvplus .dump > dump.sql
# .dump 不含 libSQL/SQLite 内部表，可直接灌进新库：
turso db shell moontvplus-restore < dump.sql
```

> `db export` 导出的是**当前 generation 的快照**，可能不含最后几秒的写入；
> 要绝对新鲜就用 `.dump`（走 shell，读的是实时数据）。

恢复成一个新库：

```bash
# 从 SQLite 文件建库（单个文件上限 2GB）
turso db create moontvplus-restore --from-file backup-2026-11-23.db

# 或者建空库再灌 SQL
turso db create moontvplus-restore
turso db shell moontvplus-restore < dump.sql
```

要切到恢复出来的库，把 `TURSO_URL` / `TURSO_TOKEN` 换掉后重跑部署（`sync_environment=true`）即可。

### 12.4 轮换 Token

```bash
# Turso：建新的，更新 Secret，旧的可以留着当备用
turso db tokens create moontvplus -e never
gh secret set TURSO_TOKEN -b "<新 token>"
gh workflow run edgeone-deploy.yml -f sync_environment=true

# EdgeOne：控制台删旧建新
gh secret set EDGEONE_API_TOKEN -b "<新 token>"
gh workflow run edgeone-deploy.yml -f sync_environment=true
```

`edgeone-deploy.yml` 开头有 concurrency 组 `${{ github.workflow }}-${{ github.ref }}`
且 `cancel-in-progress: true`，所以连点两次 Run 不会打架——后一次会取消前一次。

---

## 13. 排错手册

### 13.1 部署类

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| Actions 左侧没有 "Deploy to EdgeOne" | workflow 处于 `disabled_manually` | `gh workflow enable edgeone-deploy.yml`（见 8 章） |
| `EDGEONE_API_TOKEN secret is required` | Secret 没配或名字拼错 | `gh secret list` 核对；注意是 `EDGEONE_API_TOKEN` 不是 `EDGEONE_TOKEN` |
| deploy 401 / `unable to authenticate` | Token 属于另一区域（china vs global），或已过期 | 用对应站点的 Token；控制台看过期时间 |
| deploy 报 `project not found` 但项目明明有 | `project_name` 大小写/前缀不一致 | 控制台复制项目名，**区分大小写** |
| `unknown option '-a'` | 你的 CLI 版本参数名不同 | 改成 `--site global`（以 `edgeone makers deploy -h` 为准） |
| 部署成功但打开 404 | 输出目录不对（CLI 没拿到 `.edgeone`） | 手动构建时要确保 `.edgeone/` 里含 `cloud-functions/` 和 `package.json` |
| 站点能开但样式全丢 | 静态资源没上传完整 | 看 Summary 的总产物大小；`.edgeone/` 里应含 `_next/static/` |

### 13.2 数据库类

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `TURSO_URL and TURSO_TOKEN env variables must be set for Turso storage` | 运行时没读到变量 | `sync_environment=true` 重跑；或到 EdgeOne 控制台手工加这两个环境变量 |
| `TursoStorage can only be used on the server side` | 有客户端组件间接 import 了 `db.ts` | 检查是否在 `'use client'` 文件里引了服务端模块；这条是护栏，不是 bug |
| 站点 500，日志 `no such table: users` | 没跑迁移 | 跑第 5 章 |
| `HTTP 401: unable to authenticate your request` | Token 过期 / 复制时截断 / 属于别的库 | 重新 `turso db tokens create moontvplus`，注意 Token 对应**单个数据库** |
| 读能读、写报错 | 用了 `--read-only` Token | 重建不带 `-r` 的 Token |
| `SQLITE_BUSY` / 写入偶发失败 | 并发写打满 | `TursoAdapter` 用 `batch(..., 'write')` 已做批处理；仍频繁则减少写放大，或升级套餐 |
| 迁移报 `table xxx already exists` 但脚本没跳过 | 报错文本不含预期关键词 | 手工 `insert into schema_migrations` 标记该文件，或看 `isIgnorableMigrationError` 的三类白名单 |
| 迁移后 `schema_migrations` 少于 16 行 | 中途失败退出 | 重跑即可：已应用会被跳过，从断点继续 |
| 登录说密码错，我明明设了 PASSWORD | 迁移时 PASSWORD 未设，落成了默认 `123456789`；或库已有 admin 跳过创建 | 用 `123456789` 试；`turso db shell moontvplus "delete from users where username='admin'"` 后重跑 `init:turso` |

### 13.3 皮肤类

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 登录页还是上游白卡片 | skin overlay 没跑 / 被 `SKIN_OVERLAY=0` 关了 | 看 Actions 有没有 `[skin] 覆盖 16 个皮肤文件`；查仓库 Variables 里的 `SKIN_OVERLAY` |
| `Verify skin overlay` 报 `✗ 登录页标题未居中（缺 auth-title--center）` | 覆盖了 page.tsx 但被别的东西改回 | 重跑 overlay；本地 `--check` 复现：`node scripts/skin-overlay.mjs --check` |
| 背景视频不播，只有 poster | 视频源 404，或 `type` 带了错的 `codecs` | `curl -I /icons/skin/login-bg-1440.h264.mp4` 看 200；不要手改 `AuthShell.tsx` 里的 `s.type` |
| 手机上是灰的/糊的 | 640 档被压得太薄或没加载 | 640 档是窄屏专用，检查 `login-bg-640.*` 是否存在且非空 |
| `/icons/skin/theme.css` 404 | overlay 没复制 theme.css，或 `.skin/theme.css` 缺失 | 脚本会 warn `! .skin/theme.css 不存在`；补文件后重跑 |
| 后台粘了 `@import` 但颜色没变 | `/api/theme/css` 没返回你的 customCSS | `curl /api/theme/css` 检查；确认后台「启用自定义 CSS」开着、`cacheVersion` 变了没（浏览器缓存） |
| 主题色变了但个别组件没变 | 该组件用的不是 `--theme-primary` | `theme.css` 是 `!important` 覆盖常用类，边缘组件可能漏；提 PR 补选择器 |

### 13.4 构建 / 本地环境类

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` | Windows git 走 schannel + 代理 | `git -c http.sslBackend=openssl ...` |
| `could not read Username for 'https://github.com'` | 无凭据助手，非交互环境 | 用 `gh auth token` 生成临时 header 推送：<br>`$t=(gh auth token).Trim()`<br>`$b64=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$t"))`<br>`git -c http.extraheader="AUTHORIZATION: basic $b64" -c credential.helper= push origin HEAD:main` |
| `'BUILD_TARGET' is not recognized as an internal or external command` | Windows `cmd` 不支持 `VAR=x cmd` 前缀式环境变量（Linux CI 没这问题） | 只在本地想跑 `edgeone-build.mjs` 时会遇到；用 WSL，或临时改成 `cross-env` |
| `spawn EPERM` | 沙箱/受限环境禁止 spawn 子进程 | 换普通终端跑；或在 CI 里跑 |
| `npm error code EPERM ... npm-cache\_cacache\tmp` | npm cache 目录写权限 | 用 pnpm 而非 npx；或 `npm config set cache <可写目录>` |
| 提交信息里带 BOM 导致奇怪 diff | PowerShell `Out-File` 默认带 BOM | 用 `git commit -m $title -m $body` 直接传参，别写临时文件 |
| `pnpm install --frozen-lockfile` 失败 | lockfile 与 package.json 不同步 | 本地 `pnpm install` 重新生成 lock 并提交 |

---

## 14. 附录

### 14.1 `edgeone-deploy.yml` 里的完整变量清单

这个 workflow 的 `Export build environment variables` step 会把下列 key（`edgeone-deploy.yml:148-168`）
逐个尝试从 Secret 读值并写入 `$GITHUB_ENV`，**空的自动跳过**：

```
NEXT_PUBLIC_STORAGE_TYPE  NEXT_PUBLIC_SITE_NAME  NEXT_PUBLIC_SEARCH_MAX_PAGE
NEXT_PUBLIC_DOUBAN_PROXY_TYPE  NEXT_PUBLIC_DOUBAN_PROXY
NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE  NEXT_PUBLIC_DOUBAN_IMAGE_PROXY
NEXT_PUBLIC_DISABLE_YELLOW_FILTER  NEXT_PUBLIC_FLUID_SEARCH
NEXT_PUBLIC_PROXY_M3U8_TOKEN  NEXT_PUBLIC_DANMAKU_CACHE_EXPIRE_MINUTES
NEXT_PUBLIC_VOICE_CHAT_STRATEGY  NEXT_PUBLIC_ENABLE_OFFLINE_DOWNLOAD
NEXT_PUBLIC_ENABLE_SOURCE_SEARCH  NEXT_PUBLIC_IMAGE_PROXY  NEXT_PUBLIC_IMAGE_PROXY_PREFIX
NEXT_PUBLIC_STORAGE_PREFIX  NEXT_PUBLIC_ENABLE_STREAM_PROXY  NEXT_PUBLIC_STREAM_PROXY_URL
NEXT_PUBLIC_ENABLE_TURNSTILE  NEXT_PUBLIC_TURNSTILE_SITE_KEY
NEXT_PUBLIC_THEME  NEXT_PUBLIC_THEME_COLOR  NEXT_PUBLIC_APP_URL  NEXT_PUBLIC_BASE_PATH
USERNAME  PASSWORD  UPSTASH_URL  UPSTASH_TOKEN  TURSO_URL  TURSO_TOKEN
TMDB_API_KEY  TMDB_IMAGE_DOMAIN  TMDB_PROXY  TMDB_REVERSE_PROXY
DANMAKU_API_BASE  DANMAKU_API_TOKEN  ANNOUNCEMENT  CRON_PASSWORD  SITE_BASE
REDIS_URL  KVROCKS_URL  INIT_CONFIG  CONFIG_SUBSCRIPTION_URL  ENABLE_REGISTER
ENABLE_TVBOX_SUBSCRIBE  TVBOX_SUBSCRIBE_PATH  TVBOX_SUBSCRIBE_TOKEN
WATCH_ROOM_ENABLED  WATCH_ROOM_WS_URL  WATCH_ROOM_SERVER_URL
WATCH_ROOM_EXTERNAL_SERVER_AUTH  WATCH_ROOM_EXTERNAL_SERVER_URL  WATCH_ROOM_SERVER_TYPE
WEBSOCKET_SECRET  WEB_PUSH_EMAIL  WEB_PUSH_PRIVATE_KEY  WEB_PUSH_PUBLIC_KEY  WEB_PUSH_BASEURL
TURNSTILE_SECRET_KEY
```

末尾固定追加三个：

```
BUILD_TARGET=edgeone
EDGEONE_PAGES=1
NODE_ENV=production
```

`BUILD_TARGET=edgeone` / `EDGEONE_PAGES=1` 是 `next.config.js` 的开关：
它会把 `better-sqlite3`、`sharp`、`nodemailer`、`socket.io`、`redis`、`@vercel/postgres`、
`pg`、`libsql`、`@libsql/*` 全部 alias 到一个抛错的 shim（`src/lib/cloudflare-shims/node-unsupported.ts`），
并关掉 `next-pwa` 的 webpack 集成、把 `output` 从 `standalone` 改成 `undefined`。
所以**这些原生模块在 EdgeOne 上不可用是设计如此**，不是配置遗漏。

### 14.2 迁移文件清单（`migrations/`）

```
001_initial_schema.sql                    建 users / play_records / favorites / skip_configs 等主干表
002_add_music_play_records.sql
003_add_new_episodes_to_play_records.sql
004_add_tvbox_subscribe_token.sql
005_music_v2.sql
006_manga.sql
007_books.sql
008_web_push_notifications.sql            ← MIGRATION_BASELINE_CUTOFF 在这里
009_telegram_bot.sql
010_add_is_anime_to_play_records.sql
011_local_settings_sync.sql
012_music_v2_history_sort_order.sql
013_add_is_duanju_to_play_records.sql
014_ensure_legacy_columns.sql
015_add_line_to_play_records.sql
016_add_is_invalid_to_favorites.sql
```

（`migrations/postgres/` 是 Postgres 变体，Turso 路径不读它。）

### 14.3 命令速查

```bash
# —— Turso ——
turso auth login [--headless]
turso auth whoami
turso db create moontvplus [--group <g>] [--size-limit 1gb] [-w]
turso db list [--group <g>]
turso db show moontvplus [--url|--http-url]
turso db inspect moontvplus
turso db tokens create moontvplus [-e never] [-r]
turso db tokens list moontvplus
turso db shell moontvplus "select 1"
turso db shell moontvplus .dump > dump.sql
turso db shell moontvplus < dump.sql
turso db export moontvplus --output-file backup.db [--overwrite] [--with-metadata]
turso db import moontvplus --from-file backup.db
turso db destroy moontvplus

# —— 本仓库脚本 ——
node scripts/init-turso.js           # = pnpm init:turso
node scripts/skin-overlay.mjs        # 皮肤覆盖 + 断言
node scripts/skin-overlay.mjs --check
node scripts/generate-manifest.js    # = pnpm gen:manifest
pnpm build:edgeone                   # = pnpm edgeone:build = node scripts/edgeone-build.mjs
pnpm preview:edgeone
pnpm deploy:edgeone                  # edgeone makers deploy .edgeone

# —— EdgeOne CLI ——
npm install -g edgeone
edgeone -v
edgeone login [--site china|global] | edgeone login -t <token>
edgeone whoami
edgeone workspace ls
edgeone makers link
edgeone makers dev                  # 默认 8088
edgeone makers deploy [dir] -n <name> -t <token> [-e production|preview] [--site global]
edgeone makers env set KEY VALUE -t <token>

# —— gh CLI ——
gh secret set NAME -b "value"
gh secret list
gh variable set SKIN_OVERLAY -b "0"
gh workflow list -a
gh workflow enable edgeone-deploy.yml
gh workflow run edgeone-deploy.yml -f project_name=moontvplus -f area=overseas -f sync_environment=true
gh run list --workflow=edgeone-deploy.yml --limit 5
gh run watch
gh run view --log-failed
```

### 14.4 和 README 章节的对应关系

README 的 EdgeOne 章节（3 个小节，约 2.1KB）只讲了「拿 Token / 配 4 个 Secret / 点 Run」。
本文补的是它没写的部分：

| README 有的 | 本文对应 |
| --- | --- |
| 前置要求 4 条 | 第 2 章（补了版本、额度、网络） |
| 获取 API Token | 第 6 章（补了区域、过期策略、踩坑） |
| 配 4 个 Secret | 第 7 章（补了必需/建议/可选分级、gh CLI 批量、为什么必须 Secret） |
| Turso 子表 2 行 | 第 4–5 章（补了 curl 验证、迁移逻辑、PASSWORD 时序陷阱） |
| 点 Run workflow | 第 8–9 章（补了 workflow enable 坑、12 个 step 全貌、`-a` 参数歧义） |

| README 完全没有的 | 本文对应 |
| --- | --- |
| 皮肤怎么生效 | 第 11 章（三条路径、断言清单、临时关闭、本地预览/回滚） |
| 怎么验证部署对了 | 第 10 章（5 层验证：HTTP / 皮肤 / 主题 / 数据库 / 变量） |
| 日常运维 | 第 12 章（重部署、同步上游、备份、轮换） |
| 报错怎么查 | 第 13 章（4 类 40+ 条症状表） |
| 变量与迁移全表 | 第 14 章 |

---

## 一句话收尾

Turso 负责数据、EdgeOne 负责算力和分发、GitHub Actions 负责把两者缝起来，
皮肤则在「缝」的那一步用文件覆盖的方式穿上去——三处覆盖点（Docker / Actions step / 构建脚本）
共用同一个 `scripts/skin-overlay.mjs`，跑错了会在断言那一关当场炸掉，不会静默发出去。