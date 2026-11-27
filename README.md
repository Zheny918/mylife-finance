# MyLife 财务记账技能（mylife-finance-skill）

把 MyLifeOS 的记账能力抽成**独立可复用技能**：一套零依赖 MCP Server（stdio + Streamable HTTP）加一个零依赖的图形工作台。WorkBuddy 里对话记账、Octop / Docker 里多人共用，底层是同一份代码、同一个 SQLite 库。

> 当前 **v1.2.4** · Node **≥ 22.13** · **零 npm 依赖** · 工具 **44 个**（HTTP 模式下 43 个，`user_create` 被移除）

## 1 架构

```
自然语言（WorkBuddy / Octop）
   │
SKILL.md  —— 只放领域知识与工作流，不含实现
   │
Finance MCP Server —— Node 内置 node:sqlite，零依赖、零安装
   ├─ server.js       stdio（WorkBuddy、单机 Octop）
   └─ server-http.js  Streamable HTTP（Docker / 远程 / 多人，URL 承载 userId）
        │ 同一套 src/tools.js + src/db.js
   工作台 /login → /（与 MCP 同端口；REST /api/*；身份只来自服务端会话）
        │
   /data/finance.db —— 按 user_id 隔离
```

三条要点：

- **零依赖**：只用内置 `node:sqlite`（**Node ≥ 22.13**，Node 20 没有该模块），手写 MCP 协议与 HTTP 服务；Chart.js 已本地内联，离线可用。Docker 部署时宿主机装什么 Node 都无所谓（镜像自带 22）。
- **多用户隔离**：所有业务表带 `user_id`。HTTP 模式下 `userId` 由 URL 承载并**强制覆盖**工具参数，同时校验凭据归属 —— 拿 A 的 token 打 `/mcp/B` 直接 403；客户端传 `x-user-id` 已彻底失效。
- **与 MyLifeOS 解耦**：日常靠 Excel/CSV 导入；`import_from_mylife` 只作可选的一次性迁移（单向只读，绝不写回）。

## 2 快速开始

| 场景 | 入口 | 前置 |
|---|---|---|
| AI 对话记账（本机） | WorkBuddy 技能 + stdio MCP | 本机 Node ≥ 22.13 |
| 图形界面手工维护（本机） | `node workbench.js` → `127.0.0.1:3457` | 同上 |
| 多人 / 远程 / NAS | Docker 镜像，`:3458` | 只需 Docker |
| 局域网第二个客户端 | 指向同一 `:3458` | 端口开放 + token |

### 2.1 WorkBuddy（对话记账）

MCP 已写入 `~/.workbuddy/mcp.json`（`mylife-finance` → `node --no-warnings server.js`），技能已放到 `~/.workbuddy/skills/mylife-finance/SKILL.md`。**还差一步**：在「连接器 / 自定义 MCP」里找到 `mylife-finance` 点「信任」。

之后直接说：「记一笔餐饮 88 元，用招行卡」/「这个月花了多少」/「把 MyLifeOS 历史账导进来」。

### 2.2 本地工作台（免登录，单机）

```bash
cd C:/zzytest/mylife-finance-skill
node workbench.js          # → http://127.0.0.1:3457
```

只绑回环地址，身份固定为 `MYLF_WB_USER`（默认 `default`）。**对外提供服务请用 `server-http.js`**。

### 2.3 Docker / Octop（多人共用）

```bash
node scripts/docker-build-verify.mjs          # 构建 + 7 组全量验收，全过才返回 0
# 或手工：OCTOP_NETWORK=octop_default docker compose -f docker-compose.mylife-finance.yml up -d --build
curl -s http://127.0.0.1:3458/health           # {"ok":true,...,"toolCount":43,"categories":137}
```

打开 `http://<主机>:3458/` 会跳 `/login`；首次启动自动建管理员，初始密码在 `/data/ADMIN-PASSWORD.txt`（登录后强制改密）。右上角「用户管理」建账号、发 token。

