# 发布到 Octop（Docker / 多人）

> **1.2.2 加了一条分类硬约束**：同一账户 + 同一收支类型下**分类名全局唯一**，一个二级分类只能属于一个
> 一级分类。新增或改名撞名会被拦下，弹窗里直接写明「已存在『X』（已挂在『Y』下）」；
> 一级与二级同名同样拦；分类最多两级。导入 Excel 遇到同名**归一到已存在的分类**，老表格照常导。
> 数据库加 `UNIQUE(user_id, type, name)` 兜底。**老库已有历史重名不会崩**：只打一行提示、跳过建索引，
> 用「分类管理 → 扫描重复」合并后重启，索引自动补上。升级不用动数据。

> **1.2.1 按反馈调界面**（纯展示层，接口只多一个向后兼容字段 `categoryParent`）：首页「本月交易」把
> 账户拆成**发生账户 / 目标账户**、分类拆成**一级 / 二级**；报表删掉与「类型」重合的**「饼图口径」下拉**；
> 菜单顺序改为 **首页·收支明细·报表·手工记账·应收应付·预算·账户管理·分类管理·项目管理·人员·商家**；
> 收支明细**年份默认本年**、开始/结束合并成**一个日期区间控件**、新增**人员/商家/项目**筛选、列名改
> 「发生账户 / 目标账户」并补人员/项目/商家列；分类管理的支出/收入改**左右并排**。
> 界面速查见 **§5.2 第 5 小节**，日期控件可先看原型 `docs/proto/date-range.html`。
> 升级不用动数据：只换了页面模板与交易视图的一个字段。

> **1.2.0 是一次工作台功能批次**：首页重做（累计天数/明细数、本月收支、收支双柱 + 结余折线的
> 混合趋势图、本月支出饼图）、账户加卡号/备注且改余额会自动补「余额调整」流水、收支明细加年份
> 下拉与一二级分类联动并撑满视口、手工记账布局重排且日期到秒、下拉按使用频次排序、商家分类改
> 一级下拉与取色器、应收应付状态改中文、**新增「报表」页六张饼图**（对应新工具 `report_overview`，
> 工具总数 42 → 43）。**数据格式没有破坏性变更**，换镜像重建容器即可，`/data` 里的账本、账号、
> token 都不用动；旧的 `finance.db` 会被就地增量迁移（只 `ALTER TABLE ADD COLUMN`，不重建业务表）。
> 页面速查见 **§5.2 第 5 小节**。

> **1.1.4 修了一个致命前端 bug**：1.1.2 / 1.1.3 的工作台在点任何**写入类**按钮时会弹
> `Cannot set properties of undefined (setting 'Content-Type')` —— 起因是 1.1.2 移除 `x-user-id` 时
> 把请求头的初始化一起删了，却留下 `opts.headers['Content-Type'] = ...`。**装的是 1.1.2 / 1.1.3 的请换成 1.1.4**：
> 换镜像重建容器即可，`/data` 里的账本、账号、token 都不用动。
> 回归测试 `node scripts/test-webapp-frontend.mjs`（20 项，在 vm 里执行模板脚本，不需要浏览器）。

面向 **Docker 部署的 Octop + 家庭/团队多人使用**。单机自用可以跳过容器，直接看第 7 节。

---

## 1. 为什么是「两件套」

Octop 有四种扩展形态，逐一核对过源码里的 `docs/` 规范：

| 形态 | 打包方式 | 能带什么 | 能否声明 MCP |
|---|---|---|---|
| 技能包 | ZIP，根上 `SKILL.md` | 提示词 + 任意资源 | **不能** |
| 专家包 | ZIP，根上 `manifest.json` | `SOUL.md` + `skills/` + 子 Agent | **不能** |
| 插件包 | ZIP，根上 `plugin.yaml` + `main.py` | Python 工具 / 技能 / hook / 通道 | **不能** |
| 自定义 MCP | 控制台手动添加 | stdio 或 streamable HTTP | 本身就是 MCP |

`plugin.yaml` 没有 `mcp` 字段，`manifest.json` 没有，技能包更没有。**所以没有任何一种包能把 MCP 顺带注册进去。**

结论：本项目拆成两件，各自走对应通道。

```
            ┌─────────────────────── Octop 进程 ───────────────────────┐
            │                                                          │
  用户对话 ──┤ Agent「记账助理」                                          │
            │   ├─ 技能层：skills/mylife-finance/SKILL.md（怎么记账）    │
            │   └─ 工具层：MCP 连接器 ──┐                               │
            └───────────────────────────┼──────────────────────────────┘
                                        │ Streamable HTTP
                                        │ POST /mcp/<userId>
                            ┌───────────▼────────────┐
                            │ mylife-finance-mcp 容器 │
                            │  server-http.js:3458    │
                            └───────────┬────────────┘
                                        │ 按 user_id 隔离
                                  /data/finance.db
```

---

## 2. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| Octop | 已 `octop init` + `octop run` 起来 | 数据目录 `~/.octop`（Docker 下是 `/data/.octop`） |
| Node | **视部署方式而定，见 §2.1** | 跑代码的那个进程需要 ≥ 22.13；Docker 拓扑下宿主机不需要 Node |
| 依赖 | 无 | 零 npm 依赖，不需要 `npm install` |
| 磁盘 | 约 10 MB + 数据 | 库文件随交易增长，千级记录约 1–2 MB |

### 2.1 Node 版本要求（最容易搞混的一点）

一句话：**需要 Node ≥ 22.13，但「Docker 部署时宿主机装什么版本」与它无关。**

「要不要 Node 22」取决于**代码在哪个进程里执行**，而不是 Octop 装在哪个版本上：

| 使用方式 | 实际执行代码的 Node | 要求 |
|---|---|---|
| **MCP 容器**（`server-http.js`，推荐） | 镜像自带的 `node:22-alpine` | ✅ 宿主机 / Octop 的 Node 版本**完全无关**，宿主机甚至可以不装 Node |
| **stdio 模式**（Octop 用 `node server.js` 拉起进程，见 §7） | Octop 所在机器的 Node | ❌ 必须 ≥ 22.13 |
| **本地工作台**（Windows 上跑 `workbench.js` 导 Excel） | 你本机的 Node | ❌ 必须 ≥ 22.13 |

**为什么是 22.13，而不是 20：**

`src/db.js:10` 与 `src/tools.js:941` 直接 `require('node:sqlite')`，没有 try/catch 兜底。该模块的版本历史（官方文档 `docs/latest-v22.x/api/sqlite.html`）：

| Node 版本 | `node:sqlite` 状态 |
|---|---|
| **v22.5.0** | 引入，需 `--experimental-sqlite` 标志 |
| **v22.13.0**（同 v23.4.0） | 免标志即可用（仍标注 experimental） |
| **v20.x** | **不存在该模块**，`require` 直接抛 `ERR_UNKNOWN_BUILTIN_MODULE` |

Node 不会向已进入维护期的旧大版本回补新模块，所以 v20 的最新版（20.20.2）同样没有。项目里也**没有** `better-sqlite3` / `sql.js` 之类的降级分支，`package.json` 的 `engines` 与容器入口都写死 `>=22.13`。

除 `node:sqlite` 外，其余代码在 Node 20 上都能跑（`zlib`、`http`、`crypto.randomUUID`、`fetch` 都够老）——**唯一的坎就是这一个模块**，所以改动面很窄。

### 2.2 机器上只有 Node 20 怎么办

| 方案 | 代价 | 说明 |
|---|---|---|
| **A. 用 Docker 跑 MCP**（推荐） | 零 | 镜像自带 Node 22，宿主机不需要 Node，也不必升级任何东西 |
| **B. 并行装一个 Node 22** | 零代码改动 | 官方 zip 便携版 / `nvm-windows` / `winget install OpenJS.NodeJS.LTS`，**不影响现有 20**，按需切换 |
| **C. 换 `better-sqlite3`** | 打破零依赖 | 需 `npm install` + alpine 内安装编译工具链，改 `db.js` / `tools.js` 两处。除非被强制要求，不选 |

### 2.3 版本相关的两个正常现象

- **`ExperimentalWarning: SQLite is an experimental feature`**：在 22.x 上会出现（22.13 起虽免标志，但仍标注 experimental）。这是预期行为，所有启动命令已加 `--no-warnings` 屏蔽，不影响功能。顺带一提，该模块在 **v24.15.0 起升为 Release Candidate（Stability 1.2）**，新版本上可能不再打印此警告。
- **容器入口硬卡 `>= 22.13`**：22.5–22.12 其实加 `--experimental-sqlite` 也能用，但入口脚本**不会**自动补标志，会直接报错退出（`ERROR: 需要 Node >= 22.13`）。遇到这类版本请升到 22.13+ 或 24.x，不要试图绕过。

---

## 3. 构建并启动 MCP 容器

### 3.1 先确认 Docker 引擎真的可用（Windows 上最容易卡在这）

Windows 版 Docker 引擎跑在 WSL2 里。**CLI 装好 ≠ 引擎可用**，最典型的坏状态是：`docker --version` 有输出，但每个命令都返回 `500 Internal Server Error` 或 `Docker Desktop is unable to start`。这跟镜像没关系，是引擎/VM 没起来。

```bash
docker version --format '{{.Server.Version}}'   # 能打印版本号才算真的可用
docker desktop status                            # Windows 上直接看引擎状态
```

