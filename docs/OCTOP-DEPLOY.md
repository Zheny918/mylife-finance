# 部署到 Octop / Docker（多人共用）

面向 **Docker 部署 + 家庭/团队多人**：两件套怎么装、连接器怎么填、用户怎么隔离、出问题怎么查。
单机自用可以跳过容器，直接看 [§7](#7-单机自用stdio)。

> **当前 v1.2.4**。三件套都在 `dist/`：`*.tar` / `*.tar.gz`（镜像）+ `mylife-finance-skill-*.zip`（技能）。
> 精简前的完整版文档存档在 [`docs/archive/OCTOP-DEPLOY-v1.2.2-original.md`](archive/OCTOP-DEPLOY-v1.2.2-original.md)。

| 版本 | 变更 | 升级动作 |
|---|---|---|
| **1.2.4** | 报表页拆分：账户 / 成员 / 商家 / 项目 四个维度各拆成「收入统计」「支出统计」两张饼图（共 10 张），每张口径固定 | 换镜像重建，`/data` 不动 |
| 1.2.3 | 收支明细分页（默认 20 条/页，可选 20/50/100/200/500/1000）+ 本页/全部两行合计；报表默认今年；分类一级折叠并带底色 | 换镜像重建，`/data` 不动 |
| 1.2.2 | 分类名同类型下全局唯一（应用层拦截 + 导入归一 + `UNIQUE(user_id,type,name)` 兜底）；老库有重名时只告警不建索引，合并后重启自动补 | 换镜像重建，`/data` 不动 |
| 1.2.1 | 界面调整：本月交易拆发生/目标账户、报表去掉冗余的「饼图口径」、导航定序、明细年份默认本年 + 日期区间控件、分类左右并排 | 同上，接口只多一个 `categoryParent` |
| 1.2.0 | 首页重做（累计天数/明细数、本月收支、混合趋势图）、账户卡号备注与余额调整流水、年份下拉与一二级分类联动、报表六饼图（新增 `report_overview`） | 同上，只 `ALTER TABLE ADD COLUMN` |
| 1.1.4 | 修工作台写入按钮全挂的 `Content-Type` 报错（1.1.2/1.1.3 受影响） | 换镜像，`/data` 不动 |

---

## 1 为什么是「两件套」

Octop 四种扩展形态，只有一种能带 MCP：

| 形态 | 打包方式 | 能带什么 | 能声明 MCP |
|---|---|---|---|
| 技能包 | ZIP，根上 `SKILL.md` | 提示词 + 资源 | **不能** |
| 专家包 | ZIP，根上 `manifest.json` | `SOUL.md` + `skills/` + 子 Agent | **不能** |
| 插件包 | ZIP，根上 `plugin.yaml` + `main.py` | Python 工具 / 技能 / hook / 通道 | **不能** |
| 自定义 MCP | 控制台手点添加 | stdio 或 streamable HTTP | 它本身就是 MCP |

`plugin.yaml`、`manifest.json` 都没有 `mcp` 字段。所以**技能走技能包、工具走自定义 MCP**，两条通道各装一次：

```
用户 → Agent「记账助理」
         ├─ 技能层 skills/mylife-finance/SKILL.md（怎么记账）
         └─ 工具层 连接器 ──POST /mcp/<userId>──► mylife-finance-mcp:3458
                                                      │ 按 user_id 隔离
                                                  /data/finance.db
```

---

## 2 前置条件

| 项 | 要求 |
|---|---|
| Octop | 已 `octop init` + `octop run`（Docker 下数据目录 `/data/.octop`） |
| Node | **看你把代码跑在哪个进程里，见 §2.1**；Docker 拓扑下宿主机不需要 Node |
| 依赖 | 无（零 npm 依赖，不需要 `npm install`） |
| 磁盘 | 约 10 MB + 数据（千级记录 1–2 MB） |

### 2.1 Node 版本：需要 ≥ 22.13，但和宿主机无关

| 使用方式 | 执行代码的 Node | 要求 |
|---|---|---|
| **MCP 容器**（`server-http.js`，推荐） | 镜像自带 `node:22-alpine` | 宿主机版本**完全无关**，甚至可以不装 Node |
| **stdio 模式**（`node server.js`） | Octop 所在机器的 Node | **必须 ≥ 22.13** |
| **本地工作台**（`workbench.js`） | 你本机的 Node | **必须 ≥ 22.13** |

为什么卡 22.13：`src/db.js` / `src/tools.js` 直接 `require('node:sqlite')`，没有降级分支。该模块在 **v22.5.0** 引入（需 `--experimental-sqlite`）、**v22.13.0**（同 v23.4.0）起免标志可用；**v20 完全没有这个模块**，`require` 直接抛 `ERR_UNKNOWN_BUILTIN_MODULE`，且不会回补。除它之外其余代码在 Node 20 上都能跑，所以改动面很窄。

**只有 Node 20 怎么办**：① 用容器跑 MCP（宿主机不需要 Node，首选）；② 并行装一个 Node 22（便携版 / nvm-windows / `winget install OpenJS.NodeJS.LTS`，不影响现有 20）；③ 换 `better-sqlite3`（打破零依赖，非必要不选）。

**两个正常现象**：`ExperimentalWarning: SQLite is an experimental feature` 在 22.x 上会出现（v24.15.0 起升为 RC），启动命令已加 `--no-warnings`；容器入口**硬卡** `>= 22.13`，22.5–22.12 加 `--experimental-sqlite` 其实能用，但入口不自动补标志，会直接退出。

---

## 3 构建并启动

### 3.1 先确认 Docker 引擎真的可用（Windows 最容易卡在这）

CLI 装好 ≠ 引擎可用。典型坏状态：`docker --version` 有输出，但每个命令都 500。

```bash
docker version --format '{{.Server.Version}}'   # 能打印版本才算可用
docker desktop status                            # Windows 直接看状态
```

| 现象 | 处理 |
|---|---|
| 全部 500 / `unable to start` | 托盘右键 Restart；不行就 `wsl --shutdown` 后重开（管理员） |
| `status` 显示 stopped | 启动 Docker Desktop，等托盘变绿（首次 1–3 分钟） |
| 提示虚拟化未启用 | BIOS 开 VT-x/SVM，或 `wsl --update` |

> 首次 `docker build` 要拉 `node:22-alpine`（约 50 MB），需能访问 Docker Hub；国内慢可配镜像加速。

### 3.2 一条命令：构建 + 全量验收（推荐）

```bash
cd mylife-finance-skill
node scripts/docker-build-verify.mjs        # 7 组全过才返回 0，结束自动清理测试容器/卷
```

| 组 | 验什么 |
|---|---|
| 1 守护进程 | 引擎可连接（否则立刻停并给出修法） |
| 2 构建 | `docker build` 成功 + 镜像存在 |
| 3 镜像内运行时 | Node ≥ 22、`node:sqlite` 能加载 |
| 4 容器启动 | `/health` 90s 内就绪、`toolCount=43`、`transport=streamable-http` |
| 5 MCP 协议 | 下发 `Mcp-Session-Id`、`tools/list` 43 个、通知 202 |
| 6 写入与隔离 | 记账成功、新租户播种 137 分类、bob 看不到 alice、伪造 `userId` 无效、`user_create` 被拒、非法 userId 400 |
| 7 数据持久化 | `docker restart` 后数据仍在（`/data` 卷生效） |

常用开关：`--no-build`（只验已有镜像）、`--keep`（保留容器便于 curl）、`--port 3499`（换宿主端口）、`--tag a:b`。

### 3.3 手动构建与启动

```bash
docker network ls | grep -i octop                       # 1) 查 Octop 网络名（默认 <目录名>_default）
OCTOP_NETWORK=octop_default \
  docker compose -f docker-compose.mylife-finance.yml up -d --build   # 2) 起服务
curl -s http://127.0.0.1:3458/health                    # 3) 验证
```

镜像标签与 `package.json` 一致（当前 `mylife-finance-mcp:1.2.4`），可用 `MYLF_IMAGE` 覆盖。`/health` 正常返回：

```json
{"ok":true,"transport":"streamable-http","toolCount":43,"dataDir":"/data","categories":137}
```

> 更省事：把 `docker-compose.mylife-finance.yml` 里 `services.mylife-finance-mcp` 整段粘进 Octop 自己的 compose，自动同网络，不用 `OCTOP_NETWORK`。

### 3.4 只有镜像、没有源码（QNAP / 群晖 / 任意 Linux）

`docker-compose.mylife-finance.yml` 带 `build:` 和 `external` 网络，没源码不能用。改用 `docker-compose.standalone.yml`：只用 `image:`、独立 bridge、发布端口。

| 做法 | 前提 | build | 网络 | 适用 |
|---|---|---|---|---|
| `docker-compose.mylife-finance.yml` | 有源码 + Octop 同机 | 要 | `external` → `octop_default` | 开发机一条龙 |
| **`docker-compose.standalone.yml`** | **只要有镜像** | 不用 | 独立 bridge + 发布 3458 | QNAP / 群晖 / 任意 Linux |
| 粘进 Octop 自己的 compose | Octop 同机 | 可选 | 自动同网络 | 想省事 |

**QNAP Container Station**：① 先在「映像」里确认 `mylife-finance-mcp:1.2.4` 在列（名字来自 tar 里 `manifest.json` 的 `RepoTags`；显示 `<none>` 就 `docker tag <ID> mylife-finance-mcp:1.2.4`）；②「应用程序 → 创建 → Docker Compose」；③ 整段粘入 standalone，只改两处：`image:` 实际名字、`MYLF_HTTP_TOKEN:`（**端口对局域网开放就必须设**，Octop 连接器 Headers 填同一个值）；④ 部署后容器「运行中」；⑤ `curl -s http://<NAS_IP>:3458/health`。

**SSH / 任意 Linux**：

```bash
docker compose -f docker-compose.standalone.yml up -d
docker compose -f docker-compose.standalone.yml logs -f --tail 50
docker compose -f docker-compose.standalone.yml down      # 数据在命名卷里，不丢
```

**想用容器名而不是 IP**：网络段换成带别名的映射并**删掉 `ports:`**，见 §3.5 方案 A。

| 现象 | 原因 | 处理 |
|---|---|---|
| `pull access denied` / `No such image` | `image:` 写错或导入后没 tag | `docker images` 查实际名再改 |
| `network octop_default declared as external, but could not be found` | 宿主没跑 Octop | 换 standalone / 删 `networks` 段 |
| compose 报 `services` 键非法 | Container Station 用老版 compose | **别删** `version: "3.8"` |
| 一直 `unhealthy` | 端口/环境变量不一致 | `docker logs mylife-finance-mcp` 看实际监听 |
| 删容器后账目没了 | 没挂 `/data` 或挂错路径 | 核对 `volumes` 与 `MYLF_DATA_DIR` 都是 `/data` |

### 3.5 ★ 两份 compose 各起各的，怎么保证互通

典型形态是 Octop 一份 YAML、MCP 一份 YAML，**两份都没写 `networks:`**。这不是写错，是默认行为：compose 会给各自项目建 `<项目名>_default`，项目名由部署时输入的应用名规整而来（下划线/大小写/前缀都不可控），而两个独立 bridge 之间被 `DOCKER-ISOLATION-STAGE` 链阻断；「容器 → 宿主 LAN IP:发布端口」又依赖 userland-proxy（QNAP 常关）。表现就是：**PC 上 curl 得通，Octop 容器里连不上**，服务端计数不增长 —— 这就是 §10.1 那个 TaskGroup 报错的成因。

结论：**别靠默认网络名对齐，要显式声明共享网络。** 三档做法，可靠性从高到低：

**方案 A（推荐）：两个 service 写进同一份 compose。** 同项目 = 同网络 = 名字天然可解析。仓库已备好 `docker-compose.qnap-octop-mcp.yml`，核心三处：

```yaml
services:
  octop:
    networks: [mylife_net]                     # ① 加入共享网络
  mylife-finance-mcp:
    networks:
      mylife_net:
        aliases: [mylife-finance-mcp.internal] # ② 带点别名，专为 Octop URL 校验器（§5.1）
networks:
  mylife_net: { driver: bridge }               # ③ 本文件创建，两边必然同网络
```

连接器 URL 用 `http://mylife-finance-mcp.internal:3458/mcp/<用户名>`。**合并前必做两步**：

1. **原 `volumes` 路径一个字都别改**。原来 bind 挂载 `/share/Container/mylife-finance-mcp:/data` 就还写这个；改成命名卷会挂到空目录，界面变空账本（数据还在旧目录，但你会以为被清空）。Octop 的 `/data/.octop` 同理。
2. **先删掉两个旧「应用程序」再部署合并版**：`container_name` 固定，旧容器占名字会报 `container name "/octop" is already in use`。删应用不删共享文件夹。

**方案 B：必须两份文件 → 固定网络名。**

```bash
docker network create mylife-net        # 只需一次；已存在会报错，忽略
```

两边都追加，都用 `external: true`：

```yaml
# Octop
    networks: [mylife_net]
# MCP
    networks:
      mylife_net:
        aliases: [mylife-finance-mcp.internal]
# 两文件末尾
networks:
  mylife_net:
    external: true
    name: mylife-net
```

⚠️ 顺序：先 `network create` 再 `up`，否则报 `network mylife-net declared as external, but could not be found`。

**方案 C：两边都在跑，不想重建（临时）。**

```bash
docker inspect octop -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}'
docker network connect --alias mylife-finance-mcp.internal <上一步的网络名> mylife-finance-mcp
docker exec octop sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'   # 这条通了才算真通
```

`network connect` 在容器重建后失效，验证通过后回到 A/B 固化。

**判据（在 NAS 的 SSH 里）**：

| 检查 | 期望 |
|---|---|
| `docker inspect octop mylife-finance-mcp -f '{{.Name}} {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'` | 网络列表**有交集** |
| `docker exec octop nslookup mylife-finance-mcp.internal` | 解析到 172.x |
| `docker exec octop sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'` | `{"ok":true,...,"toolCount":43}` |
| 连一个新用户名后再看宿主 `curl /health` 的 `categories` | 每新建一个租户 `+137`；**不增长 = 请求没到** |

只有第 3 行通了，连接器才可能连上。**在宿主上 curl 通不算数。**

**这份 Octop YAML 的其他注意点**：

| 项 | 说明 |
|---|---|
| `OCTOP_DEFAULT_PASSWORD` | 18088 对局域网开放时这是唯一入口凭据，换强密码，首次登录后尽快改 |
| `volumes: /share/Container/octop:/data/.octop` | Octop 全部状态（账号/Agent/技能/连接器）都在这，**别删** |
| `OCTOP_PORT` | 容器内端口，与 `ports` 右侧必须一致 |
| `depends_on` | 只保证启动顺序，**不保证健康**；MCP 冷启动 2–3s，首次探测失败就等 10s 再点 |
| 要不要留 `ports: 3458` | 只给 Octop 用可删；PC 上第二个 WorkBuddy 要直连就保留，**并必须设 `MYLF_HTTP_TOKEN`** |

---

## 4 安装技能

```bash
node scripts/pack-octop-skill.mjs                         # 改过 SKILL.md 后重打
OCTOP_HOME=/data/.octop ./install.sh --agent main --user alice
```

Docker 部署时 `~/.octop` 在容器里：

```bash
docker exec -it <octop容器> sh
unzip -o mylife-finance-skill-1.2.4.zip -d /data/.octop/agents/main/skills/
```

也可在控制台「技能包」页直接上传 `dist/mylife-finance-skill-1.2.4.zip`。落盘结构：`skills/mylife-finance/{SKILL.md,references/tools.md}`。

---

## 5 注册 MCP 连接器（唯一必须手点的一步）

自定义 MCP 存在控制面 `octop.db` 里，官方只暴露 UI、没有稳定写接口，直接改库会在升级迁移时被踩掉。

控制台 → **连接器** → 添加自定义 MCP：

| 字段 | 值 |
|---|---|
| 类型 | Streamable HTTP |
| URL | `http://mylife-finance-mcp.internal:3458/mcp/alice`（**纯容器名会被判成公网地址，见 §5.1**） |
| 请求头 | 仅当设了 `MYLF_HTTP_TOKEN` 才需要 `Authorization: Bearer <令牌>` |

保存后挂到 Agent「main」，并确认技能已启用：`octop skills list --agent main`。
（走 `docker exec` 进容器调 `octop skills` 时，需要服务在运行。）

### 5.1 ★ 填容器名会报「必须使用 HTTPS」

连接器校验器对 `http://` 只放行三类主机：**私网 IP 字面量**（10./172.16-31./192.168./127.）、`localhost`、以 **`.local` / `.internal` / `*.docker.internal`** 结尾的名字。`mylife-finance-mcp` 不属于任何一类，于是报：

> `「mylife-finance-mcp」会被当作公网地址，必须使用 HTTPS。…`

两条路：

- **A. 加 `.internal` 别名（推荐，不增加端口暴露）**：compose 里把 `networks` 从列表改成映射 `aliases: [mylife-finance-mcp.internal]`，`up -d` 重建，URL 写该别名。先验：`docker exec <octop> sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'`。
- **B. 用 NAS 局域网 IP**：`ports: ["3458:3458"]`，URL 写 `http://192.168.x.x:3458/mcp/alice`。⚠️ 端口一旦对局域网开放**必须设 `MYLF_HTTP_TOKEN`**，否则同网段谁都能读写任意账本。

> 别名能解析的前提是两个容器**在同一 docker 网络**。跨网络时先按 §3.5 打通，再回来填 URL。
> 顺带一个坑：URL 里的用户名**区分大小写**，`Admin` 和 `admin` 是两个独立租户，用大写首访会看到空账本（只被播种了 137 个默认分类），容易误判「数据丢了」。

### 5.2 ★ 工作台与看板（浏览器直接打开）

MCP 与工作台**共用 3458**，不用起第二个进程、不用额外端口：

| 地址 | 内容 |
|---|---|
| `/login` | 登录页 |
| `/` | 交互工作台（11 页签 + Excel 导入） |
| `/admin` | 用户管理（仅管理员）：建号、发 token、重置密码、停用 |
| `/account` | 改自己的密码、踢掉其他设备 |
| `/dashboard.html` | **当前登录用户自己的**看板快照（按用户分文件） |
| `/api/*` | 工作台 REST（给脚本/自建页面） |
| `/info` | 服务自述 JSON（需凭据，回显 userId 与角色） |

**登录**：首次启动无账号时自动建管理员，密码在 `/data/ADMIN-PASSWORD.txt`（日志也提示路径）；Cookie `mylf_sid`（`HttpOnly; SameSite=Lax; Max-Age=30天`），未登录页面 302、`/api/*` 401。便利写法 `/?token=<你本人的 MCP token>` —— 校验后换发 Cookie 并从地址栏抹掉，适合做书签。

**`dashboard_build` 的 URL**：工具返回的 `path` 是**容器内路径**，Octop 是另一个容器读不到。要拿到可点击的完整 URL，必须设：

```yaml
    environment:
      MYLF_PUBLIC_BASE_URL: "http://192.168.130.8:3458"   # 你实际访问的地址，带端口、不带结尾斜杠
```

不设则返回 `url: null` + `hint`（有意为之：服务端无从得知浏览器眼里的地址，Octop 请求用的 Host 是只有容器能解析的 `.internal`）。

**安全边界一句话**：身份只来自服务端凭据（`x-user-id`、`?userId=` 一律忽略）；拿到某人的 token 就是那个人；**不做团队内分权**（没有只读成员/共享账本），要分权就一人一个实例；会话 Cookie 走 http，同网段可被嗅探，家庭内网可接受，要更强先上 HTTPS。

**页面速查**（菜单顺序：首页·收支明细·报表·手工记账·应收应付·预算·账户管理·分类管理·项目管理·人员·商家）：

| 页面 | 说明 |
|---|---|
| **首页** | 八张卡片：本年收入/支出/结余 + 累计记账天数 + 累计明细数 + 本月收入/支出/结余。混合趋势图（收支双柱 + 结余折线）；两张饼图（本年/本月支出一级分类）；「本月交易」拆发生账户/目标账户、一级/二级分类 |
| **收支明细** | 年份下拉默认本年（2024–2035）；日期区间控件（双月日历 + 左侧 9 个快捷区间 + 清空/确定），选非整年区间自动清空年份；类型/账户/人员/商家/项目/一二级分类筛选。列表**分页**：默认 20 条/页，可选 20/50/100/200/500/1000，底部有页码、跳页、总条数；合计**两行**——本页合计 + 全部合计（跨页按当前筛选求和）。表头吸顶、列表撑满视口 |
| **报表** | 默认日期=**今年**（重置也回到今年）；一套筛选（类型/日期/账户/成员/商家/项目/说明）出**十张饼图**：收入类型、支出类型，账户/成员/商家/项目**每个维度拆成收入统计与支出统计两张**，口径固定不随「类型」变（类型只过滤数据）。数据 `GET /api/reports/overview` / 工具 `report_overview` |
| **手工记账** | 类型·日期(到秒) → 账户·金额 → 一级·二级分类 → 成员·商家·项目·说明·标签；下拉按使用频次排序（`GET /api/selectors`） |
| **应收应付** | 状态中文：待结清 / 部分结清 / 已结清 / 已逾期 |
| **预算** | 按年月筛选；年/月两级，月预算嵌在年预算下；新增只列一级分类 |
| **账户管理** | 新增可填卡号/备注；**改余额按差额补一笔「余额调整」流水**（上调记其他收入、下调记其他费用），余额恒等于「期初 + 流水」 |
| **分类管理** | 支出/收入左右并排、两级树；**一级分类行带底色、默认折叠**（点箭头展开，展开状态在刷新后保留）；**分类名同类型下全局唯一**，撞名当场拦下并写明挂在谁下面；顶部查重/合并 |
| **项目 / 人员 / 商家** | 各自增删改；商家分类是一级下拉，颜色用取色器 |

> 「撑满底部」按视口算（`calc(100vh - 148px)`，表头吸顶）；窄于 860px 退化为 `max-height:60vh`，避免挤掉按钮。

---

## 6 多用户隔离（重点）

**两条腿：URL 里的用户名（分区）+ 凭据归属（授权）。** 只靠 URL 不够 —— 1.1.1 及以前 token 全局唯一，改名就能读写别人的账。

```
alice 的 token 打 /mcp/bob   → 403
alice 的 token 打 /mcp/alice → 200
```

### 6.1 三类凭据，各自绑定一个人

| 凭据 | 用在哪 | 绑定 |
|---|---|---|
| 会话 Cookie `mylf_sid` | 浏览器工作台 | HMAC 签名，payload 含 userId，改密即失效 |
| 每用户 MCP token | Octop 连接器 / curl | sha256 存库，与唯一 userId 绑定 |
| 旧版 `MYLF_HTTP_TOKEN` | 从 1.1.1 平滑升级 | 只代表 `MYLF_HTTP_TOKEN_USER`（默认 `admin`）一人 |

**任何客户端自称的身份都不算数**：`x-user-id`、`?userId=` 被完全忽略。

### 6.2 账号从哪来

首次启动（`users.json` 为空）自动建管理员：用户名 `MYLF_ADMIN_USER`（默认 `admin`），密码 `MYLF_ADMIN_PASSWORD`（不设则随机，写 `/data/ADMIN-PASSWORD.txt`），并标记**待改密** —— 登录后强制跳 `/account`，改完才能用。这一步是硬的：否则卷里那份初始密码就等于长期凭据（File Station 能直接看到）。

```
登录 /login → 右上角「用户管理」(/admin)
  → 新增用户：用户名（= 租户 ID，与连接器 URL 同名）、备注、初始密码、角色
  → 创建成功时**只显示一次**该用户的 MCP token，复制走填进连接器
```

| 路径 | 谁能进 | 作用 |
|---|---|---|
| `/` | 已登录 | 记账工作台（只看自己的） |
| `/account` | 已登录 | 改密、让其他设备下线 |
| `/admin` | 仅管理员 | 用户列表（最近登录/token 使用）、建号、重置、轮换 token、停用、删除、操作记录 |
| `/api/admin/audit` | 仅管理员 | 最近 50 条审计事件 |
| `/logout` | 已登录 | 退出并清 Cookie |

### 6.3 权限矩阵

| 操作 | 成员 | 管理员 |
|---|---|---|
| 看/写自己的账本 | ✅ | ✅ |
| 看别人的账本（改 URL 名字） | ❌ 403 | ❌ 403 |
| `/admin` 与 `/api/admin/*` | ❌ 403 | ✅ |
| 停用/删除用户、重置密码、轮换 token | ❌ | ✅ |
| 停用或删除**最后一个管理员** | — | ❌ 400（防止把自己锁在门外） |

> **管理员不等于能看别人账本。** 管账号不代看数据 —— 「能重置你的密码」已经等于能进来，没必要再开隐式越权口子。

### 6.4 从 1.1.1 升级（现网必看）

1.1.1 只有 `MYLF_HTTP_TOKEN` 一个串，URL 里可能还写着大写 `Admin`。升级后会 403，因为 token 现在只属于一个用户。

```yaml
# 方案 1（推荐）：一次迁移到位
MYLF_HTTP_TOKEN: "旧的全局令牌"
MYLF_HTTP_TOKEN_USER: "Admin"      # 必须与 Octop URL 里那段完全一致（大小写敏感）
# 然后登录 /login → 用户管理 → 给每人建号 → 换成本人 token → 删掉上面两个变量 → 重启
```

方案 2：直接建一个用户名恰为 `Admin` 的账号，用它的 token，URL 不用改。
⚠️ `Admin` 和 `admin` 是两个独立租户、两套数据，建错会看到空账本（只有 137 默认分类）。

### 6.5 命令行管用户（不开浏览器）

```bash
docker exec mylife-finance-mcp node src/cli.js list
docker exec mylife-finance-mcp node src/cli.js add alice --label 老婆
docker exec mylife-finance-mcp node src/cli.js passwd alice
docker exec mylife-finance-mcp node src/cli.js token alice         # 轮换并打印新值
docker exec mylife-finance-mcp node src/cli.js disable alice
docker exec mylife-finance-mcp node src/cli.js del alice           # 只删账号，账本保留
docker exec mylife-finance-mcp node src/cli.js del alice --purge   # 连账本一起删（不可恢复）
```

`add` / `passwd` 不给 `--password` 会随机生成可读密码并标记待改密；`list` 显示最近登录与「已删除但数据仍在」清单。**改这些不用重启**（`/data/users.json` 每次请求现读）。

### 6.6 其他隔离细节

| 项 | 行为 |
|---|---|
| `user_create` | 从 HTTP 工具列表移除，调用报错（账号只能由管理员建） |
| `user_list` | 只返回自己 |
| 新租户 | 首次访问自动建租户并播种 **137 个默认分类**（18 顶级 + 119 二级；支出 109 / 收入 28）；不想自动开通设 `MYLF_HTTP_AUTO_TENANT=0` |
| `categories` 计数 | 是**全库行数**（所有用户相加）：只有 `default` 时 137，进过 3 人就是 411 |
| 用户名 | 字母、数字、`.`、`_`、`-` 和中文，1–64 位；中文需 URL 编码，建议用拼音或工号 |

### 6.7 「URL 绑 user + token」够不够？

**URL 里的用户名不是授权依据，token 才是。** 服务端用 sha256 反查 token 归属，URL 段随后只做一件事：跟 token 归属比对，不一致 403。

| 你做的事 | 结果 |
|---|---|
| 改 URL 名字（token 不变） | 403 |
| 换 token（URL 不变） | 403 |
| 只有 URL、没有 token | 401 |
| 拿到某人的 token | 就是那个人本人 —— 设计如此 |

所以 URL 段的全部价值是**防手滑**（防止把 alice 的连接器指向 bob 的地址后静默写错账本）。三个前提缺一档就掉一档强度：

1. **token 放 Header，别放 URL**。`?token=` 服务端也认（首登换 Cookie 用），但完整 URL 会进 Octop 日志、反代 access log、浏览器历史与 Referer。
2. **一人一把 token**（默认如此，创建/轮换只显示一次明文）。
3. **清楚明文 HTTP 是天花板**：同网段抓包就能冒充。只给 Octop 用 → 走 `.internal` 别名、不发布 3458，边界就是 docker 网络；要给手机/别的电脑用 → 必须套 HTTPS（`mylife-https` 的 8443 → 3458），并设 `MYLF_COOKIE_SECURE=1`。

**结论**：够用，但它买到的是「**吊销粒度到人**」，不是「抗攻击」。出事处理路径：停用账号（会话 + token 同时失效）→ 轮换 token → 改密（所有会话掉线），都在工作台里点得到。

### 6.8 删用户：账本还在，名字不能随便复用

删账号**不等于**删账本：`users.json` 删一条，SQLite 里该 `user_id` 的数据还在。若允许同名直接重建，新账号首访会被 `ensureTenant` 认成老租户，**直接看到前一个人的全部账单**（这是修掉过的真实串号风险）。

1. `DELETE /api/admin/users/<id>` 不带 `purge` 直接 400，并回传「名下有多少条数据」。`?purge=0` 只删账号、留墓碑；`?purge=1` 事务清空该租户全部业务表再删租户行，之后可重建同名。
2. 有墓碑的名字重建会被拒，除非显式「接管旧账本」（管理页勾选框 / `cli.js add --reclaim`）。
3. 删账号时其看板文件一并清理。

> 判断标准：**同一个人的新账号 → 接管；换了人 → 换名字。** 用同一个名字给两个人，是唯一能真正串号的路径。

### 6.9 审计与使用痕迹

| 文件 | 内容 |
|---|---|
| `/data/audit.log` | NDJSON，超 1MB 滚动到 `.1`（只留一代） |
| `/data/usage.json` | 每人的 `lastLoginAt` / `lastTokenAt` / `lastIp` |

覆盖：登录成功/失败/限速、`?token=` 换登录、退出、改密、下线其他设备、建号/删号/停用/重置/轮换 token、非管理员访问、MCP 越权 403 与无效 token 401。**不记密码与 token 明文**（键名命中 `pass|pwd|token|secret|cookie|authorization` 一律打码，测试有断言守着）。

使用痕迹单独存 `usage.json` 不挤进 `users.json`：token 每次调用都算一次使用，混进凭据文件的 read-modify-write 会放大并发写丢数据的面，一次坏写还可能连带弄坏密码哈希。

查看：管理页底部「最近操作记录」（最近 50 条），或 `docker exec mylife-finance-mcp tail -n 20 /data/audit.log`。

### 6.10 防什么、不防什么

- **防**：同网段陌生人（走内网别名或套 HTTPS 时）、内部人误改 URL 串账本、拿到别人连接器 URL 但没有 token 的人、离职后还想用旧 token 的人（停用即失效）。
- **不防**：拿到某人 token 的人（token 就是那个人的身份）、明文 HTTP 抓包、服务器 root（能直接读 `/data/finance.db` 与 `/data/session.key`）。
- **不做内部分权**：没有只读成员/共享账本。要分权给每人一个实例（各自数据目录与端口）。

---

## 7 单机自用（stdio）

```json
{ "command": "node", "args": ["C:/zzytest/mylife-finance-skill/server.js"] }
```

控制台添加自定义 MCP 时选 stdio，填上面两项。`userId` 恒为 `default`，用 `~/.mylife-finance/finance.db`。

| | stdio | Streamable HTTP |
|---|---|---|
| 适用 | Octop 与 Node 同机 | Docker / 远程 / 多人 |
| 用户隔离 | 弱（单用户） | 强（URL 承载 + 凭据归属） |
| 前置 | 本机 Node ≥ 22.13 | 只需 Docker |

> ⚠️ stdio 吃的是 Octop 所在机器的 Node。只有 Node 20 会立刻崩在 `require('node:sqlite')`。两条出路：改用 §3 容器方案，或把本机 Node 升到 22.13+ / 24.x。

---

## 8 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MYLF_HTTP_PORT` | `3458` | 监听端口（MCP + 工作台共用） |
| `MYLF_HTTP_HOST` | `0.0.0.0` | 监听地址；容器内必须 `0.0.0.0` |
| `MYLF_DATA_DIR` | `~/.mylife-finance` | 数据目录；容器里 `/data`。账号 `/data/users.json`，会话密钥 `/data/session.key` |
| `MYLF_ADMIN_USER` | `admin` | 首次启动创建的管理员（仅 `users.json` 为空时生效） |
| `MYLF_ADMIN_PASSWORD` | 随机 | 不设则随机生成并写 `/data/ADMIN-PASSWORD.txt` |
| `MYLF_SESSION_SECRET` | 自动生成 | 不设则生成到 `/data/session.key`。**备份时要一起带走**，否则所有人需重新登录 |
| `MYLF_COOKIE_SECURE` | 空 | `1` = Cookie 加 `Secure`。**只有前置 HTTPS 才设**；明文下设了浏览器不收货，表现为「登录成功但一刷新又回登录页」 |
| `MYLF_HTTP_TOKEN` | 空 | 旧版全局令牌，只代表 `MYLF_HTTP_TOKEN_USER`。新部署别用（§6.4） |
| `MYLF_HTTP_TOKEN_USER` | `admin` | 旧令牌绑定的用户名（大小写敏感） |
| `MYLF_HTTP_AUTO_TENANT` | `1` | `0` 关闭新用户自动开通租户 |
| `MYLF_PUBLIC_BASE_URL` | 空 | 对外基址（如 `http://192.168.130.8:3458`）。设了 `dashboard_build` 才返回可点击 URL |
| `MYLF_WB_PORT` / `MYLF_WB_USER` | `3457` / `default` | 仅本地 `workbench.js` 用，容器里不需要 |

---

## 9 备份与迁移

```bash
# 备份
docker run --rm -v mylife-finance-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/finance-$(date +%F).tar.gz -C /data finance.db

# 恢复
docker run --rm -v mylife-finance-data:/data -v "$PWD":/backup alpine \
  sh -c "tar xzf /backup/finance-YYYY-MM-DD.tar.gz -C /data"
```

WAL 已开，热备建议先停容器，或用 `sqlite3 finance.db ".backup /data/bak.db"`。**别忘了 `users.json` / `session.key` / `usage.json`**（搬家换机时尤其重要）。

---

## 10 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| Octop 工具列表为空 | MCP URL 不通 | `docker exec <octop> wget -qO- http://mylife-finance-mcp:3458/health` |
| 连接超时 | 两容器不同 network | 按 §3.5 打通，或写进同一份 compose |
| 401 | 没带凭据或格式不对（**必须 `Bearer ` 带空格**） | `Authorization: Bearer <token>`；工作台去 `/login` |
| **403：凭据属于「a」不能访问 /mcp/b** | 拿 A 的 token 打 B 的名字（正常拦截） | 让 URL 与 token 同属一人 |
| 403 但确认同名 | 大小写不一致 | `/admin` 核对拼写，或设 `MYLF_HTTP_TOKEN_USER` |
| 登录说用户名或密码不对 | 随机密码没找到 | `/data/ADMIN-PASSWORD.txt` 或 `docker logs` 开头 |
| 忘记管理员密码 | 无法自助找回 | `docker exec ... node src/cli.js passwd admin` |
| 登录后立刻跳回 `/login` | `/data` 不可写导致 `session.key` 生成失败，或每次重启换密钥 | 检查挂载与权限；把 `session.key` 纳入备份 |
| 工作台只能看自己那份 | **设计如此** | 要看别人的账本请用那个人登录 |
| 新用户看到空账本 | 新建的是新租户（137 默认分类） | 历史数据不会自动搬家，见 §13 |
| `unhandled errors in a TaskGroup` | Octop 侧 Python 客户端崩了，真因藏在 sub-exception | 按 §10.1 三步定位，九成是 Header 或网络 |
| 400 非法 userId | URL 里有 `/`、空格或超长 | 用 `alice`、`u001` 这类简单标识 |
| 技能不生效 | 未启用或 Agent 用错 | `octop skills list --agent <id>` |
| 分类树是空的 | 关了自动开通且用户不存在 | 去掉 `MYLF_HTTP_AUTO_TENANT=0`，或先建用户 |
| 容器起不来，日志报 Node 版本 | 基础镜像太旧 | 换 `node:22-alpine` 最新（≥22.13） |
| `dashboard_build` 路径打不开 | 返回的是容器内路径 | 设 `MYLF_PUBLIC_BASE_URL`，或浏览器开 `/dashboard.html` |

### 10.1 `unhandled errors in a TaskGroup (1 sub-exception)` 怎么查

这句来自 Python 3.11+ 的 `asyncio.TaskGroup`：任一子任务抛异常，外层就统一抛这句，真因在 `sub-exception` 里，而 Octop 没展开 —— **它本身不含任何诊断信息**。

```bash
# ① 容器活着、端口真的发布了
docker ps --filter name=mylife-finance-mcp --format '{{.Status}}  {{.Ports}}'
# ② 从 Octop 容器内部能否连通（/health 不需要 token）
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
| `200` + `Mcp-Session-Id:` | 服务端完全正常，锅在 Octop 侧 | 看 Octop 后端日志里的 sub-exception 真身 |
| `401`（纯文本） | Header 不对（正则 `^Bearer\s+(.+)$`） | 补成 `Authorization: Bearer <token>` |
| `405` | 路径对但方法错；本实现不提供 SSE 推送 | Transport 选 `streamable_http`，探测用 POST |
| `404` | 路径不是 `/mcp/<userId>` | 补全 |
| 连接被拒/超时 | 网络层 | 确认 IP 是宿主局域网 IP（不是 docker 网桥）、端口已发布、防火墙放行 |

> ★ `/health` **不需要** token，`/mcp/*` **需要**。所以「`/health` 通、连接器报错」几乎一定是 token 头写法问题，不用怀疑网络。

**★ 同机不同 docker 网络（QNAP/群晖最常见）**：两个容器在同一台 NAS，但 IP 分属不同网段（如 `172.29.0.2` 与 `172.29.4.2`）⇒ 跨桥被 `DOCKER-ISOLATION` 阻断；容器 → 宿主 LAN IP 的发布端口又依赖 userland-proxy（QNAP 常关）。表现：PC 能 curl `/health`，Octop 容器不能，报的仍是那句无信息量的 TaskGroup 错误。

**旁证判据**：`/health` 里的 `categories` 是全库分类行数，每成功连一个**新** userId 就 +137。反复探测某用户名后它**一直不变**，说明请求压根没到服务端 —— 网络问题，别再查 token。

**解法**：把 MCP 接进 Octop 的网络（不必发布端口）：

```bash
docker inspect <octop容器> -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'
docker network connect --alias mylife-finance-mcp.internal <网络名> mylife-finance-mcp
docker exec <octop容器> sh -c 'wget -qO- http://mylife-finance-mcp.internal:3458/health'
```

连接器 URL 改成 `http://mylife-finance-mcp.internal:3458/mcp/<用户名>`。若别名解析不到，退回用 MCP 在该网络上的 IP（也是私网 IP，能过校验器），缺点是容器重建后 IP 会变。`network connect` 是临时的，**治本见 §3.5**（同一份 compose，或固定网络名 + `external: true`）。

---

## 11 已知边界（诚实说明）

1. **MCP 必须手点注册**，无稳定接口。
2. **`dashboard_build` 生成的是容器内文件**：可通过 `/dashboard.html` 在浏览器打开（设了 `MYLF_PUBLIC_BASE_URL` 时工具直接返回 URL），但 Octop 对话里无法内联渲染这张图；要数字用 `report_monthly` / `report_by_category` / `report_budget`。
3. **`import_from_mylife` 容器内默认无效**：要把 MyLifeOS 的 `mylife-os.db` 挂进容器并传 `dbPath`。
4. **`workbench.js` 未容器化**：它是给人点着用的，容器里用 `server-http.js` 挂在同一端口上的工作台。
5. **未做 MCP 会话校验**：`initialize` 下发 `Mcp-Session-Id` 但不强制校验（兼容未回带的客户端）。内网可接受；暴露公网请加 `MYLF_HTTP_TOKEN` 并前置 TLS。
6. **镜像未在真实 Docker 上 `docker load` 过**（开发机无 Docker 引擎）。已做的验证见 §14.3，首次加载请留意输出。

---

## 12 第二个客户端接入（局域网别的 WorkBuddy / 手机）

**能，而且共用同一本账。** MCP 是无状态 HTTP，账本只有服务端一份；客户端数量不影响一致性。实测两个独立进程交替并发写 30 次 0 失败、读数一致，`journal_mode=wal`、`busy_timeout=5000`。

1. compose 端口改成 `"3458:3458"`（默认 `127.0.0.1:3458:3458` 只给宿主机）；
2. **同时设 `MYLF_HTTP_TOKEN`**，否则同网段谁都能读写任意账本；
3. 另一台机器验证：

```bash
curl -s http://<主机IP>:3458/health
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://<主机IP>:3458/mcp/zhang \
  -H "Authorization: Bearer 你的令牌" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

客户端（WorkBuddy「连接器 → 自定义连接器 → 配置 MCP」）：

```json
{ "mcpServers": { "mylife-finance": {
  "type": "streamableHttp",
  "url": "http://192.168.1.20:3458/mcp/zhang",
  "headers": { "Authorization": "Bearer 你的令牌" }
} } }
```

| 项 | 说明 |
|---|---|
| `type` | 必须**驼峰** `streamableHttp`；全小写客户端不识别，静默加载失败 |
| `url` 末段 | 决定看哪本账：同名=同一本，换名=新建空账 |
| `headers` | 必须是**该用户自己的 token**；拿 A 的配 `zhang` 会 403 |
| 保存后 | 还要在连接器列表**手动启用**，否则工具不加载 |
| 技能层 | 另需把 `dist/mylife-finance-skill-1.2.4.zip` 解到该机 `~/.workbuddy/skills/mylife-finance/` |

客户端强制 URL 以 `/mcp` 结尾时用查询参数形式：`http://192.168.1.20:3458/mcp?user=zhang`（已实测等价）。

**两套不要混**：本机 WorkBuddy 用 `%USERPROFILE%\.mylife-finance\finance.db`，服务器用 `/data/finance.db`，**互不相通**。别做「本地记一笔、服务器记一笔」的双写，两套库不会自动合并。

---

## 13 把本机账本搬到服务器

本机库 `C:\Users\<你>\.mylife-finance\finance.db`，数据在 `default` 名下。

```bash
# 1) 先停本机 MCP/工作台与容器，避免拷到写一半的状态
# 2) 用 SQLite 备份接口导出（自动合并 WAL）
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/Users/zhouz/.mylife-finance/finance.db');d.exec(\"VACUUM INTO 'C:/zzytest/finance-export.db'\");d.close()"
# 3) 传上去
scp C:/zzytest/finance-export.db user@<主机>:/tmp/finance.db
# 4) 灌进数据卷
docker run --rm -v mylife-finance-data:/data -v /tmp:/src alpine \
  sh -c "cp /src/finance.db /data/finance.db && chown 0:0 /data/finance.db"
# 5) 重启验证
docker restart mylife-finance-mcp && curl -s http://127.0.0.1:3458/health
```

**用户名怎么对**：最省事是连接器直接用 `/mcp/default`，数据原样可见；想用有意义的名字就改库（`users` + 8 张业务表，共 9 条 `UPDATE ... SET user_id=...`，单事务提交）。

搬完自查：别再想 `curl -H 'x-user-id: ...'`（已失效）。用该用户 token 调一次 `report_monthly` 看笔数是否与迁移前一致，或登录工作台看首页汇总。

---

## 14 没有 Docker 的机器上产出镜像文件

改代码的机器没装 Docker（或引擎起不来），要在有 Docker 的服务器/NAS 上直接导入。做法是**自己组装镜像归档**：从 registry 拉官方 `node:22-alpine` 的层（内容不改一个字节），把应用文件打成新的一层，按目标格式封装成 tar。

```bash
node scripts/build-image-tar.mjs --gzip                  # → dist/*.tar + *.tar.gz
node scripts/build-image-tar.mjs --registry https://docker.1ms.run   # 换源
node scripts/build-image-tar.mjs --tag mylife-finance-mcp:1.2.4 --platform linux/amd64
node scripts/build-image-tar.mjs --format oci            # containerd / podman 用
```

脚本按 **Registry v2 标准鉴权**：先请求，遇 401 按 `WWW-Authenticate` 的 realm 换 token 重试，官方源/国内加速/匿名代理都能用。默认源 `docker.m.daocloud.io`（1.2.2 前默认的 `dockerproxy.net` 已不可达），备选 `https://docker.1ms.run`。

### 14.0 两种归档格式别搞混（「导入格式不正确」的头号原因）

| | **docker（默认）** | oci（`--format oci`） |
|---|---|---|
| 根目录 | `manifest.json` + `<cfg-sha>.json` + `<layer-id>/layer.tar` + `repositories` | `oci-layout` + `index.json` + `blobs/sha256/*` |
| 层 | 未压缩 `layer.tar` | gzip 裸 blob |
| 谁认 | `docker save` 同款：Docker 20.10–27、Container Station、群晖、`docker load` | 仅 containerd / podman |
| 谁不认 | —— | **Docker ≤24 的 `docker load`**、**QNAP Container Station**、多数 NAS 图形界面 |

早期产物是 OCI 布局，QNAP 导入会直接判「docker 格式不正确」—— 不是文件坏了，是布局不对。

### 14.1 在目标机器上加载

**A. 有 SSH 的 Linux / NAS（最稳）**

```bash
scp dist/mylife-finance-mcp_1.2.4-linux-amd64.tar.gz user@server:/tmp/
docker load -i /tmp/mylife-finance-mcp_1.2.4-linux-amd64.tar.gz   # 期望 Loaded image: mylife-finance-mcp:1.2.4
docker image inspect mylife-finance-mcp:1.2.4 --format '{{.Os}}/{{.Architecture}} {{.Config.Entrypoint}}'
# 期望 linux/amd64 [/usr/local/bin/docker-entrypoint.sh]
docker run -d --name mylife-finance-mcp -p 3458:3458 -v mylife-finance-data:/data \
  -e MYLF_PUBLIC_BASE_URL=http://192.168.130.8:3458 \
  --restart unless-stopped mylife-finance-mcp:1.2.4
curl -s http://127.0.0.1:3458/health
```

**B. QNAP Container Station**：① SSH 里 `uname -m` 确认架构（`x86_64` 用 amd64 包；`aarch64` 需 `--platform linux/arm64` 重新生成）；②「映像 → 导入」选 `.tar`/`.tar.gz`；③ 列表出现 `mylife-finance-mcp:1.2.4`；④ 新建容器：端口 3458→3458、挂载到 `/data`、命令与入口**留空**、勾选自动重启；⑤ `curl http://<NAS_IP>:3458/health`。

> Container Station 仍报格式问题，说明它这版只认 `.tar`：改用 SSH + `docker load -i`（需先在「控制台 → 网络和文件服务」开 SSH）。接 Octop：`http://<NAS_IP>:3458/mcp/<userId>`，其余同 §5。

### 14.2 归档里有什么

| 内容 | 说明 |
|---|---|
| 4 个基础层 | 官方 `node:22-alpine` 原样搬运（sha256 与 registry 一致），落盘时解压成未压缩 `layer.tar` |
| 1 个应用层 | `app/{package.json,server.js,server-http.js,src/**}` + `/usr/local/bin/docker-entrypoint.sh`(0755) + `/data` |
| config | 继承基础 Env，追加 `NODE_ENV/MYLF_DATA_DIR/MYLF_HTTP_PORT/MYLF_HTTP_HOST`；`WorkingDir=/app`、`Entrypoint=docker-entrypoint.sh`、`Cmd=node --no-warnings server-http.js`、暴露 3458、卷 `/data`、healthcheck 同 Dockerfile |
| manifest.json | `RepoTags` 决定 load 后的镜像名；`Layers` 顺序即 diff_ids 顺序 |
| repositories | tag → 顶层 layer id，老工具（含部分 NAS）会读 |

体积从 58.7 MB 变 163.5 MB 是正常的：docker 格式要求 `layer.tar` 未压缩（`node:22-alpine` 解压后主要是 149 MB 的 Node 运行时层）。嫌大就用 `.tar.gz`。

脚本自带结构校验（任一不符 `exit 1`）：`manifest.json` 存在且 `RepoTags` 含目标 tag、层路径必须 `<64位id>/layer.tar`、每层带 `VERSION=1.0`、每层 sha256 **逐层等于** `config.rootfs.diff_ids[i]`、首两字节不得是 gzip、`repositories` 指向顶层、不得残留 `blobs/`/`index.json`/`oci-layout`、入口 mode=755 且 `app/server-http.js` 在场。

### 14.3 兼容性与边界

- **架构必须匹配**：产物只含单一架构（默认 amd64）。ARM 设备（ARM 版群晖/威联通、Oracle 免费机、M 系列 Mac）需 `--platform linux/arm64` 重新生成。
- **目标机必须是 Linux 容器模式**：Windows 切到 Windows containers 会报 `cannot load linux image on windows`。
- **镜像内容**：不含 `workbench.js`（只跑 MCP）、`scripts/`、`docs/`、`fixtures/`。
- **不含签名 / SBOM**，内部使用范畴。
- **已做的验证（1.2.4）**：① 脚本结构校验（应用层 21 文件 + 7 目录、5 层 `diff_id` 逐层匹配、入口 755、无 gzip 层）；② 独立复核脚本从归档解出应用层，与工作区 **21 个文件逐字节 sha256 一致**（19 项检查全过）—— 证明包里的就是测过的代码；③ 把应用层解到磁盘直接 `node server-http.js`，跑 **215 项**测试全通过（`test-auth` 46 + `test-webapp-http` 31 + `test-accounts-v2` 42 + `e2e-octop-mcp` 27 + `test-workbench-v2` 69），覆盖登录、越权 403、强制改密、删号与同名重建、审计、按用户看板、MCP 握手与 **43 工具清单**、余额调整三路径、年份/分类筛选、**明细分页（page/pageSize/total/pages/sum）**、报表六维聚合、`categoryParent` 上卷、分类同名 11 条；④ `.tar.gz` 的 gzip 头与 ISIZE 校验。**首次 `docker load` 请留意输出**，报错把原文发我。
- **老库（1.2.1 及更早）升级的分类唯一索引**：库里已有同名不同父级分类时，启动只提示并跳过建索引（不崩、不影响使用），新增仍由应用层拦截；「分类管理 → 扫描重复」合并后重启即自动补上。该路径实机验证过（造 2 条历史重名 → 启动 → 拦截 → 合并 → 重启 → 索引生效）。

复核搬运是否出错：

```bash
node scripts/verify-image-archive.mjs      # 默认查 dist/ 下当前版本的 tar
```

不依赖 Docker，做四件事：确认是合法 Docker Archive；config 的版本标签/Entrypoint/Cmd/端口/卷与仓库一致；**应用层逐文件与工作区源码 sha256 双向比对**（不多、不少、不改）；解到临时目录并打印实跑命令。

### 14.4 产物清单与校验值

`dist/` 现保留 1.2.2 / 1.2.3 / 1.2.4 各三件，合计 **666 MB**（1.1.x、1.2.0、1.2.1 已清理）：

| 版本 | 产物 | 大小 | sha256 |
|---|---|---|---|
| **1.2.4** | `.tar` | 163.5 MB | `d1cdd7f4e2ecc590a7a80af2d2286fede722549b10b52d085b2d855bf2ec42a0` |
| **1.2.4** | `.tar.gz` | 58.5 MB | `016e446f657f0ff83294c56f64d5a405ba997c55a29d44dc5d85b771bffa749c` |
| **1.2.4** | 技能 zip | 7.3 KB | `bcfaf3ef9ea60320b3b70ced42f89053dd813d7f891d51fcacc0afd8b5235d9b` |
| 1.2.3 | `.tar` | 163.5 MB | `0b0545bf7ddb4d6be732ffb6142939d8c12c0a491bdc7df11b9554a20c43e3ca` |
| 1.2.3 | `.tar.gz` | 58.5 MB | `761f5fd1d4342867eb3545888a3e715876c2a4f879d335ffb3d3faa5c574bb17` |
| 1.2.3 | 技能 zip | 7.2 KB | `2a3896c618f9a1ae358efc06755e8d75442389ad51de25d7f5250d1de9a3e95c` |
| 1.2.2 | `.tar` | 163.5 MB | `3177e4a62a64926966fbfae7cc312b04b33753a5b53f774dcac7a7a68e69bc6e` |
| 1.2.2 | `.tar.gz` | 58.4 MB | `e578f4bc09a86bb65011a92e63ecc75252e8a73108d5b45dece2cc35bfbf7c12` |
| 1.2.2 | 技能 zip | 7.1 KB | `0e39fdb68e13dbc80b7c5b8d1d805d1fe3a2f235ff7a195a264fa0095dbbb1f7` |

搬运后复核：`sha256sum <文件>`，与本表对照。回滚就是 `docker load` 旧版 tar 后重建容器，**`/data` 不用动**（1.2.x 的库结构只增不破，旧版本会忽略新列）。唯一例外：1.2.2 建的分类唯一索引还在时，更早版本（1.2.0 / 1.2.1，没有应用层拦截）的「重复新增同名分类」会直接报 UNIQUE 错误，降级前请先备份并知悉这一点。