只有镜像、没有源码（QNAP / 群晖 / 任意 Linux）用 `docker-compose.standalone.yml`。**网络互通、连接器 URL、权限模型、故障排查全部在 [docs/OCTOP-DEPLOY.md](docs/OCTOP-DEPLOY.md)**。

### 2.4 局域网里的第二个客户端

MCP 是**无状态 HTTP**，账本只有服务端一份 —— 多个客户端连同一地址就是**共用同一本账**，不需要同步库。两处要改：

1. compose 的 `ports` 改成 `"3458:3458"`（默认 `127.0.0.1:3458:3458` 只给宿主机）；
2. **必须同时设 `MYLF_HTTP_TOKEN`** —— URL 里的用户名只是分区名、不是凭据。

```json
{ "mcpServers": { "mylife-finance": {
  "type": "streamableHttp",
  "url": "http://<主机IP>:3458/mcp/zhang",
  "headers": { "Authorization": "Bearer <令牌>" }
} } }
```

`type` 必须写驼峰 `streamableHttp`；URL 末段的用户名决定看哪本账。客户端强制 `/mcp` 结尾时用 `http://<IP>:3458/mcp?user=zhang`（等价）。

## 3 工作台：11 个页签

菜单顺序：**首页 · 收支明细 · 报表 · 手工记账 · 应收应付 · 预算 · 账户管理 · 分类管理 · 项目管理 · 人员 · 商家**。

| 页签 | 要点 |
|---|---|
| **首页** | 八张卡片：本年收入/支出/结余、**累计记账天数**、**累计记账明细数**、本月收入/支出/结余。趋势图是**混合图**（每月收支双柱 + 结余折线）；两张饼图（本年/本月支出一级分类）；「本月交易」表把账户拆成**发生账户/目标账户**、分类拆成**一级/二级** |
| **收支明细** | 年份下拉**默认本年**（2024–2035），与日期区间是同一件事的两种表达；区间控件=双月日历+快捷区间+清空/确定；另有类型、账户、人员、商家、项目、一/二级分类筛选。列表**分页**（默认 20 条/页，可选 20/50/100/200/500/1000），底部有页码/跳页/总数；合计分**两行**：本页合计 + 全部合计（跨页按当前筛选求和）。列表撑满视口、表头吸顶 |
| **报表** | 默认日期=**今年**（重置也回到今年）；一套筛选（类型/日期/账户/成员/商家/项目/说明）出**十张饼图**：收入类型、支出类型，以及**账户 / 成员 / 商家 / 项目各拆成「收入统计」「支出统计」两张**。每张图口径固定（收入图只取收入、支出图只取支出），「类型」只负责过滤数据；转账不计入，分类按一级归并 |
| **手工记账** | 布局：类型·日期(到秒) → 账户·金额 → 一级·二级分类 → 成员·商家·项目·说明·标签；所有下拉**按使用频次排序** |
| **应收应付** | 状态中文显示：待结清 / 部分结清 / 已结清 / 已逾期 |
| **预算** | 按年月筛选，年/月两级（月预算嵌在年预算下）；预算额/已用/剩余/使用率；新增只列一级分类 |
| **账户管理** | 可填**卡号/备注**；**改余额不静默改数字** —— 服务端按差额补一笔「余额调整」流水（上调记其他收入、下调记其他费用），列表余额恒等于「期初 + 流水」 |
| **分类管理** | 支出/收入**左右并排**，两级树；**一级分类行带底色、默认折叠**（点箭头展开，展开状态跨刷新保留）；**分类名在同类型下全局唯一**（见 §7）；顶部查重/合并 |
| **项目 / 人员 / 商家** | 各自增删改；商家分类是一级分类下拉，颜色用取色器 |

写操作全部走 `/api/*` 复用同一套逻辑，身份只来自服务端会话。首页 `GET /api/summary`、报表 `GET /api/reports/overview`、下拉选项 `GET /api/selectors`（按引用次数降序）。

## 4 Excel / CSV 导入

**账户管理 / 收支明细 / 分类管理 / 项目管理 / 人员 / 商家** 六个页签各有一个「导入 Excel」按钮，也支持 `POST /api/import/<entity>`（body `{filename, data: base64}`）。**MCP 侧没有这个工具** —— 文件传输不适合走工具调用，对话里要导请改用工作台。