| 现象 | 处理 |
|---|---|
| 所有 API 返回 500 / `unable to start` | 托盘图标右键 → Restart；仍不行则 `wsl --shutdown` 后重开（管理员 PowerShell） |
| `docker desktop status` 显示 stopped | 启动 Docker Desktop，等托盘图标变绿（首次启动 1–3 分钟） |
| 提示虚拟化未启用 | BIOS 里开 VT-x/SVM，或 `wsl --update` 更新内核 |

> 首次 `docker build` 会拉 `node:22-alpine`（约 50 MB），需要能访问 Docker Hub。国内网络慢可先配镜像加速。

### 3.2 一条命令：构建 + 全量验收（推荐）

```bash
cd mylife-finance-skill
node scripts/docker-build-verify.mjs
```

它会依次跑完 7 组检查，**全过才返回 0**，结束时自动删掉测试容器与数据卷，不碰你的正式容器：

| 组 | 验什么 |
|---|---|
| 1 守护进程 | Docker 引擎可连接（否则立刻停下并提示怎么修） |
| 2 构建 | `docker build` 成功 + 镜像存在 |
| 3 镜像内运行时 | Node ≥ 22、`node:sqlite` 能加载 |
| 4 容器启动 | `/health` 在 90s 内就绪，`toolCount=42`、`transport=streamable-http` |
| 5 MCP 协议 | `initialize` 下发 `Mcp-Session-Id`、`tools/list` 42 个、通知返回 202 |
| 6 写入与隔离 | 记账成功、新租户播种 137 分类、bob 看不到 alice、伪造 `userId` 无效、`user_create` 被拒、非法 userId 400 |
| 7 数据持久化 | `docker restart` 后数据仍在（证明 `/data` 卷生效） |

常用开关：

```bash
node scripts/docker-build-verify.mjs --no-build      # 只验已有镜像
node scripts/docker-build-verify.mjs --keep          # 保留容器，方便手动 curl
node scripts/docker-build-verify.mjs --port 3499     # 换宿主端口，避免和正式容器撞
node scripts/docker-build-verify.mjs --tag a:b       # 换镜像标签
```

失败时脚本会自动打印容器日志尾部，并列出所有失败项。

### 3.3 手动构建与启动

```bash
cd mylife-finance-skill

# 1) 查 Octop 的 network 名（compose 默认是 <目录名>_default）
docker network ls | grep -i octop

# 2) 起服务（把网络名换成上一步查到的）
OCTOP_NETWORK=octop_default \
  docker compose -f docker-compose.mylife-finance.yml up -d --build

# 3) 验证
docker ps --filter name=mylife-finance-mcp
curl -s http://127.0.0.1:3458/health
```

镜像标签与 `package.json` 版本一致（当前 `mylife-finance-mcp:1.2.2`），可用 `MYLF_IMAGE` 环境变量覆盖。

`/health` 正常返回：

```json
{"ok":true,"transport":"streamable-http","toolCount":42,"dataDir":"/data","categories":137}
```

> **更省事的做法**：把 `docker-compose.mylife-finance.yml` 里 `services.mylife-finance-mcp` 整段粘进 Octop 自己的 `docker/docker-compose.yml`，自动同网络，不用指定 `OCTOP_NETWORK`。

### 3.4 只有镜像、没有源码时怎么起（QNAP Container Station / 独立部署）

`docker-compose.mylife-finance.yml` 带 `build:` 段和 `external` 网络，**宿主机上没有源码目录或没有 Octop 时不能直接用**。用仓库里的第二个文件 `docker-compose.standalone.yml`：只用 `image:`、独立 bridge 网络、发布端口，任何宿主都能起。

三种形态对照：

| 做法 | 前提 | build | 网络 | 适用 |
|---|---|---|---|---|
| `docker-compose.mylife-finance.yml` | 有源码 + Octop 同机 | 要 | `external` → `octop_default` | 开发机一条龙 |
| **`docker-compose.standalone.yml`** | **只要有镜像（tar 导入即可）** | **不用** | **独立 bridge + 发布 3458** | QNAP / 群晖 / 任意 Linux |
| 粘进 Octop 自己的 compose | Octop 同机 | 可选 | 自动同网络 | 想省事 |

**A. QNAP Container Station（图形界面）**

1. **先确认镜像名**：Container Station → 映像，看 `mylife-finance-mcp:1.2.2` 是否在列。名字来自 tar 里 `manifest.json` 的 `RepoTags`；若显示成 `<none>`，先补标签（SSH 执行 `docker tag <镜像ID> mylife-finance-mcp:1.2.2`）。
2. 左侧 **应用程序** → **创建** → 选「Docker Compose / 粘贴 YAML」。
3. 把 `docker-compose.standalone.yml` 的内容整段粘进去，只需按需改两处：
   - `image:` —— 与第 1 步看到的实际名字一致
   - `MYLF_HTTP_TOKEN:` —— **只要端口对局域网开放就必须设**，顺便把 Octop 的 Headers 填上同一个值
4. 部署。容器列表出现 `mylife-finance-mcp`，状态「运行中」。
5. 验证：浏览器或 `curl -s http://<NAS_IP>:3458/health`，应返回 `{"ok":true,"transport":"streamable-http","toolCount":42,...}`。

**B. SSH / 任意 Linux 宿主**

```bash
docker compose -f docker-compose.standalone.yml up -d
docker compose -f docker-compose.standalone.yml logs -f --tail 50
docker compose -f docker-compose.standalone.yml down          # 停；数据在命名卷里不会丢
```

**C. 想用容器名而不是 IP（Octop 与 MCP 同机同网络）**

在 `docker-compose.standalone.yml` 基础上把网络段换成下面这样，并**删掉 `ports:`**（容器间通信不走发布端口）：

```yaml
    networks:
      octop_net:
        aliases:
          - mylife-finance-mcp.internal

# 文件末尾
networks:
  octop_net:
    external: true
    name: octop_default
```

然后连接器 URL 用 `http://mylife-finance-mcp.internal:3458/mcp/<用户名>`（纯容器名会被 Octop 判成公网地址，见 §5.1）。

**D. 常见报错**

| 现象 | 原因 | 处理 |
|---|---|---|
| `pull access denied` / `No such image` | `image:` 写错，或导入后没拿到 tag | `docker images` 查实际名称后改 `image:` |
| `network octop_default declared as external, but could not be found` | 宿主上没跑 Octop | 换 standalone / 删掉 `networks` 段 |
| compose 报 `services` 键非法 | Container Station 用的是老版 compose，不认不带 `version` 的文件 | `version: "3.8"` 这一行别删 |
| 一直 `unhealthy` | 端口/环境变量被改得不一致 | `docker logs mylife-finance-mcp` 看实际监听端口 |
| 删容器后账目没了 | 没挂 `/data` 或挂到了别的路径 | 检查 `volumes` 与 `MYLF_DATA_DIR` 是否都是 `/data` |

### 3.5 ★ Octop 自己也是用 compose 创建时，怎么保证跟 MCP 互通

典型形态是两份 YAML 各起各的：

```yaml
# Octop 那份（常见写法，注意没有任何 networks 段）
services:
  octop:
    image: ghcr.nju.edu.cn/tencentcloud/octop:latest
    container_name: octop
    ports: ["18088:18088"]
    volumes: ["/share/Container/octop:/data/.octop"]
    environment: { HOME: /data, OCTOP_PORT: 18088, ... }
```

**这份 YAML 本身不会跟 MCP 通。** 原因不是写错了，而是「省掉 `networks:`」这个默认行为：compose 会为这个项目创建 `<项目名>_default` 网络，**项目名是部署时输入的应用名经规整后的结果**（Container Station 里就是你填的应用名称），下划线/大小写/前缀都不可控；而 MCP 那份 standalone 又自成另一个 `<项目名>_default`。两个独立 bridge 之间被 `DOCKER-ISOLATION-STAGE` 链阻断，「容器 → 宿主 LAN IP:发布端口」这条路在 QNAP 上又依赖 userland-proxy（常关）。表现就是：**你在 PC 上 curl 得通，Octop 容器里却连不上**，且服务端计数不增长（请求根本没到）。这就是 §10.1 那个 TaskGroup 报错的成因。

结论：**不要靠默认网络名去对齐，要显式声明共享网络。** 三档做法，可靠性从高到低：

#### 方案 A（推荐）：两个 service 写进同一份 compose

同一项目 = 同一网络 = 容器名与别名天然可解析，不依赖任何外部网络、不用猜名字。仓库里已备好 `docker-compose.qnap-octop-mcp.yml`（Octop + MCP 完整可粘贴版），核心就是三处：

```yaml
services:
  octop:
    ...
    networks:
      - mylife_net          # ① Octop 加入共享网络

  mylife-finance-mcp:
    ...
    networks:
      mylife_net:
        aliases:
          - mylife-finance-mcp.internal   # ② 带点别名，专为 Octop 的 URL 校验器（§5.1）

networks:
  mylife_net:
    driver: bridge          # ③ 由本文件创建，两边必然同网络
```

连接器 URL 用 `http://mylife-finance-mcp.internal:3458/mcp/<用户名>`。

**合并前必做两步**（否则会「看起来数据丢了」）：

1. **保留原 `volumes` 路径，一个字都别改。** 如果原来 MCP 是 bind 挂载 `/share/Container/mylife-finance-mcp:/data`，合并后仍写这个路径；写成命名卷（`mylife-finance-data:/data`）会让容器挂到一个空目录，界面变空账本 —— 数据还在旧目录里，但你会以为被清空了。Octop 的 `/share/Container/octop:/data/.octop` 同理（连接器/技能配置全在里头）。
2. **先删掉两个旧应用程序**再部署合并版。`container_name: octop` / `mylife-finance-mcp` 是固定的，旧容器还占着名字会报 `container name "/octop" is already in use`。Container Station 里删「应用程序」不会删共享文件夹。

#### 方案 B：必须分两份文件 → 用固定网络名

`name:` 属性在老版 compose 里不稳，最保险是**先手工建网络**，两边都用 `external: true` + `name:`：

```bash
docker network create mylife-net      # 只需一次；已存在会报错，忽略即可
```

Octop 那份追加：

```yaml
    networks:
      - mylife_net
# 文件末尾
networks:
  mylife_net:
    external: true
    name: mylife-net
```

MCP 那份同理，只是 `networks` 换成带别名的映射形式：

```yaml
    networks:
      mylife_net:
        aliases:
          - mylife-finance-mcp.internal
# 文件末尾
networks:
  mylife_net:
    external: true
    name: mylife-net
```

⚠️ 顺序：**先 `docker network create`，再 `up`**。否则 compose 直接报 `network mylife-net declared as external, but could not be found`。

#### 方案 C：两边都已经在跑，不想重建

```bash
# 1) 找 Octop 所在网络（挑 IP 是 172.x 的那个）
docker inspect octop -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}'

# 2) 把 MCP 接进同一网络并加别名
docker network connect --alias mylife-finance-mcp.internal <上一步的网络名> mylife-finance-mcp

# 3) 从 Octop 容器内部验证（这一步通了才算真通）
docker exec octop sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'
```

`docker network connect` 是**临时**的：容器重建（`compose up -d`、Container Station 改配置）后失效。验证通过后回到方案 A/B 把配置固化。

#### 判据：怎么算「真的互联了」

| 检查 | 命令（在 NAS 的 SSH 里） | 期望 |
|---|---|---|
| 同网络 | `docker inspect octop mylife-finance-mcp -f '{{.Name}} {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'` | 两者网络列表**有交集** |
| DNS 解析 | `docker exec octop nslookup mylife-finance-mcp.internal`（或 `wget` 那条） | 解析到 172.x |
| 容器间 HTTP | `docker exec octop sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'` | `{"ok":true,...,"toolCount":42}` |
| 请求真的到了 | 连一次新用户名后看 `curl -s http://127.0.0.1:3458/health` 里的 `categories` | 每成功新建一个租户 `+137`；**不增长 = 请求没到** |

只有第 3 行这条通了，Octop 连接器才有可能连上。**它在宿主上 curl 得通不算数。**

#### 这份 Octop YAML 里另外几处要注意

| 项 | 说明 |
|---|---|
| `OCTOP_DEFAULT_PASSWORD: AAAA` | 示例值。18088 对局域网开放时这是唯一入口凭据，换成强密码；首次登录后尽快改 |
| `volumes: /share/Container/octop:/data/.octop` | Octop 全部状态（账号/Agent/技能/连接器配置）都在这。**别删这个目录**，否则连接器要重配 |
| `OCTOP_PORT: 18088` | 容器内监听端口，与 `ports` 右侧一致。改端口时两处必须同步 |
| `depends_on` | 只保证「先起 MCP 再起 Octop」，**不是**等健康；MCP 冷启动约 2~3 秒，Octop 首次探测若失败，等 10 秒再点「探测」 |
| 要不要留 `ports: 3458` | 只给 Octop 用可以删（容器间走网络不经发布端口）；PC 上第二个 WorkBuddy 要直连就保留，**并必须设 `MYLF_HTTP_TOKEN`** |
| 镜像名 | 导入 tar 后可能变成 `<none>`：`docker tag <镜像ID> mylife-finance-mcp:1.2.2` |
| `container_name` 冲突 | 旧的 Octop 容器还在时部署新 YAML 会报 `container name "/octop" is already in use`。先在 Container Station 里停止并**删除旧应用程序**（不是删 `/share/Container/octop` 目录），数据不会丢 |


---

## 4. 安装技能

```bash
# 打包（本机改过 SKILL.md 后重新打）
node scripts/pack-octop-skill.mjs

# 装到 Octop 的 Agent 工作区
OCTOP_HOME=/data/.octop ./install.sh --agent main --user alice
```

Docker 部署时 `~/.octop` 在容器里，需先进容器或挂载出来：

```bash
docker exec -it <octop容器名> sh
# 容器内：把 dist/*.zip 拷进去后
unzip -o mylife-finance-skill-1.2.2.zip -d /data/.octop/agents/main/skills/
```

也可直接在控制台「技能包」页上传 `dist/mylife-finance-skill-1.2.2.zip`。

安装后落盘：

```
/data/.octop/agents/main/skills/mylife-finance/
├── SKILL.md
└── references/tools.md
```

---

## 5. 注册 MCP 连接器（唯一必须手点的一步）

这一步脚本代劳不了：自定义 MCP 存在控制面数据库 `octop.db` 里，官方只暴露了 UI，没有稳定写入接口；直接改库会在升级 schema 迁移时被踩掉。

控制台 → **连接器** → 添加自定义 MCP：

| 字段 | 值 |
|---|---|
| 类型 | Streamable HTTP |
| URL | `http://mylife-finance-mcp.internal:3458/mcp/alice`（**纯容器名 `mylife-finance-mcp` 会被判成公网地址而强制 HTTPS，见 §5.1**） |
| 请求头 | 仅当设了 `MYLF_HTTP_TOKEN` 才需要 `Authorization: Bearer <令牌>` |

保存后把它挂到 Agent「main」上，再确认该 Agent 的技能里 `mylife-finance` 是启用状态：

```bash
octop skills list --agent main
```

**走 `docker exec` 进容器调 `octop skills` 时注意**：这些子命令需要服务在运行（Attach 传输层）。

### 5.1 ★ 填容器名会报「必须使用 HTTPS」

Octop 的连接器校验器对 `http://` 只放行三类主机：

1. **私网 IP 字面量**（`10.*`、`172.16–31.*`、`192.168.*`、`127.*`）
2. `localhost`
3. 以 **`.local`** / **`.internal`** / **`*.docker.internal`** 结尾的主机名

`mylife-finance-mcp` 是 Docker 网络里的容器名，不属于以上任何一类 ⇒ 被判成「公网地址」⇒ 报：

> `「mylife-finance-mcp」会被当作公网地址，必须使用 HTTPS。HTTP 仅适用于本机、私网 IP，以及 localhost、.local、.internal、*.docker.internal 这类主机名。`

> 注意：**别名能解析的前提是两个容器在同一个 docker 网络里**。跨网络时名字通不过是「先决条件没满足」，不是校验器的问题 —— 先按 §3.5 把网络打通，再回来填 URL。

两条路，随便挑一条：

**A. 给容器加 `.internal` 别名（推荐，不增加端口暴露面）**

`docker-compose.mylife-finance.yml` 里把 `networks` 从列表改成映射：

```yaml
    networks:
      octop_net:
        aliases:
          - mylife-finance-mcp.internal
```

`docker compose -f docker-compose.mylife-finance.yml up -d` 重建容器后，URL 写：

```
http://mylife-finance-mcp.internal:3458/mcp/alice
```

保存前先验别名在容器网络里解析得出来（Octop 容器能通才算通）：

```bash
docker exec <octop容器名> sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'
```

**B. 用 NAS 的局域网 IP**

```yaml
    ports:
      - "3458:3458"     # 默认 "127.0.0.1:3458:3458" 只绑回环，容器/机器都进不来
```

URL 写 `http://192.168.x.x:3458/mcp/alice`。⚠️ 端口一旦对局域网开放就**必须设 `MYLF_HTTP_TOKEN`**，并在 Octop 连接器里填 Headers `Authorization: Bearer <令牌>`；否则同网段谁都能读写任意用户的账本（URL 里的用户名只是分区名，不是凭据）。

> 两者都要求 MCP 容器与 Octop 在同一 Docker 网络里（compose 里 `networks: octop_net`，`OCTOP_NETWORK` 默认 `octop_default`）。若两者分处不同宿主机，只能走 B 或上 HTTPS 反代。

**顺带一个坑**：URL 里的用户名**区分大小写**，`Admin` 和 `admin` 是**两个独立租户**。用大写首次访问会看到空账本（只是被新播种了 137 个默认分类），容易误判「数据丢了」。统一用小写。

### 5.2 ★ 工作台与看板（浏览器直接打开）

**1.1.1 起，MCP 与工作台共用同一个端口**，容器里不需要再起第二个进程，也不需要额外发布端口。

| 地址 | 内容 |
|---|---|
| `http://<主机>:3458/login` | 登录页（用户名 + 密码） |
| `http://<主机>:3458/` | 交互工作台：首页、报表、账户管理、收支明细、手工记账、分类、项目、人员、商家、应收应付、预算、Excel 导入 |
| `http://<主机>:3458/admin` | 用户管理（仅管理员）：建账号、发 token、重置密码、停用 |
| `http://<主机>:3458/account` | 改自己的密码 |
| `http://<主机>:3458/dashboard.html` | **当前登录用户自己的**看板快照（每位用户一个文件，互不覆盖） |
| `http://<主机>:3458/api/*` | 工作台 REST（给脚本/自建页面用） |
| `http://<主机>:3458/info` | 服务自述 JSON（需要凭据，会回显你的 userId 与角色） |

**2. 怎么进工作台**

1.1.2 起有独立账号体系，**默认就要登录**：

```
http://192.168.130.8:3458/login
```