| 页签 | 必需列 | 常用可选列 |
|---|---|---|
| 收支明细 | 日期、金额（或「支出」「收入」两列） | 类型、分类、账户、说明、成员、商家、项目、标签、转入账户 |
| 分类 | 名称 | 类型、父分类 |
| 账户 | 名称 | 类型（储蓄卡/信用卡/现金/投资/电子钱包）、余额、币种 |
| 项目 | 名称 | 开始日期、结束日期 |
| 人员 | 名称 | 电话、邮箱 |
| 商家 | 名称 | 分类 |

- 列名中英文别名都认（`日期`/`date`/`交易日期`），表头不在第一行也能找到；结果面板会列出「哪一列被当成了什么」。
- **重复导入同一文件永远 0 新增**：按出现次数去重（库里 M 条 + 文件 N 条只补 N−M），文件内真实重复保留。
- 分类写 `食品酒水/三餐` 自动建两级；只写 `三餐` 时**归一到已有同名分类**，不新建。
- 边界：旧版 `.xls`（97-2003）不支持，请另存 `.xlsx`；`03/04/2026` 这种两位都 ≤12 的按月/日解释。
- 六份示例在 `fixtures/导入示例-*.xlsx`（`node scripts/make-import-templates.mjs` 重新生成）。

## 5 工具清单（44 个）

| 领域 | 工具 |
|---|---|
| 记账 | `tx_add` `tx_list` `tx_update` `tx_delete` |
| 账户 | `account_add` `account_list` `account_update` `account_delete`（含归档；有交易引用则禁止删） |
| 分类 | `category_add` `category_list` `category_update` `category_delete`；查重合并 `category_duplicates` `category_merge` `category_dedupe` |
| 项目 / 成员 / 商家 | `project_*` `member_*` `merchant_*` 各 add/list/update/delete |
| 应收应付 | `receivable_add` `receivable_list` `receivable_update` `receivable_delete` `report_receivables` |
| 预算 | `budget_add` `budget_list` `budget_update` `budget_delete` `report_budget` |
| 报表 | `report_monthly` `report_by_category` `report_overview` `dashboard_build` |
| 多用户 | `user_list` `user_create`（HTTP 模式下 `user_create` 被移除、`user_list` 只返回自己） |
| 迁移 | `import_from_mylife`（`scope`：`all` 全量 / `categories` 仅账户+分类） |

所有工具都接受可选 `userId`（默认 `default`），**HTTP 模式下该参数被服务端强制覆盖**。

## 6 验证

```bash
# 进程内跑（不需要起服务）
node scripts/test-webapp-frontend.mjs
node scripts/test-workbench-dom.mjs
MYLF_DATA_DIR=<临时目录> node scripts/test-importers.mjs

# 需要先起一个实例，再用 SMOKE_BASE 指过去（另开一个终端）
MYLF_DATA_DIR=<全新目录> MYLF_HTTP_PORT=3510 MYLF_ADMIN_PASSWORD=AdminPass123 node server-http.js
SMOKE_BASE=http://127.0.0.1:3510 SMOKE_ADMIN_PASSWORD=AdminPass123 node scripts/test-workbench-v2.mjs
```

> HTTP 探针请用 `127.0.0.1` 而不是 `localhost`（后者可能解析到 `::1`）。