- 首次启动没有账号时，服务会自动建管理员，密码写在 `/data/ADMIN-PASSWORD.txt`（`docker logs` 里也会提示路径）
- 登录后 Cookie 为 `mylf_sid`（`HttpOnly; SameSite=Lax; Max-Age=30天`），页面内所有 `/api/*` 自动带凭据
- 未登录访问页面会 302 到 `/login`，访问 `/api/*` 返回 401 JSON

还有一个便利写法：`?token=<你本人的 MCP token>`，校验后换发会话 Cookie 并把 token 从地址栏去掉，适合做成书签。

```
http://192.168.130.8:3458/?token=<你的 token>
```

**3. 为什么 Octop 里 `dashboard_build` 生成的页面读不到**

工具返回的 `path` 是**容器内路径**（`/data/dashboards/<用户名>.html`），Octop 是另一个容器，读不到那个文件。所以额外返回 `url` / `relativeUrl`，但要拿到**可点击的完整 URL**，必须给 MCP 容器设 `MYLF_PUBLIC_BASE_URL`：

```yaml
    environment:
      MYLF_PUBLIC_BASE_URL: "http://192.168.130.8:3458"   # 你实际访问 MCP 用的地址，带端口，不带结尾斜杠
```

不设的话返回 `url: null` + 一段 `hint` 说明原因 —— 这是有意的，服务端无从得知浏览器眼里的地址（Octop 请求时用的 Host 是 `.internal` 域名，那个只有容器自己能解析）。

**4. 安全边界**

1.1.2 起工作台有真正的登录与按用户隔离，细节见 **§6**（凭据模型、权限矩阵、升级迁移）。一句话概括：

- **身份只来自服务端凭据**，`x-user-id` / `?userId=` 这类客户端自称一律忽略
- **拿到某人的 token 就是那个人**，token 不要外传；工作台里可随时「轮换 token」
- **不做团队内部分权**（没有只读成员/共享账本），要分权就一人一个实例（§13）
- 会话 Cookie 走 http，同网段可被嗅探；家庭/小团队内网可接受，要更强就先上 HTTPS

**5. 工作台各页面速查（1.2.2 的界面）**

菜单顺序：**首页 · 收支明细 · 报表 · 手工记账 · 应收应付 · 预算 · 账户管理 · 分类管理 · 项目管理 · 人员 · 商家**。

| 页面 | 说明 |
|---|---|
| **首页** | 八张卡片：本年收入/支出/结余 + **累计记账天数**（有交易的不同日期数）+ **累计记账明细数** + 本月收入/支出/结余。趋势图是**混合图**：每月收入、支出两根**柱子** + 结余一条**折线**。两张饼图：本年支出与本月支出的一级分类占比。「本月交易」表把账户拆成**发生账户 / 目标账户**、分类拆成**一级 / 二级** |
| **收支明细** | **年份下拉默认本年**（2024–2035）；**日期是一个区间控件**——点开是双月日历 + 左侧快捷区间（本月/上月/近3月/近6月/本年/去年/前7天/本周/本季度），选完按「确定」才生效，点「清空」两者一起清；年份与区间是同一件事的两种表达，选非整年区间会自动把年份置空。另有类型、账户、**人员**、**商家**、**项目**、一级/二级分类（联动）筛选。列表**撑满到浏览器底部**、表头吸顶、底部显示总笔数与合计；列为「日期 / 类型 / **发生账户 / 目标账户** / **一级分类 / 二级分类** / **人员 / 项目 / 商家** / 说明 / 标签 / 金额」 |
| **报表** | 一套筛选条件打到底（收支类型、日期区间、账户、成员、商家、项目、说明关键词），出**六张饼图**：收入类型、支出类型、账户收支、成员收支、商家收支、项目收支。**后四张的取值口径由「类型」决定**（全部=收支合计、只看收入=收入、只看支出=支出），不再单设「饼图口径」下拉。数据来自 `GET /api/reports/overview`（MCP 侧同名工具 `report_overview`） |
| **手工记账** | 布局按「类型·日期(到秒)」→「账户·金额」→「一级·二级分类」→「成员·商家·项目·说明·标签」排列。所有下拉的选项**按你用得多少排序**（`GET /api/selectors`），常用的在前 |
| **应收应付** | 状态显示为中文：待结清 / 部分结清 / 已结清 / 已逾期 |
| **预算** | 按年/月筛选，预算额/已用/剩余/使用率；年/月两级，同分类的月预算嵌在年预算下；新增预算只列一级分类 |
| **账户管理** | 新增账户可填**卡号**与**备注**；点行进入编辑，可改名称/类型/币种/卡号/备注/余额。**改余额不会静默改数字**：服务端按差额补一笔「余额调整」流水（上调记`其他收入`、下调记`其他费用`），列表显示的余额始终是「期初 + 流水」的实算值 |
| **分类管理** | **支出分类与收入分类左右并排**，两级树形展示；顶部有查重/合并。**分类名在同一收支类型下全局唯一**：新增/改名撞名会被拦下（弹窗里写明撞到了谁、挂在哪个一级分类下），一级与二级同名同样拦，二级下面不能再挂子级；历史重名用「扫描重复」查出后合并（`reason: same-name`） |
| **项目管理 / 人员 / 商家** | 各自的增删改；商家分类是一级分类下拉，颜色用**取色器** |

> 明细列表的「撑满底部」是按视口高度算的（`calc(100vh - 148px)`，表头吸顶）；窄到 860px 以下会退化成 `max-height:60vh`，避免把按钮挤出屏幕。

---

## 6. 多用户隔离（这是重点）

**1.1.2 起，隔离有两条腿：URL 里的用户名（分区） + 凭据归属的授权（谁能否访问）。**

只靠 URL 是不够的。1.1.1 及以前 token 是全局唯一一个，任何人拿到它把 URL 里的名字一改就能读写别人的账本 —— 那是「按路径分区」，不是授权。1.1.2 改成**一个用户一把 token**，并在服务端校验：

```
拿 alice 的 token 打 /mcp/bob   →  403 forbidden
拿 alice 的 token 打 /mcp/alice →  200
```

### 6.1 三类凭据，各自绑定一个人

| 凭据 | 用在哪 | 谁能拿到 | 绑定 |
|---|---|---|---|
| 会话 Cookie `mylf_sid` | 浏览器打开工作台 | 本人（登录后） | HMAC 签名，payload 含 userId，改密即失效 |
| 每用户 MCP token | Octop 连接器 / curl | 管理员生成后转交本人 | sha256 存库，与唯一 userId 绑定 |
| 旧版 `MYLF_HTTP_TOKEN` | 从 1.1.1 平滑升级 | 部署者 | 只代表 `MYLF_HTTP_TOKEN_USER`（默认 `admin`）一人 |

**任何客户端自称的身份都不算数**：`x-user-id` 头、`?userId=` 参数在 1.1.2 起被服务端**完全忽略**（1.1.1 以前正是读它们，才导致越权）。

### 6.2 账号从哪来：登录页 + 用户管理

首次启动（`users.json` 为空）自动创建管理员：

- 用户名 `MYLF_ADMIN_USER`（默认 `admin`）
- 密码 `MYLF_ADMIN_PASSWORD`；**不设则随机生成**，写入 `/data/ADMIN-PASSWORD.txt`，容器日志也会提示路径
- 标记「待改密」：登录后被**强制**跳到 `/account`，改完密码才能用工作台。这一步是硬的，不是提示 ——
  否则 `ADMIN-PASSWORD.txt` 里那份初始密码就等于长期凭据（它在容器卷里，File Station 能直接看到）

然后：

```
浏览器 → http://<NAS_IP>:3458/login    用管理员账号登录
       → 右上角「用户管理」（/admin）
       → 新增用户：用户名（= 租户 ID，与 Octop 连接器 URL 同名）、备注、初始密码、角色
       → 创建成功时**只显示一次**该用户的 MCP token，复制走填进 Octop 连接器
```

工作台各页面：

| 路径 | 谁能进 | 作用 |
|---|---|---|
| `/login` | 所有人 | 用户名 + 密码登录 |
| `/` | 已登录 | 记账工作台（只能看自己的数据） |
| `/account` | 已登录 | 改自己的密码；「让其他设备下线」（不改密码也能踢掉别处的会话） |
| `/admin` | 仅管理员 | 用户列表（含最近登录 / token 最近使用）：新增 / 重置密码 / 轮换 token / 停用 / 删除 / 查看操作记录 |
| `/api/admin/audit` | 仅管理员 | 最近 50 条审计事件（登录、改密、建号、删号、越权拦截） |
| `/logout` | 已登录 | 退出并清 Cookie |

### 6.3 权限矩阵

| 操作 | 成员 | 管理员 |
|---|---|---|
| 看/写自己的账本 | ✅ | ✅ |
| 看别人的账本（改 URL 里的名字） | ❌ 403 | ❌ 403 |
| 打开 `/admin` 与 `/api/admin/*` | ❌ 403 | ✅ |
| 停用/删除用户、重置密码、轮换 token | ❌ | ✅ |
| 停用或删除**最后一个管理员** | — | ❌ 400（防止把自己锁在门外） |

> 注意：**管理员不等于能看别人账本**。管理员管账号，不代看数据。这是刻意做的取舍 —— 「能重置你的密码」已经等于能进来，没必要再开一个隐式越权口子。

### 6.4 从 1.1.1 升级（现网必看）

1.1.1 的部署只有 `MYLF_HTTP_TOKEN` 一个串，且 URL 里可能写的是大写 `Admin`。升级后会出现 403，因为 token 现在只属于一个用户。两种处理：

```yaml
# 方案 1（推荐）：一次迁移到位
#   1) 先保留旧 token 保证不断服，并显式声明它属于谁
MYLF_HTTP_TOKEN: "旧的全局令牌"
MYLF_HTTP_TOKEN_USER: "Admin"        # 必须与你 Octop URL 里那段完全一致（大小写敏感）
#   2) 登录 /login（用 ADMIN-PASSWORD.txt 里的密码）→ 用户管理 → 给每人建账号
#   3) 每个连接器换成本人的 token，删掉 MYLF_HTTP_TOKEN 两个变量，重启
```

```yaml
# 方案 2：不改 URL
#   在用户管理里直接创建用户名恰为 "Admin" 的账号，用它的 token
```

⚠️ 用户名**大小写敏感**：`Admin` 和 `admin` 是两个独立租户、两套数据。升级时如果建错了，会看到一本空账本（只有 137 个默认分类），很容易误判「数据丢了」。

### 6.5 命令行：不开浏览器也能管用户

CLI 在 `src/cli.js`，随镜像分发：

```bash
docker exec mylife-finance-mcp node src/cli.js list
docker exec mylife-finance-mcp node src/cli.js add alice --label 老婆
docker exec mylife-finance-mcp node src/cli.js passwd alice
docker exec mylife-finance-mcp node src/cli.js token alice     # 轮换，打印新值
docker exec mylife-finance-mcp node src/cli.js disable alice
docker exec mylife-finance-mcp node src/cli.js del alice       # 只删账号，账本数据保留
docker exec mylife-finance-mcp node src/cli.js del alice --purge   # 连账本一起删（不可恢复）
```

`add` / `passwd` 不给 `--password` 时会随机生成一个可读密码并打印，同时标记「待改密」。
`list` 会显示每人的最近登录时间，以及「已删除但数据仍在」的用户名清单。

**改这些不需要重启容器**：账号存在 `/data/users.json`，每次请求现读。

### 6.6 其他隔离细节

| 工具 | 行为 |
|---|---|
| `user_create` | 从 MCP 工具列表移除，调用直接报错（账号只能由管理员在工作台/CLI 建） |
| `user_list` | 只返回当前用户自己 |

首次访问某个用户名时，服务会自动建租户并播种 **137 个默认分类（18 顶级 + 119 二级，支出 109 / 收入 28）**。不想自动开通就设 `MYLF_HTTP_AUTO_TENANT=0`。

> `categories` 是**全库行数**（所有用户相加），不是单用户数。只开了 `default` 时是 137，进过 3 个人就是 411。

用户名允许字母、数字、`.`、`_`、`-` 和中文，1–64 位。中文需 URL 编码（`张三` → `%E5%BC%A0%E4%B8%89`），**建议直接用拼音或工号**省事。

### 6.7 「URL 里绑 user + token」够不够？

先纠正一个最常见的误解：**URL 里的用户名不是授权依据，token 才是。**

服务端用 sha256 反查 `users.json`，得到「这个 token 属于谁」；URL 里的 `/mcp/<用户名>` 随后只做一件事 —— **跟 token 归属比对，不一致就 403**。所以：

| 你做的事 | 结果 |
|---|---|
| 改 URL 里的名字（token 不变） | 403 |
| 换一个 token（URL 不变） | 403 |
| 只拿到 URL、没有 token | 401 |
| 拿到某人的 token | 就是那个人本人 —— 这是设计，不是漏洞 |

所以「URL 上限制绑定的用户和 token」这句话里，**真正起作用的是 token**；URL 段的全部价值是防手滑（防止把 alice 的连接器指向 bob 的地址后静默写错账本）。

要让它真正成立，有三个前提，缺一个强度就掉一档：

**① token 放 Header，不要放 URL**

```yaml
# ✅ Octop 连接器里这样配
URL:     http://mylife-finance-mcp.internal:3458/mcp/alice
Headers: Authorization: Bearer <alice 的 token>
```

`?token=xxx` 服务端也认（浏览器首登用，会立即换发 Cookie 并把 token 从地址栏抹掉），但**别拿它配 Octop**：完整 URL 会进 Octop 日志、反代 access log、浏览器历史和 Referer。

**② 一个人一把 token**，不要共用（1.1.2 起默认如此，创建/轮换时只显示一次明文）。

**③ 清楚明文 HTTP 是天花板。** 3458 是纯 HTTP，同网段任何人抓到包就能冒充那个人。所以：

- 只给 Octop 容器用 → 走 docker 内网别名 `.internal`，**不要把 3458 发布到宿主机**，边界就是 docker 网络，够用；
- 要给手机 / 别的电脑用 → 必须套 HTTPS（`mylife-https` 那套 8443 → 3458），否则别指望 token 能挡住谁；套了 HTTPS 记得设 `MYLF_COOKIE_SECURE=1`。

**结论**：够用 —— 但它买到的是「**吊销粒度到人**」，不是「抗攻击」。真出问题的处理路径是：停用账号（会话与 token 同时失效）→ 轮换 token → 改密（所有会话掉线）。三步都在工作台里点得到，不用改 compose。

### 6.8 删用户：账本还在，名字不能随便复用

删账号**不等于**删账本。`users.json` 里删掉一条，SQLite 里 `user_id = 该用户` 的交易/账户/分类还在。如果允许同名直接重建，新账号第一次访问就会被 `ensureTenant` 认成「老租户」，**直接看到前一个人的全部账单** —— 这是本版本修掉的一个真实串号风险。

1.1.3 起：

1. **必须显式声明意图**：`DELETE /api/admin/users/<id>` 不带 `purge` 参数直接 400，并回传「这人名下有多少条数据」。
   - `?purge=0` → 只删账号，账本保留，**留墓碑**；
   - `?purge=1` → 事务清空该租户全部业务表 + 删租户行，之后可直接重建同名。
2. 有墓碑的名字重建会被拒，除非显式「接管旧账本」（管理页勾选框 / `cli.js add --reclaim`）。
3. 删账号时其看板文件 `dashboards/<用户>.html` 一并清理。

> 判断标准很简单：**同一个人的新账号 → 接管；换了人 → 换名字。** 用同一个名字给两个人用，是唯一能真正串号的路径。

### 6.9 审计日志与「最近活动」

| 文件 | 内容 |
|---|---|
| `/data/audit.log` | NDJSON，一行一条，超过 1MB 滚动到 `audit.log.1`（只留一代） |
| `/data/usage.json` | 每人的 `lastLoginAt` / `lastTokenAt` / `lastIp` |

审计覆盖：登录成功/失败/被限速、`?token=` 换登录、退出、改密、下线其他设备、建号/删号/停用/重置密码/轮换 token、非管理员访问、MCP 越权（403）与无效 token（401）。

**不记密码、不记 token 明文** —— 键名命中 `pass|pwd|token|secret|cookie|authorization` 一律打码，测试里也有一条断言守着这一点。

使用痕迹单独存 `usage.json`，不挤进 `users.json`：token 每被调用一次都算一次「使用」，把这种高频写混进凭据文件的 read-modify-write 里，会放大并发写丢数据的面，且一次坏写可能连带弄坏密码哈希。

查看方式：管理页底部「最近操作记录」（最近 50 条），或

```bash
docker exec mylife-finance-mcp tail -n 20 /data/audit.log
```

### 6.10 这套模型防什么、不防什么

- **防**：同网段陌生人（走内网别名或套 HTTPS 时）、内部人误改 URL 串到别人账本、拿到别人连接器 URL 但没有 token 的人、离职后还想用旧 token 的人（停用即失效）。
- **不防**：拿到某人 token 的人（token 就是那个人的身份）、明文 HTTP 上抓包的人、服务器本机 root（能直接读 `/data/finance.db` 与 `/data/session.key`）。
- **不做团队内部分权**：没有「只读成员」「共享账本」这类模型。真要分权，给每人一个实例（各自的数据目录与端口），见 §13。

---

## 7. 单机自用（不走 Docker）

Windows / macOS 本机装 Octop 时，stdio 传输最简单，不必起容器：

```json
{
  "command": "node",
  "args": ["C:/zzytest/mylife-finance-skill/server.js"]
}
```

在控制台添加自定义 MCP 时选 stdio，填上面两项。`userId` 恒为 `default`，沿用 `~/.mylife-finance/finance.db`。

两者的取舍：

| | stdio | Streamable HTTP |
|---|---|---|
| 适用 | Octop 与 Node 同机 | Docker / 远程 / 多人 |
| 用户隔离 | 弱（单用户） | 强（URL 承载） |
| 前置 | 本机装 Node ≥22.13 | 只需 Docker |

> ⚠️ **stdio 模式吃的是 Octop 所在机器的 Node**。如果那台机器只有 Node 20，进程会立刻崩在 `require('node:sqlite')` 上（`ERR_UNKNOWN_BUILTIN_MODULE`）。两条出路：改用 §3 的容器方案（宿主机不需要 Node），或把本机 Node 升到 22.13+ / 24.x。详见 §2.1。