| 脚本 | 项数 | 验什么 |
|---|---|---|
| `test-auth.mjs` | 46 | 登录/会话/越权：`HttpOnly` Cookie、伪造 `x-user-id` 无效、**A 的 token 打 `/mcp/B` 403**、改密即失效、停用三路全断、最后一个管理员不可停用 |
| `test-accounts-v2.mjs` | 42 | 待改密闸门、`logout-others`、删号必须显式 `purge`、留墓碑且同名重建被拒、审计不含密码/token |
| `test-webapp-http.mjs` | 31 | `/api/summary`、静态资源与路径穿越、`/info` 需凭据、看板出图 |
| `e2e-octop-mcp.mjs` | 27 | 握手、43 工具、记账链路、137 分类播种、越权 403、非法 JSON/未知方法。**不幂等**，每次用全新 `MYLF_DATA_DIR` |
| `test-workbench-v2.mjs` | 69 | 卡号/备注、余额调整三条路径、时分秒、按年/分类/关键词查询、**分页（page/pageSize/total/pages/sum 九条）**、六维报表聚合、分类同名校验 11 条 |
| `test-workbench-dom.mjs` | 76 | 不需要浏览器：桩 DOM + 假 fetch/Chart，在 `vm` 里真跑模板脚本；首页 3 张图、混合图类型、11 页签、日期区间控件、**分页条与两行合计**、**报表默认今年**、**报表十张图（四维度各拆收入/支出、按 id 认领取数口径）**、**分类默认折叠与展开** |
| `test-api-import.mjs` | 29 | 导入 API 端到端：别名识别、重复导入、CSV、各类 400 |
| `test-importers.mjs` | 64 | 六类导入映射：多格式日期、千分位、分类路径、幂等、同名归一、用户隔离 |
| `test-webapp-frontend.mjs` | 20 | 从模板里抠出 `api()` 在 `vm` 里跑；另含「`headers` 未初始化」静态扫描（1.1.4 那个写入全挂的 bug 就是它守住的） |
| `make-test-xlsx.mjs` | 20 | 自建 xlsx 后回读：共享字符串、日期序列号、inlineStr、XML 转义、CSV 引号 |

合计 **404 项 0 失败**。其中需起实例的 215 项（46+31+42+27+69）在「**从镜像归档解出应用层直接 `node server-http.js`**」的实例上重跑同样全过，且与工作区源码逐字节比对一致 —— 证明打进 tar 的代码能跑，不只是源码树能跑。前端两套还会从该实例真实返回的 HTML 里再抠一次脚本执行。

## 7 分类硬约束（1.2.2 起）

同一用户（租户）内、同一收支类型下**分类名全局唯一**：一个二级分类只能属于一个一级分类，「食品酒水/三餐」和「居家生活/三餐」不能并存。三层防护：

| 层 | 行为 |
|---|---|
| 应用层 | 新增/改名撞名**直接拦下**，弹窗写明「已存在『X』（已挂在『Y』下）」；一级与二级同名同样拦；分类最多两级 |
| 导入层 | 遇到同名**归一到已存在的分类**，不新建、不报错 —— 老表格照常导 |
| 数据库 | `UNIQUE(user_id, type, name)` 兜底 |

**老库已有历史重名不会崩**：启动只打一行提示并跳过建索引，新增仍由应用层拦截；用「分类管理 → 扫描重复」合并（`reason: same-name`）后重启，索引自动补上。升级不动数据。

## 8 产物与版本

### 8.1 产物（`dist/`）

现保留 **1.2.2 / 1.2.3 / 1.2.4** 各三件，共 666 MB（1.1.x、1.2.0、1.2.1 已清理）：

| 版本 | tar（未压缩） | tar.gz | 技能 zip |
|---|---|---|---|
| 1.2.4（**当前，推荐**） | 163.5 MB | 58.5 MB | 7.3 KB |
| 1.2.3 | 163.5 MB | 58.5 MB | 7.2 KB |
| 1.2.2 | 163.5 MB | 58.4 MB | 7.1 KB |

1.2.4 的 sha256（搬运后 `sha256sum` 复核）：

| 产物 | sha256 |
|---|---|
| `.tar` | `d1cdd7f4e2ecc590a7a80af2d2286fede722549b10b52d085b2d855bf2ec42a0` |
| `.tar.gz` | `016e446f657f0ff83294c56f64d5a405ba997c55a29d44dc5d85b771bffa749c` |
| 技能 zip | `bcfaf3ef9ea60320b3b70ced42f89053dd813d7f891d51fcacc0afd8b5235d9b` |

```bash
node scripts/build-image-tar.mjs --gzip      # 无 Docker 也能出镜像文件 → dist/
node scripts/verify-image-archive.mjs         # 结构 + 与工作区源码逐字节比对
docker load -i mylife-finance-mcp_1.2.4-linux-amd64.tar.gz
```