---

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MYLF_HTTP_PORT` | `3458` | 监听端口（MCP + 工作台共用这一个端口） |
| `MYLF_HTTP_HOST` | `0.0.0.0` | 监听地址；容器内必须 `0.0.0.0` |
| `MYLF_DATA_DIR` | `~/.mylife-finance` | 数据目录；容器里设 `/data`。账号在 `/data/users.json`，会话密钥在 `/data/session.key` |
| `MYLF_ADMIN_USER` | `admin` | 首次启动创建的管理员用户名（仅 `users.json` 为空时生效） |
| `MYLF_ADMIN_PASSWORD` | 随机 | 管理员初始密码。不设则随机生成并写 `/data/ADMIN-PASSWORD.txt` + 日志提示 |
| `MYLF_SESSION_SECRET` | 自动生成 | 会话签名密钥。不设则生成到 `/data/session.key`（备份数据时要一起带走，否则所有人需重新登录） |
| `MYLF_COOKIE_SECURE` | 空 | `1` = 会话 Cookie 加 `Secure`。**只有前面挂了 HTTPS 反代才设**；明文 HTTP 下设了浏览器直接不收，表现为「登录成功但一刷新又回登录页」 |
| `MYLF_HTTP_TOKEN` | 空 | **旧版全局令牌**，只代表 `MYLF_HTTP_TOKEN_USER` 一人。新部署别用，见 §6.4 |
| `MYLF_HTTP_TOKEN_USER` | `admin` | 旧版全局令牌绑定的用户名（大小写敏感） |
| `MYLF_HTTP_AUTO_TENANT` | `1` | `0` 关闭新用户自动开通租户 |
| `MYLF_PUBLIC_BASE_URL` | 空 | 对外基址（如 `http://192.168.130.8:3458`）。设了之后 `dashboard_build` 返回可点击的看板 URL；不设只返回容器内路径 |
| `MYLF_WB_PORT` / `MYLF_WB_USER` | `3457` / `default` | 仅本地 `workbench.js` 用（单机、免登录），容器里不需要 |

---

## 9. 数据备份与迁移

库文件在数据卷里，单文件备份即可：

```bash
# 备份
docker run --rm -v mylife-finance-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/finance-$(date +%F).tar.gz -C /data finance.db

# 恢复到新机器
docker run --rm -v mylife-finance-data:/data -v "$PWD":/backup alpine \
  sh -c "tar xzf /backup/finance-YYYY-MM-DD.tar.gz -C /data"
```

SQLite 开了 WAL，热备建议先停容器，或用 `sqlite3 finance.db ".backup /data/bak.db"`。

---

## 10. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| Octop 里工具列表为空 | MCP URL 不通 | `docker exec <octop容器> wget -qO- http://mylife-finance-mcp:3458/health` |
| 连接超时 | 两个容器不在同一 network | 确认 compose 里 network 一致，或把服务粘进 Octop 的 compose |
| 401 unauthorized | 没带凭据，或格式不对（**必须 `Bearer ` 开头且有空格**） | 补成 `Authorization: Bearer <该用户 token>`；工作台则去 `/login` 登录 |
| **403 forbidden：凭据属于「a」不能访问 /mcp/b** | 拿 A 的 token 打了 B 的用户名（1.1.2 起的正常拦截） | 让 URL 里的用户名与 token 所属用户一致；或给该用户单独发一个 token |
| 403 但确认是同一个名字 | 用户名**大小写不一致**（`Admin` ≠ `admin`） | 用 `/admin` 页面核对准确拼写，或设 `MYLF_HTTP_TOKEN_USER` 对齐 |
| 登录页说用户名或密码不正确 | 首次启动的随机密码没找到 | 看 `/data/ADMIN-PASSWORD.txt`，或 `docker logs mylife-finance-mcp` 开头的提示 |
| 忘记管理员密码 | 无法自助找回 | `docker exec mylife-finance-mcp node src/cli.js passwd admin`（会打印新密码） |
| 登录后立刻又跳回 `/login` | 数据目录不可写导致 `session.key` 生成失败，或 `MYLF_SESSION_SECRET` 每次重启都换 | 检查 `/data` 挂载与权限；把 `session.key` 一并纳入备份 |
| 工作台只能看自己那份、切不了用户 | **这是设计**，不是 bug | 要看别人的账本请用那个人的账号登录 |
| 新增用户后他看的是空账本 | 用户名新建了一个新租户（新账本 + 137 默认分类） | 历史数据不会自动搬家，见 §13 |
| `unhandled errors in a TaskGroup (1 sub-exception)` | Octop 侧 Python 客户端崩了，真实异常被藏在 sub-exception 里 | 按 §10.1 三步定位，九成是 Header 或网络 |
| 400 非法 userId | URL 里有 `/`、空格或超长 | 换成 `alice`、`u001` 这类简单标识 |
| 技能不生效 | 技能未启用，或 Agent 用错 | `octop skills list --agent <id>` 确认 |
| 分类树是空的 | 关掉了自动开通且用户不存在 | 去掉 `MYLF_HTTP_AUTO_TENANT=0`，或先建用户 |
| 容器起不来，日志报 Node 版本 | 基础镜像太旧 | 换 `node:22-alpine` 最新，要求 ≥22.13 |
| `dashboard_build` 返回的路径打不开 | 返回的是容器内路径，另一个容器读不到 | 设 `MYLF_PUBLIC_BASE_URL` 后用返回的 `url`，或浏览器打开 `http://<主机>:3458/dashboard.html`（§5.2） |

### 10.1 `unhandled errors in a TaskGroup (1 sub-exception)` 怎么查

这条消息来自 **Python 3.11+ 的 `asyncio.TaskGroup`**：只要任务组里有一个子任务抛异常，外层就统一抛这句，真正的原因在 `sub-exception` 里。Octop 没把它展开，所以**这句话本身不含任何诊断信息** —— 等价于「MCP 客户端在后台任务里崩了」。

按顺序跑这三条，基本能锁定：

```bash
# ① 容器活着、端口真的发布了
docker ps --filter name=mylife-finance-mcp --format '{{.Status}}  {{.Ports}}'
#   期望：Up ...   0.0.0.0:3458->3458/tcp

# ② 从 Octop 容器内部能不能连通（/health 不需要 token）
docker exec <octop容器> sh -c 'wget -qO- http://<MCP地址>:3458/health'

# ③ 带鉴权头走一次真正的 MCP 握手
curl -si -X POST http://<MCP地址>:3458/mcp/alice \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

| 看到 | 含义 | 处理 |
|---|---|---|
| `HTTP/1.1 200` + `Mcp-Session-Id:` 头 | 服务端完全正常，锅在 Octop 侧 | 看 Octop 后端日志里的 sub-exception 真身 |
| `401 unauthorized`（纯文本） | Header 不对。服务端正则是 `^Bearer\s+(.+)$`，少个 `Bearer` 或空格就 401 | 改成 `Authorization: Bearer <token>` |
| `405` | 路径对但方法错；本实现不提供 SSE 推送通道 | Transport 选 `streamable_http`，探测走 POST 不是 GET |
| `404 not found` | 路径不是 `/mcp/<userId>` | 补全 `/mcp/<用户名>` |
| 连接被拒 / 超时 | 网络层不通 | 确认 IP 是宿主局域网 IP（不是 docker 网桥）、端口已发布、防火墙放行 |

> ★ `/health` **不需要** token，而 `/mcp/*` **需要**。所以「`/health` 能通、连接器却报错」几乎一定是 token 头写法问题，不用怀疑网络。

**★ 同机不同 docker 网络（QNAP / 群晖上最常见）**

两个容器都在同一台 NAS 上，但 IP 分属不同网段（如 Octop `172.29.0.2`、MCP `172.29.4.2`）⇒ 它们在不同 bridge 网络上。此时：

- 容器 → 容器（跨桥）：被 docker 的 `DOCKER-ISOLATION` 规则阻断；
- 容器 → 宿主 LAN IP 的发布端口：依赖 `userland-proxy`，**QNAP Container Station 常把它关掉**，于是也不通。

表现就是：PC **能** `curl http://<NAS_LAN_IP>:3458/health`，Octop 容器**不能**，报的还是那句没信息量的 TaskGroup 错误。

**判据（很灵的旁证）**：`curl -s http://<NAS_LAN_IP>:3458/health` 返回里的 `categories` 是全库分类行数。每次成功连到一个**新** userId 会 +137。所以反复探测某个用户名后 `categories` **一直不变**，就说明请求压根没到服务端 —— 网络问题，不要再查 token。

**解法：把 MCP 接进 Octop 的那个网络**（不走宿主 IP，也不需要发布端口）：

```bash
# 1) 找 Octop 的网络名（IP 为 172.29.0.2 的那个）
docker inspect <octop容器> -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'

# 2) 把 MCP 接进去，并给一个 .internal 别名（Octop 校验器只放行 .internal 等后缀）
docker network connect --alias mylife-finance-mcp.internal <上一步的网络名> mylife-finance-mcp

# 3) 从 Octop 容器内部验证（能通才算通）
docker exec <octop容器> sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'
```

连接器 URL 改成 `http://mylife-finance-mcp.internal:3458/mcp/<用户名>`。

- 若第 3 步**解析不到**带点的别名，退回用 MCP 在该网络上的 IP（也是私网 IP，能过校验器）：`docker inspect mylife-finance-mcp -f '{{index .NetworkSettings.Networks "<网络名>" "IPAddress"}}'`，URL 写 `http://172.29.0.x:3458/mcp/<用户名>`。缺点：容器重建后 IP 会变。
- `docker network connect` 是**临时**的，`docker compose up` 重建容器就丢了。验证成功后要写进 compose（见 §3.4 的 C 变体）才持久。
- **治本方案见 §3.5**：把 Octop 与 MCP 写进同一份 compose（`docker-compose.qnap-octop-mcp.yml`），或用固定网络名 `mylife-net` + `external: true`。**根因是两份 YAML 各自省掉 `networks:` 段，各建各的 `<项目名>_default`** —— 名字不可控，别去猜。

---

## 11. 已知边界（诚实说明）

1. **MCP 必须手点注册**，如上所述，无稳定接口。
2. **`dashboard_build` 生成的是容器内文件**：1.1.1 起可通过 `http://<主机>:3458/dashboard.html` 在浏览器打开（设了 `MYLF_PUBLIC_BASE_URL` 时工具会直接返回该 URL），但 Octop 对话里无法内联渲染这张图；要数字就用 `report_monthly` / `report_by_category` / `report_budget`。
3. **`import_from_mylife` 容器内默认无效**：需要把 MyLifeOS 的 `mylife-os.db` 挂进容器并传 `dbPath`。
4. **图形工作台 `workbench.js` 未容器化**：它是给人点着用的，跨容器访问要另开端口，按需自己加。
5. **未做 MCP 会话校验**：`initialize` 会下发 `Mcp-Session-Id`，但不强制校验，以兼容未回带该头的客户端。内网部署可接受；暴露公网请加 `MYLF_HTTP_TOKEN` 并前置 TLS。
6. **镜像未经真实构建验证**：开发机没有 Docker。HTTP 传输层、多用户隔离、Server 与客户端路径均在本机 `node server-http.js` 上实测通过（见 §12 末尾的验证记录），但 `docker build` / `compose up` 本身未跑过，首次构建请留意日志。

---

## 12. 第二个客户端接入（局域网的其他 WorkBuddy）

**结论：能，而且共用同一本账。** 前提是把 MCP 从「容器内网可达」改成「局域网可达」。

### 12.1 为什么可以共用

MCP 服务是**无状态 HTTP**，账本在服务端单一的 `/data/finance.db` 里。客户端只是发起 JSON-RPC 调用，谁连上都是同一个库；客户端数量不影响一致性。

实测（本机两个独立进程指向同一 `finance.db`，模拟 Octop 与 WorkBuddy 同时使用）：

| 项 | 结果 |
|---|---|
| 跨进程并发写 30 次（两进程交替） | **0 失败**，两进程读数一致（各 27 笔） |
| 同进程并发写 20 次 | 0 失败 |
| `PRAGMA journal_mode` | `wal`，`busy_timeout=5000` |

所以不需要「把库同步来同步去」，**接同一个地址即可**。

### 12.2 先让端口对局域网开放

compose 里默认是 `127.0.0.1:3458:3458`（只给宿主机调试用）。改成对局域网开放：

```yaml
    ports:
      - "3458:3458"        # 局域网可访问（原为 127.0.0.1:3458:3458）
```

**同时必须打开鉴权**，否则同网段任何人只要知道地址就能读写任意用户的账：

```yaml
    environment:
      MYLF_HTTP_TOKEN: "一个长随机串"
```

改完 `docker compose -f docker-compose.mylife-finance.yml up -d`，在**另一台机器**上验证：

```bash
curl -s http://<Octop主机IP>:3458/health
# 无 token 访问 /mcp 应返回 401，带 token 返回 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<Octop主机IP>:3458/mcp/zhang \
  -H "Authorization: Bearer 你的令牌" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

### 12.3 在第二个 WorkBuddy 里注册

左侧「连接器 → 自定义连接器 → 配置 MCP」，写入：

```json
{
  "mcpServers": {
    "mylife-finance": {
      "type": "streamableHttp",
      "url": "http://192.168.1.20:3458/mcp/zhang",
      "headers": {
        "Authorization": "Bearer 你的令牌"
      }
    }
  }
}
```

要点：

| 项 | 说明 |
|---|---|
| `type` | 必须是 **驼峰** `streamableHttp`。写全小写 `streamablehttp` 客户端不识别，会静默加载失败 |
| `url` 末段 | `zhang` 就是**你看哪本账**。和 Octop 里用同一个名字 ⇒ 同一本账；换名字 ⇒ 新建一本空账 |
| `headers` | 必须是**该用户自己的 token**（`/admin` 里生成）。拿 A 的 token 配 `zhang` 会 403，因为服务端校验凭据归属 |
| 保存后 | 还要在连接器列表里**手动启用**，否则工具不会加载 |
| 技能层 | 另需把 `dist/mylife-finance-skill-1.2.2.zip` 解到该机器的 `~/.workbuddy/skills/mylife-finance/`（提示词层与工具层是两件事） |

**如果你的客户端强制要求 URL 以 `/mcp` 结尾**，改用查询参数形式（已实测可用，效果完全相同）：

```
http://192.168.1.20:3458/mcp?user=zhang
```

### 12.4 两个客户端的定位

| | 一台 Windows WorkBuddy | 这个局域网 MCP |
|---|---|---|
| 数据位置 | 本机 `%USERPROFILE%\.mylife-finance\finance.db` | 服务器 `/data/finance.db` |
| 数据是否互通 | **否**，两套独立账本 | 所有连上来的客户端共用 |
| 「我该用哪套」 | 只在单机用 | 想让手机/多台电脑看到同一本账时 |

⚠️ 别做「既在本地记、又在服务器记」的双写，两套库不会自动合并。

---

## 13. 把本机已有账本搬到服务器

本机库：`C:\Users\<你>\.mylife-finance\finance.db`（用户名 `default`）。

```bash
# 1) 先停掉本机 MCP / 工作台，避免拷到写一半的状态（或先做 WAL 检查点）
#    容器那边也先停：docker compose -f docker-compose.mylife-finance.yml down

# 2) 用 SQLite 备份接口导出（比直接拷 .db 安全，会自动合并 WAL）
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/Users/zhouz/.mylife-finance/finance.db');d.exec(\"VACUUM INTO 'C:/zzytest/finance-export.db'\");d.close()"

# 3) 传上去
scp C:/zzytest/finance-export.db user@<Octop主机>:/tmp/finance.db

# 4) 灌进数据卷（宿主机执行）
docker run --rm -v mylife-finance-data:/data -v /tmp:/src alpine \
  sh -c "cp /src/finance.db /data/finance.db && chown 0:0 /data/finance.db"

# 5) 重启并验证
docker restart mylife-finance-mcp
curl -s http://127.0.0.1:3458/health
```

**用户名怎么对**：你本机数据在 `default` 名下。两种选择——

- **最省事**：MCP 地址就用 `/mcp/default`，数据原样可见，不用改库。
- **想用有意义的名字**（如 `zhang`）：改库重命名 8 张表 + `users`：

```sql
BEGIN;
UPDATE users        SET name='zhang' WHERE name='default';
UPDATE accounts     SET user_id='zhang' WHERE user_id='default';
UPDATE categories   SET user_id='zhang' WHERE user_id='default';
UPDATE members      SET user_id='zhang' WHERE user_id='default';
UPDATE merchants    SET user_id='zhang' WHERE user_id='default';
UPDATE projects     SET user_id='zhang' WHERE user_id='default';
UPDATE transactions SET user_id='zhang' WHERE user_id='default';
UPDATE budgets      SET user_id='zhang' WHERE user_id='default';
UPDATE receivables  SET user_id='zhang' WHERE user_id='default';
COMMIT;
```

搬完自查：别再想 `curl -H 'x-user-id: ...'`（1.1.2 起无效）。用该用户的 token 调一次 `report_monthly`，看笔数是否与迁移前一致；或登录工作台看首页汇总。

---

## 14. 没有 Docker 的机器上产出镜像文件

场景：改代码的机器没装 Docker（或装了但引擎起不来），要在有 Docker 的服务器 / NAS 上直接导入。

`docker save` 需要本地镜像，没有 Docker 就用不了。替代做法是**自己组装镜像归档**：从 registry 拉官方 `node:22-alpine` 的层（内容不改一个字节），把本仓库的应用文件打成新的一层，再按目标格式封装成 tar。

```bash
cd mylife-finance-skill
node scripts/build-image-tar.mjs            # 默认 docker 格式（docker save 兼容）
node scripts/build-image-tar.mjs --gzip     # 额外再出一个 .tar.gz（体积约 1/3，网页上传更稳）

# 换镜像源（默认 docker.m.daocloud.io；某个源当天不通就换，见下方说明）
node scripts/build-image-tar.mjs --registry https://docker.1ms.run
# 换产物标签 / 平台
node scripts/build-image-tar.mjs --tag mylife-finance-mcp:1.2.2 --platform linux/amd64
# 给 containerd / podman 用（Docker 24 及更早不认，NAS 界面通常也不认）
node scripts/build-image-tar.mjs --format oci
```

> 构建脚本按 **Docker Registry v2 标准鉴权**：先请求，遇 401 就按 `WWW-Authenticate` 里的 realm
> 换 token 再重试，所以官方源、国内加速镜像、匿名代理都能用。1.2.2 之前默认的 `dockerproxy.net`
> 已不可达（`fetch failed`），默认值已换成 `docker.m.daocloud.io`；实测可达的备选还有
> `https://docker.1ms.run`。

产物（`dist/`）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `mylife-finance-mcp_1.2.2-linux-amd64.tar` | 163.5 MB | **首选**，`docker load` / Container Station / 群晖 通用 |
| `mylife-finance-mcp_1.2.2-linux-amd64.tar.gz` | 58.4 MB | 同上，只是外层 gzip；网页上传慢时用它 |

### 14.0 ★ 两种归档格式别搞混（这是「导入格式不正确」的头号原因）

| | **docker（默认，本次修的）** | oci（旧产物，`--format oci`） |
|---|---|---|
| 根目录 | `manifest.json` + `<cfg-sha>.json` + `<layer-id>/layer.tar` + `repositories` | `oci-layout` + `index.json` + `blobs/sha256/*` |
| 层 | `<64位id>/layer.tar`，**未压缩** tar | `blobs/sha256/<digest>`，**gzip 裸 blob** |
| 谁认 | `docker save` 同款；Docker 20.10–27 全版本、Container Station、群晖、`docker load` | 仅 containerd / podman / `docker load`(含 containerd 存储时) |
| 谁不认 | —— | **Docker ≤ 24 的 `docker load`**、**QNAP Container Station「导入映像」**、多数 NAS 图形界面 |

早期产物是 OCI 布局，QNAP Container Station 导入时会直接判「docker 格式不正确」——不是文件坏了，是布局不是它要的那种。现已默认改为 docker 格式（`manifest.json` 放最后，与真 `docker save` 顺序一致）。

### 14.1 在目标机器上加载

**A. 有 SSH 的 Linux / NAS（最稳）**

```bash
# 1) 拷过去（scp / U 盘 / 内网共享都行）
scp dist/mylife-finance-mcp_1.2.2-linux-amd64.tar.gz user@server:/tmp/

# 2) 加载（.tar / .tar.gz 都能吃，docker 会自动解压）
docker load -i /tmp/mylife-finance-mcp_1.2.2-linux-amd64.tar.gz
#   期望输出：Loaded image: mylife-finance-mcp:1.2.2

# 3) 确认
docker image inspect mylife-finance-mcp:1.2.2 --format '{{.Os}}/{{.Architecture}} {{.Config.Entrypoint}}'
#   期望 linux/amd64 [/usr/local/bin/docker-entrypoint.sh]

# 4) 起容器（MYLF_PUBLIC_BASE_URL 换成你实际访问用的地址，看板 URL 才会可点击）
docker run -d --name mylife-finance-mcp \
  -p 3458:3458 -v mylife-finance-data:/data \
  -e MYLF_PUBLIC_BASE_URL=http://192.168.130.8:3458 \
  --restart unless-stopped mylife-finance-mcp:1.2.2

# 5) 验证
curl -s http://127.0.0.1:3458/health
#   期望 {"ok":true,"transport":"streamable-http","toolCount":42,...}
# 工作台：浏览器打开 http://<主机>:3458/login 登录（首次密码见 /data/ADMIN-PASSWORD.txt）
```

**B. QNAP Container Station（图形界面导入）**

1. 先确认架构（**必须**，装错架构导入成功也起不来）：SSH 进去执行 `uname -m`
   - `x86_64` → 用 `linux-amd64` 包（当前产物）
   - `aarch64` / `arm64` → 本机重新生成：`node scripts/build-image-tar.mjs --platform linux/arm64 --gzip`
2. Container Station → **映像** → **导入** → 选择 `.tar` 或 `.tar.gz` → 等待完成。
3. 列表里应出现 `mylife-finance-mcp:1.2.2`（名字来自 `manifest.json` 的 `RepoTags`）。
4. 用该映像新建容器：端口映射 **3458→3458**、挂载卷（或共享文件夹）到 **`/data`**、命令与入口**留空**（走镜像默认）、勾选自动重启。
5. 浏览器访问 `http://<NAS_IP>:3458/health` 确认。

> Container Station 若仍报格式问题，说明它这版只认 `.tar` 或自身解析有缺陷：改用 SSH + `docker load -i`（QNAP 的 `docker` 命令可用，需要先在「控制台 → 网络和文件服务 → Telnet/SSH」开启 SSH）。

要接 Octop：`http://<NAS_IP>:3458/mcp/<userId>`，其余注册步骤同 §5。

### 14.2 这个归档里有什么

| 内容 | 说明 |
|---|---|
| 4 个基础层 | 官方 `node:22-alpine` 原样搬运（sha256 与 registry 一致），落盘时解压成未压缩 `layer.tar` |
| 1 个应用层 | `app/{package.json,server.js,server-http.js,src/**}` + `/usr/local/bin/docker-entrypoint.sh`（0755）+ `/data` |
| config | 继承基础镜像的 Env，追加 `NODE_ENV/MYLF_DATA_DIR/MYLF_HTTP_PORT/MYLF_HTTP_HOST`；`WorkingDir=/app`、`Entrypoint=/usr/local/bin/docker-entrypoint.sh`、`Cmd=node --no-warnings server-http.js`、暴露 3458、卷 `/data`、healthcheck 同 Dockerfile |
| manifest.json | `RepoTags` 决定 load 后的镜像名；`Layers` 顺序即 diff_ids 顺序 |
| repositories | tag → 顶层 layer id，老工具（含部分 NAS）会读它 |

体积为什么从 58.7 MB 变成 163.5 MB：docker 格式要求 `layer.tar` **未压缩**（`node:22-alpine` 解压后主要是 149 MB 的 Node 运行时层）。这是 `docker save` 的正常体积，不是膨胀出错；嫌大就用 `.tar.gz`（58.4 MB）。

脚本自带结构校验（任一不通过直接 `exit 1`）：`manifest.json` 存在且 `RepoTags` 含目标 tag、层路径必须是 `<64位id>/layer.tar`、每层带 `VERSION=1.0`、每层内容 sha256 **逐层等于** `config.rootfs.diff_ids[i]`、每层首两字节不得是 gzip、`repositories` 指向顶层 layer id、不得残留 `blobs/` `index.json` `oci-layout`、应用层入口脚本 mode=755 且 `app/server-http.js` 在场。

出包后（尤其文件搬过机器、拷过 U 盘）再复核一次：

```bash
node scripts/verify-image-archive.mjs          # 默认查 dist/ 下当前版本的 tar
```

不依赖 Docker，做四件事：确认是合法 Docker Archive；config 的版本标签 / Entrypoint / Cmd / 端口 / 卷与仓库一致；**应用层逐文件与工作区源码 sha256 双向比对**（不多、不少、不改）；把应用层解到临时目录并打印实跑命令。任何一项不符即 `exit 1`。

### 14.3 兼容性与边界（请先看）

- **架构必须匹配**：产物只含单一架构（默认 linux/amd64）。ARM 设备（多数 ARM 版群晖/威联通、Oracle 免费机、M 系列 Mac）需 `--platform linux/arm64` 重新生成。
- **目标机必须是 Linux 容器模式**。Windows 上切到 "Windows containers" 会报 `cannot load linux image on windows`。
- **与本机 Dockerfile 的差异**：不包含 `workbench.js`（和 Dockerfile 一致，镜像只跑 MCP 服务）；`scripts/`、`docs/`、`fixtures/` 不进镜像。
- **产物不含镜像签名 / SBOM**，属内部使用范畴。
- **尚未在真实 Docker 上执行过 `docker load`**（本机 Docker 引擎未运行）。已做的验证（1.2.2）：① 脚本自身的结构校验（应用层 21 个文件 + 7 个目录、5 层 `diff_id` 逐层匹配、入口 mode=755、无 gzip 层）；② 独立复核脚本从归档里解出应用层，与工作区 **21 个文件逐字节 sha256 一致**（19 项检查全过）—— 这条证明「打进包里的就是测试过的那份代码」，而不是另拿一份源码测；③ 把应用层解到磁盘直接 `node server-http.js` 起服务，对它跑 **206 项**测试全通过（`test-auth` 46 + `test-webapp-http` 31 + `test-accounts-v2` 42 + `e2e-octop-mcp` 27 + `test-workbench-v2` 60），覆盖登录、越权 403、强制改密闸门、删号与同名重建、审计、按用户分文件的看板、MCP 握手与**43 个工具清单**、账户余额调整三条路径、年份/分类筛选、报表六维度聚合、**交易视图的 `categoryParent`（二级上卷一级）**、**分类同名校验 11 条**（跨父级拦截、一级与二级同名拦截、首尾空格、二级不许再挂子级、改名撞车、被拦请求不落库）；④ `.tar.gz` 的 gzip 头与 ISIZE 校验。**首次 `docker load` 请留意输出**，报错把原文发我。
- **老库（1.2.1 及更早）升级时的分类唯一索引**：若库里已存在同名不同父级的分类，启动只打一行提示并跳过建索引（**不会崩、不影响使用**），新增仍由应用层拦截；用「分类管理 → 扫描重复」把 `同名不同父级` 合并掉，重启一次索引自动补上。这条路径是实机验证过的（造了个带 2 条历史重名的库，启动 → 拦截 → 合并 → 重启 → 索引生效，全程无报错）。

### 14.4 校验搬运没出错

```bash
sha256sum /tmp/mylife-finance-mcp_1.2.2-linux-amd64.tar.gz
```

本机产出的值（1.2.2 / amd64 / docker 格式）：

| 产物 | sha256 |
|---|---|
| `mylife-finance-mcp_1.2.2-linux-amd64.tar`（163.5 MB） | `3177e4a62a64926966fbfae7cc312b04b33753a5b53f774dcac7a7a68e69bc6e` |
| `mylife-finance-mcp_1.2.2-linux-amd64.tar.gz`（58.4 MB） | `e578f4bc09a86bb65011a92e63ecc75252e8a73108d5b45dece2cc35bfbf7c12` |
| `mylife-finance-skill-1.2.2.zip`（7.1 KB） | `0e39fdb68e13dbc80b7c5b8d1d805d1fe3a2f235ff7a195a264fa0095dbbb1f7` |