1.2.2 / 1.2.3 的 sha256、归档格式差异、QNAP 导入步骤见 [docs/OCTOP-DEPLOY.md §14](docs/OCTOP-DEPLOY.md)。

### 8.2 版本历史

| 版本 | 一句话 |
|---|---|
| **1.2.4** | 报表页拆分：账户 / 成员 / 商家 / 项目 四个维度各拆成「收入统计」「支出统计」两张饼图（共 10 张），每张口径固定，不再随「类型」换算法 |
| 1.2.3 | 收支明细分页（默认 20/页，可选 20–1000）+ 本页/全部两行合计；报表默认今年；分类一级折叠带底色 |
| 1.2.2 | 分类名全局唯一（应用层 + 导入层 + 唯一索引三层），老库平滑升级 |
| 1.2.1 | 界面调整：本月交易拆发生/目标账户、报表去冗余下拉、导航定序、明细年份默认本年 + 日期区间控件、分类左右并排 |
| 1.2.0 | 功能批次：首页重做（累计天数/明细数、本月收支、混合趋势图）、账户卡号备注与余额调整流水、年份下拉与一二级分类联动、手工记账重排、报表六饼图（新增 `report_overview`） |
| 1.1.4 | 修工作台写入按钮全挂的 `Content-Type` 报错（1.1.2/1.1.3 受影响） |

## 9 注意

- 金额用正数，方向由 `type` 决定；`dashboard_build` 是生成时刻快照，实时交互用工作台。
- 导入单向只读，不写回 MyLifeOS，不破坏其同步状态。
- 同用户下账户名/分类名唯一；跨用户可重名，数据按 `user_id` 完全隔离。
- 启用 WAL（`journal_mode=WAL` + `busy_timeout=5000`），MCP 服务与工作台可并发同一库。
- `node scripts/reset-data.mjs --dry-run` 先看将删行数，`--yes` 执行（自动 `VACUUM INTO` 备份，重播 137 个内置分类）。

## 10 许可

[MIT](LICENSE) © 2026 Zheny918。可自由使用、修改、商用与再分发，保留版权声明即可。

## 文件结构

```
mylife-finance-skill/
├── LICENSE                      # MIT
├── server.js / server-http.js   # MCP stdio / Streamable HTTP 入口
├── workbench.js                 # 本地工作台（3457，免登录）
├── SKILL.md                     # WorkBuddy 技能（副本在 ~/.workbuddy/skills/）
├── Dockerfile · docker-entrypoint.sh
├── docker-compose.mylife-finance.yml    # 有源码 + Octop 同机（含 build）
├── docker-compose.standalone.yml        # 只有镜像也能起（QNAP / 群晖）
├── docker-compose.qnap-octop-mcp.yml    # Octop + MCP 同一份（天然同网络）
├── install.sh                   # 装技能到 Octop Agent
├── docs/OCTOP-DEPLOY.md         # 部署 / 隔离 / 排障完整指南
├── docs/archive/                # 精简前的原版文档（v1.2.2）
├── octop-skill/                 # Octop 技能包源（打包进 dist/*.zip）
├── scripts/                     # 打包 / 出镜像 / 9 套测试 / 重置数据
├── fixtures/                    # 导入示例与测试文件
├── dist/                        # 打包产物
└── src/
    ├── db.js                    # 建表 + 旧库迁移 + WAL + 137 分类种子
    ├── tools.js                 # 全部工具实现（含 userId 隔离与全实体 CRUD）
    ├── xlsx-reader.js           # 零依赖 xlsx/csv 读取
    ├── importers.js             # 六类导入映射（表头别名 + 限量去重）
    ├── api.js                   # 工作台 REST 路由
    ├── webapp.js                # 静态页 + 登录/管理路由
    ├── accounts.js              # 账号 / 会话 / 每用户 token
    ├── cli.js                   # 用户管理 CLI
    ├── dashboard.js             # 看板数据聚合
    └── *-template.html          # 工作台 / 登录 / 账号 / 管理 / 看板模板
```
