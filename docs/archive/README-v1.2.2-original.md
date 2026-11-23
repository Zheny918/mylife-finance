# MyLife 财务记账技能（mylife-finance-skill）

把 MyLifeOS 的财务/账单能力抽成一个**独立可复用技能**：既能在 WorkBuddy 用，也能在 Octop 用，底层是同一份零依赖 MCP Server，并附一个零依赖的本地图形工作台。

## 架构
```
自然语言（WorkBuddy / Octop）
        │  调用
   薄技能层 SKILL.md（仅领域知识 + 工作流）
        │
   Finance MCP Server（Node + 内置 node:sqlite，零依赖、零安装）
   ├─ server.js       stdio（WorkBuddy、单机 Octop）
   └─ server-http.js  Streamable HTTP（Docker / 远程 / 多人，URL 承载 userId）
        │  同一套 src/tools.js / src/db.js
   ┌────┴─────────────────────────────────────┐
   │ 工作台 /login → /（与 MCP 同一端口，需登录） │  ── 给人点着用
   │   /api/* REST（userId 取自会话，不取请求头）  │
   └────────────────────────────────────────────┘
        │ 读写（按 user_id 隔离）
   独立 SQLite 库 ~/.mylife-finance/finance.db
```
> **v1.1.2 起有账号体系**：`/login` 用户名+密码登录、`/admin` 管理用户、每人一把 MCP token，服务端校验「token 属于谁就只能访问谁」；客户端传 `x-user-id` 已彻底失效。详见 [docs/OCTOP-DEPLOY.md §6](docs/OCTOP-DEPLOY.md)。
> **v1.1.4 修了一个致命前端 bug**：1.1.2 / 1.1.3 的工作台点任何**写入类**按钮会报 `Cannot set properties of undefined (setting 'Content-Type')` —— 1.1.2 移除 `x-user-id` 时误删了请求头的初始化。装的是 1.1.2 / 1.1.3 请换成 1.1.4，账本与 token 都不用动。回归测试 `node scripts/test-webapp-frontend.mjs`（20 项，在 `vm` 里真执行模板脚本，不需要浏览器）。
> **v1.2.0 是一次功能批次**（不改数据格式、不破坏兼容）：工作台导航「报表看板」改名**首页**并重做（累计记账天数/明细数、本月收支与本月支出分类饼图、12 月趋势图改成「收支双柱 + 结余折线」混合图）；账户加**卡号/备注**，改余额会**自动补一笔「余额调整」流水**（账实一致，可选关掉）；收支明细加**年份下拉**（2024–2035）与**一级/二级分类联动**，列表撑满到视口底部；手工记账按「类型·日期(到秒) / 账户·金额 / 一级·二级分类 / 其余」重排，下拉项按**使用频次**排序；商家分类改成一级分类下拉、颜色改用取色器；应收应付新增界面的状态改为中文；**新增「报表」页**——一套筛选条件（类型/日期/账户/成员/商家/项目/说明）出六张饼图（收入类型、支出类型、账户、成员、商家、项目），对应新工具 `report_overview`。工具总数 42 → **43**。
> **v1.2.2 加了一条分类硬约束**：同一账户、同一收支类型下**分类名全局唯一** —— 一个二级分类只能属于一个一级分类，「食品酒水 / 三餐」和「居家生活 / 三餐」不能并存。新增或改名撞名会被**直接拦下**（弹窗里写明撞到了谁、挂在哪个一级分类下，不用猜），一级分类与二级同名同样拦；分类最多两级，二级下面不能再挂子级。导入 Excel 遇到同名时**归一到已存在的那个**，不新建、不报错，所以老表格照常导。数据库另加 `UNIQUE(user_id, type, name)` 兜底；**老库若已有历史重名不会崩**，只会打一行提示，用「分类管理 → 扫描重复」合并后重启即自动补上索引。
> **v1.2.1 按用户反馈调界面**（纯展示层，接口只多一个向后兼容字段）：首页「本月交易」把账户拆成**发生账户 / 目标账户**、分类拆成**一级 / 二级**；报表删掉与「类型」语义重合的**「饼图口径」下拉**（改成由类型推导）；菜单顺序改为 **首页·收支明细·报表·手工记账·应收应付·预算·账户管理·分类管理·项目管理·人员·商家**；收支明细**年份默认本年**、开始/结束合并成**一个日期区间控件**（点开是双月日历 + 左侧快捷区间 + 清空/确定，见原型 `docs/proto/date-range.html`）、新增**人员 / 商家 / 项目**筛选、列名改为「发生账户 / 目标账户」并细分一二级分类、补**人员 / 项目 / 商家**列；分类管理的支出/收入改为**左右并排**。交易接口新增 `categoryParent`（一级分类名，挂一级时为 null）。
- **零依赖**：用 Node 内置 `node:sqlite`（要求 **Node ≥ 22.13**，Node 20 无此模块），手写 MCP stdio / Streamable HTTP 协议，无需 `npm install`；工作台用内置 `http` 模块，**Chart.js 已本地内联**（`src/vendor/chart.umd.js`，离线可用，不依赖 CDN）。<br>⚠️ **Docker 部署时宿主机装什么 Node 都无所谓**（镜像自带 22），只有 stdio 模式与本地工作台才吃本机 Node。三种场景对照见 [docs/OCTOP-DEPLOY.md §2.1](docs/OCTOP-DEPLOY.md)。
- **独立库 + 多用户隔离**：所有表带 `user_id`（默认 `default`）。HTTP 模式下 `userId` 由 URL 路径承载并**强制覆盖**工具参数，模型传错也不会串数据；同时校验**凭据归属**，拿 A 的 token 打 `/mcp/B` 直接 403。本地单用户恒为 `default`。
- **与 MyLifeOS 解耦**：日常通过 **Excel/CSV 导入**补充数据；`import_from_mylife` 仍保留为可选的一次性迁移工具（单向只读，绝不写回，不破坏其同步状态）。

## 文件结构
```
mylife-finance-skill/
├── package.json
├── server.js              # MCP stdio 入口（WorkBuddy / 单机 Octop）
├── server-http.js         # MCP Streamable HTTP 入口（Docker / 远程 / 多人）
├── workbench.js           # 本地工作台 http 服务（给人用）
├── SKILL.md               # WorkBuddy 技能（已复制到 ~/.workbuddy/skills/mylife-finance/）
├── README.md
├── Dockerfile             # MCP 容器镜像（node:22-alpine）
├── docker-entrypoint.sh   # 入口：先校验 Node ≥22.13
├── docker-compose.mylife-finance.yml   # 有源码 + Octop 同机（含 build）
├── docker-compose.standalone.yml       # 只有镜像也能起（QNAP / 群晖 / 独立部署）
├── docker-compose.qnap-octop-mcp.yml   # Octop + MCP 同一份 compose（保证同网络互通）
├── install.sh             # 一键装技能到 Octop Agent
├── docs/
│   └── OCTOP-DEPLOY.md    # 发布到 Octop 的完整指南
├── octop-skill/           # Octop 技能包源（打包进 dist/*.zip）
│   ├── SKILL.md
│   └── references/tools.md
├── scripts/
│   ├── pack-octop-skill.mjs       # 零依赖 ZIP 打包器（含回读校验）
│   ├── make-import-templates.mjs  # 生成六份「导入示例-*.xlsx」
│   ├── make-test-xlsx.mjs         # 生成测试 xlsx 并断言解析结果
│   ├── test-importers.mjs         # 导入映射层测试（需 MYLF_DATA_DIR）
│   ├── test-api-import.mjs        # 导入 API 端到端测试
│   └── reset-data.mjs             # 清空业务数据（自动备份 + 重播内置分类）
├── fixtures/              # 导入示例与测试文件
├── dist/                  # 打包产物
└── src/
    ├── db.js              # 数据层 + 建表 + 旧库迁移 + WAL + 默认分类种子
    ├── tools.js           # 全部工具实现（含 userId 隔离与全实体 CRUD）
    ├── xlsx-reader.js     # 零依赖 xlsx/csv 读取（ZIP + inflateRaw + 自写 XML 解析）
    ├── importers.js       # 六类 Excel 导入映射（表头别名识别 + 限量去重）
    ├── api.js             # 工作台 REST 路由（复用 tools.js；userId 由调用方注入）
    ├── webapp.js          # 工作台静态页 + 登录/管理路由（workbench.js 与 server-http.js 共用）
    ├── accounts.js        # 账号/会话/每用户 token（scrypt + HMAC 签名 cookie，users.json）
    ├── cli.js             # 用户管理 CLI（docker exec ... node src/cli.js list）
    ├── dashboard.js       # 看板数据聚合（实时 + 按用户分文件的静态快照）
    ├── dashboard-template.html   # 静态看板快照模板（离线自包含）
    ├── workbench-template.html   # 交互式工作台模板（10 页签）
    ├── login-template.html       # 登录页
    ├── account-template.html     # 我的账号（改密）
    ├── admin-template.html       # 用户管理（管理员）
    └── vendor/
        └── chart.umd.js  # Chart.js v4.4.1 UMD（本地内联，离线可用）
```

## 快速开始
### 1) WorkBuddy（AI 对话记账）
- MCP 已写入 `~/.workbuddy/mcp.json`（`mylife-finance` → `node --no-warnings server.js`）。
- 技能已放到 `~/.workbuddy/skills/mylife-finance/SKILL.md`。
- **还需一步**：在 WorkBuddy 的「连接器 / 自定义 MCP」里找到 `mylife-finance` 并点「信任」启用。
- 之后对话即可："记一笔餐饮88元，用招行卡" / "这个月花了多少" / "把 MyLifeOS 历史账导进来"。

### 2) 本地工作台（图形界面，手工维护）
```
cd C:/zzytest/mylife-finance-skill
node workbench.js
# 浏览器打开 http://127.0.0.1:3457
```

**Docker / 远程部署不用再单独起进程**：`server-http.js` 把同一份工作台路由挂在 MCP 端口上，打开 `http://<主机>:3458/` 会先跳 `/login`（1.1.2 起有账号体系）；登录后右上角可进「用户管理」建账号、发 token。看板在 `http://<主机>:3458/dashboard.html`，**按登录用户各自一份**。详见 [docs/OCTOP-DEPLOY.md §5.2 / §6](docs/OCTOP-DEPLOY.md)。

`node workbench.js`（本地 3457）是**单机免登录**入口，只绑 `127.0.0.1`，身份固定为 `MYLF_WB_USER`（默认 `default`）；对外提供服务请用 `server-http.js`。

十一个页签（按菜单顺序）：**首页**（原「报表看板」改名。**本年口径**：本年总收入/总支出/净结余，加**累计记账天数**与**累计记账明细数**，再加**本月**收入/支出/结余；趋势图是 1–12 月的**混合图**——收入、支出各一根**柱**、结余一条**折线**；下方两张饼图：本年支出一级分类占比 + 本月支出分类；「本月交易」表把账户拆成**发生账户 / 目标账户**、分类拆成**一级分类 / 二级分类**）、**收支明细**（**年份默认本年**；类型 / 账户 / **人员** / **商家** / **项目** / 一级分类 / 二级分类 多维筛选，**日期是一个区间控件**——点开是双月日历 + 左侧快捷区间，选完按「确定」才生效；列表**撑满到浏览器底部**、表头吸顶、底部显示总笔数与合计；列为「日期 / 类型 / **发生账户 / 目标账户** / **一级分类 / 二级分类** / **人员 / 项目 / 商家** / 说明 / 标签 / 金额」）、**报表**（**一套筛选打到底**：收支类型、日期区间、账户、成员、商家、项目、说明关键词；出**六张饼图**：收入类型、支出类型、账户收支、成员收支、商家收支、项目收支；**口径由「类型」决定**，不再单设「饼图口径」下拉——全部=合计、只看收入=收入、只看支出=支出。转账不计入，分类按一级归并、二级自动上卷）、**手工记账**（布局按「类型·日期(到秒)」→「账户·金额」→「一级·二级分类」→「成员·商家·项目·说明·标签」；**日期精确到时分秒**；所有下拉**按使用频次排序**）、**应收应付**（新增/编辑/删除 + 汇总；**状态显示为中文**：待结清 / 部分结清 / 已结清 / 已逾期）、**预算**（**按年份/月份筛选**，默认当前年月；预算额/已用/剩余/使用率；**年/月两级**：同分类月预算嵌在年预算下；新增预算分类**只列一级分类**）、**账户管理**（新增/编辑/归档/删除；新增可填**卡号**与**备注**；**改余额不是静默改数字**——服务端按差额补一笔「余额调整」流水，上调记「其他收入」、下调记「其他费用」，所以列表余额恒等于「期初 + 流水」；按账户类型过滤 + 底部合计余额）、**分类管理**（**支出 / 收入左右并排**，两级树形展示，新增/编辑可指定父级；**内置初始分类，首次运行自动写入**；顶部**查重 / 合并**）、**项目管理**（新增/编辑/删除）、**人员**（成员新增/编辑/删除）、**商家**（独立页签：**分类是一级分类下拉**，颜色用**取色器**）。**账户管理 / 收支明细 / 分类管理 / 项目管理 / 人员 / 商家** 六个页签各有一个「导入 Excel」按钮（见下一节）。工作台所有写操作经 `/api/*` 复用同一套逻辑，**身份只来自服务端会话**（`x-user-id` 已在 1.1.2 移除）。首页与报表分别走 `GET /api/summary` 与 `GET /api/reports/overview`，下拉选项走 `GET /api/selectors`（按引用次数降序），日期区间只产 `from` / `to`。

### 3) 用 Excel 导入数据
**账户管理 / 收支明细 / 分类管理 / 项目管理 / 人员 / 商家** 六个页签各有一个「导入 Excel」按钮。点它选文件即可，支持 `.xlsx` 与 `.csv`。

- **列名自动识别**：中英文别名都认（`日期`/`date`/`交易日期`、`金额`/`amount`/`交易金额`、`分类`/`category`/`类别`…），表头不在第一行（上面有标题行）也能找到。
- **导入结果面板会列出「哪一列被当成了什么」**，列对不上能立刻发现。
- **重复导入同一文件永远 0 新增**：按「出现次数」去重，库里已有 M 条、文件里有 N 条时只补 N−M 条，所以文件里真实存在的两笔同额同日交易不会被吞掉。
- **分类路径**：写「食品酒水/三餐」自动建两级；只写「三餐」时优先挂到已有的同名分类下，不会另建一堆顶级分类。
- 六份可直接改内容使用的示例在 `fixtures/导入示例-*.xlsx`（`node scripts/make-import-templates.mjs` 可重新生成）。

| 页签 | 必需列 | 常用可选列 |
|---|---|---|
| 收支明细 | 日期、金额（或「支出」「收入」两列） | 类型、分类、账户、说明、成员、商家、项目、标签、转入账户 |
| 分类 | 名称 | 类型、父分类 |
| 账户 | 名称 | 类型（储蓄卡/信用卡/现金/投资/电子钱包）、余额、币种 |
| 项目 | 名称 | 开始日期、结束日期 |
| 人员 | 名称 | 电话、邮箱 |
| 商家 | 名称 | 分类 |

> 两处边界：**旧版 `.xls`（97-2003）不支持**，请在 Excel 里另存为 `.xlsx`；**`03/04/2026` 这种两位都 ≤12 的写法按月/日解释**，其中一位大于 12 时自动按「日/月」识别。

### 4) Octop 接入（两件套）
Octop 的技能包 / 专家包 / 插件包**都无法声明 MCP**，所以必须拆成两件：技能走技能包，工具走自定义 MCP。

```bash
# 打包技能
node scripts/pack-octop-skill.mjs
# 装到 Octop Agent 工作区
OCTOP_HOME=/data/.octop ./install.sh --agent main --user alice
```

然后在 Octop 控制台「连接器 → 添加自定义 MCP」：

| 部署方式 | 类型 | 配置 |
|---|---|---|
| Docker / 多人（与 Octop 同 docker 网络） | Streamable HTTP | `http://mylife-finance-mcp.internal:3458/mcp/<用户名>` |
| Docker / 跨机、跨网络 | Streamable HTTP | `http://<宿主私网IP>:3458/mcp/<用户名>`（须设 `MYLF_HTTP_TOKEN` + Headers） |
| 单机自用 | stdio | `command=node`，`args=["<绝对路径>/server.js"]` |

⚠️ **别填纯容器名 `mylife-finance-mcp`**：Octop 的 URL 校验器只放行私网 IP / `localhost` / `.local` / `.internal` 后缀，纯容器名会被判成公网地址、要求 HTTPS。另外，**两份 compose 各起各的时候默认网络是隔离的**（各自 `<项目名>_default`），必须显式共享网络 —— 见 [docs/OCTOP-DEPLOY.md §3.5](docs/OCTOP-DEPLOY.md)；想省事直接用 `docker-compose.qnap-octop-mcp.yml`（Octop + MCP 同一份，天然同网络）。

**隔离边界是 URL 里的用户名**，不是模型传的参数 —— 服务端会强制覆盖 `userId`，模型传错也读不到别人的数据。每个家庭成员/同事配自己的 URL 即可。

**没有 Docker 的机器也能产出镜像文件**（给有 Docker 的服务器 / NAS 直接导入）：

```bash
node scripts/build-image-tar.mjs --gzip   # → dist/*.tar（163MB，docker save 格式）+ *.tar.gz（58MB）
# 目标机：docker load -i mylife-finance-mcp_1.2.2-linux-amd64.tar.gz
# QNAP / 群晖：Container Station「导入映像」直接选该文件（架构须匹配，SSH 里 uname -m 查）
```

原理是从 registry 拉官方 `node:22-alpine` 的层（原样不改）再叠一个应用层，按 **`docker save`（Docker Archive）** 布局封装 —— 注意不是 OCI 布局，后者会被 Docker ≤24 与 NAS 图形界面判为「格式不正确」。详见 [docs/OCTOP-DEPLOY.md §14](docs/OCTOP-DEPLOY.md)。

### 5) 局域网里的第二个客户端（另一台 WorkBuddy / 手机）
MCP 是**无状态 HTTP**，账本在服务端单一 `finance.db` 里，**多个客户端连同一个地址 = 共用同一本账**，不需要同步库。
（实测：两个进程指向同一 `finance.db`、交替并发写 30 次，0 失败，两侧读数一致。）

两处要改：
1. compose 的 `ports` 改成 `"3458:3458"`（默认 `127.0.0.1:3458:3458` 只给宿主机），
2. **同时设 `MYLF_HTTP_TOKEN`** —— URL 里的用户名只是分区名、不是凭据，不设 token 等于同网段谁都能读写任意账本。

客户端侧（WorkBuddy「连接器 → 自定义连接器 → 配置 MCP」）：

```json
{
  "mcpServers": {
    "mylife-finance": {
      "type": "streamableHttp",
      "url": "http://<Octop主机IP>:3458/mcp/zhang",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

`type` 必须写驼峰 `streamableHttp`；URL 里的用户名决定看哪本账（同名 = 同一本）。若客户端强制 URL 以 `/mcp` 结尾，用 `http://<IP>:3458/mcp?user=zhang`（等价，已实测）。

完整步骤（容器构建、network、数据搬家、备份、故障排查）见 **[docs/OCTOP-DEPLOY.md](docs/OCTOP-DEPLOY.md)**。

## 工具清单
- 记账：`tx_add` `tx_list` `tx_update` `tx_delete`
- 账户：`account_add` `account_list` `account_update` `account_delete`（含归档；有交易引用则禁止删）
- 分类：`category_add` `category_list` `category_update` `category_delete`（有交易引用则禁止删）
- 分类查重/合并：`category_duplicates`（只读查重：完全重名 / 空壳同名 / 同名不同父级 / 孤立顶级）`category_merge`（把来源分类的交易+子级+预算并入目标后删除来源，支持 dryRun）`category_dedupe`（批量去重，默认 dryRun 只预览）
- 项目：`project_add` `project_list` `project_update` `project_delete`
- 成员：`member_add` `member_list` `member_update` `member_delete`
- 商家：`merchant_add` `merchant_list` `merchant_update` `merchant_delete`
- 应收应付：`receivable_add` `receivable_list` `receivable_update` `receivable_delete` `report_receivables`
- 预算：`budget_add` `budget_list` `budget_update` `budget_delete` `report_budget`
- 多用户：`user_list` `user_create`（HTTP 共享实例下 `user_create` 被移除、`user_list` 只返回自己）
- 报表：`report_monthly` `report_by_category` `dashboard_build`
- 导入：`import_from_mylife`（可选的一次性迁移，`scope`：`all`=全量；`categories`=仅账户+分类）
- Excel/CSV 导入**只在工作台网页里**：`POST /api/import/<entity>`（entity = `transactions` / `categories` / `accounts` / `projects` / `members` / `merchants`），body `{filename, data: base64}`。**MCP 侧没有这个工具** —— 文件传输不适合走工具调用协议，从 Octop/WorkBuddy 对话里导 Excel 请改用本地工作台。

共 43 个工具（stdio）；HTTP 模式过滤掉 `user_create` 后为 42 个。
所有工具均接受可选 `userId`（默认 `default`），**HTTP 模式下该参数被服务端强制覆盖**，用户身份由 MCP URL 路径决定。

## 数据来源与多库拓扑
MyLifeOS 存在「三库」：旧 Electron(`%APPDATA%/MyLifeOS/data/`)、生产服务端(`C:\ProgramData\MyLifeOS\`)、开发库(`mylife-os/apps/web/prisma/dev.db`)。
真实交易通常在**生产服务端库**。`import_from_mylife` 会**扫描多个候选库并合并去重**（默认不含 dev.db；可用 `dbPath` 显式指定），导入数据打上所属 `userId`。

## 验证
- 多用户隔离 + 全实体 CRUD：`alice`/`bob`/`carol` 各自数据互不串（后端冒烟 30 项通过：分类/项目/成员/应收/预算/账单 的增改删、删除保护、期初分类导入仅导账户+分类）。
- 旧库迁移：无 `user_id` 的旧库在首次加载时自动补列、归入 `default`、保留历史数据，并将 `UNIQUE` 约束修正为 `(user_id, name)`。
- **账号 / 会话 / 越权防护**（1.1.2）：`node scripts/test-auth.mjs`，**46 项通过** —— 未登录跳登录页、错误密码 401、Cookie `HttpOnly; SameSite=Lax`、成员打不开 `/admin`、伪造 `x-user-id` 与 `?userId=` 均无效、**拿 A 的 token 打 `/mcp/B` 返回 403**、`?token=` 换发会话且跳转后地址不带 token、看板按用户分文件（admin 打 alice 的看板得 404）、改密后旧会话立即失效、停用后登录/会话/token 三路全断、token 轮换后旧值立刻失效、最后一个管理员不可停用/删除。
- **账号运维面**（1.1.3）：`node scripts/test-accounts-v2.mjs`，**42 项通过** —— 待改密时只放行 `/account` 与 `/api/auth/*`（其余 302/403）、改密后旧会话全失效、`logout-others` 只留当前设备、删号必须显式选 `purge`、删号留墓碑且同名重建被拒、勾选接管后旧数据仍在、清库后是干净账本、`stats` 预检数据量、成员看审计 403、审计日志不含密码哈希与 token 明文。
- **工作台 HTTP 面**：`node scripts/test-webapp-http.mjs`，**31 项通过**（登录、`/api/summary`、`/vendor` 静态与路径穿越、`/info` 需凭据并回显身份、`dashboard_build` 返回规整 `url`、看板出图、未知路径 404）。
- **MCP 协议 e2e**：`node scripts/e2e-octop-mcp.mjs`，**27 项通过**（握手、43 工具、记账链路、137 分类播种、用户隔离、越权 403、路径穿越/非法 JSON/未知方法）。**该脚本不幂等**，每跑一次要用全新的 `MYLF_DATA_DIR`。
- **导入 API 端到端**：`node scripts/test-api-import.mjs http://127.0.0.1:<端口>`，**29 项通过**（列名别名识别、重复导入、CSV、缺 data / 非法实体 / 非表格 / 缺日期列的 400 错误）。
- **零依赖 xlsx 读取**：`node scripts/make-test-xlsx.mjs` 自建 xlsx 后回读，**20 项通过**（共享字符串、富文本多 run、日期序列号、inlineStr、布尔、空单元格对齐、XML 转义、CSV 引号与 BOM）。
- **六类导入映射**：`MYLF_DATA_DIR=<临时目录> node scripts/test-importers.mjs`，**64 项通过**（日期多格式 `2026/11/01`、`2026年11月3日`、千分位、全角括号负数、分类路径拆分、重复导入幂等、文件内真实重复保留、**同名分类导入归一到已存在的那个**、账户类型中文映射、缺列报错、用户隔离）。
- **工作台前端请求封装**：`node scripts/test-webapp-frontend.mjs`，**20 项通过** —— 从 4 个模板的 `<script>` 里抠出 `api()` / `j()`，在 `vm` 里用假 `fetch` 真执行：GET 不抛、POST 带 body 不抛、`Content-Type` 与 body 序列化正确、`ok:false` 透传服务端文案、401 跳 `/login`；另有一道静态扫描，禁止「`X.headers[...]` 赋值前 `headers` 未初始化」。**这条是 1.1.4 补的**：1.1.2/1.1.3 因删掉 `headers` 初始化导致工作台所有写入按钮报 `Cannot set properties of undefined (setting 'Content-Type')`，而当时的服务端测试全绿 —— 因为模板脚本只在浏览器里跑。
- **工作台交互面**（1.2.0 起）：`node scripts/test-workbench-dom.mjs`，**47 项通过** —— 不需要浏览器：从 `workbench-template.html` 抽出全部 `id` 建桩元素、喂假 `fetch`、假 `Chart` 记录配置，把整段内联脚本丢进 `vm` 真跑一遍。断言初始化不抛错、首页出 3 张图、趋势是 `["bar","bar","line"]` 混合图、累计/本月卡片渲染、11 个页签切换都不炸、报表页 6 张 doughnut、选二级自动回填一级、`dtView`/`nowLocalInput`/`repItems`/应收状态中文都对；**1.2.1 又补了 18 条**：日期区间控件（两次点击成区间、反选自动排序、快捷项、清空、非整年清空年份、整年回填年份）、报表「类型」驱动口径、导航顺序、首页与明细的列名与行渲染、分类左右布局。
- **工作台 v2 接口验收**（1.2.0 起）：`SMOKE_BASE=… node scripts/test-workbench-v2.mjs`，**60 项通过** —— 账户卡号/备注、余额调整三条路径（上调记其他收入、下调记其他费用、`adjustBalance:false` 直改期初）、记账时分秒、按年/按分类 id/按说明关键词查询、`/api/selectors` 按使用频次排序（一级分类的 `used` 累计子级）、`/api/reports/overview` 六维度聚合与筛选、转账不计入收支、首页 `totalDays`/`totalTxCount`/本月收支口径、**交易视图的 `categoryParent`（二级交易上卷出一级名，`txList` 与 `/api/summary` 两条路径各验一次）**，以及 **1.2.2 新增的分类同名校验 11 条**（同父级同名幂等、跨父级拦截、一级与二级同名拦截、首尾空格视为同名、不同收支类型可同名、二级不许再挂子级、父级不存在、改名撞车、被拦的 6 次请求一条都没落库）。分类在测试内自建（带时间戳），可重复运行。
- 以上九套（不含 `make-test-xlsx` 那 20 项）合计 **366 项，0 失败**（46+31+42+27+29+64+20+47+60）；其中需起实例的五套共 **206 项**在「**从镜像归档里解出应用层、直接 `node server-http.js` 起服务**」的实例上重跑同样全过，并与工作区源码逐字节比对一致 —— 证明打进 tar 的代码能跑，不只是源码树能跑。前端两套还会**从该实例真实返回的 HTML 里再抠一次脚本执行**，确保容器吐给浏览器的就是修好的代码。
- **六份示例文件可导入**：`fixtures/导入示例-*.xlsx` 逐一导入 0 失败，转账行正确识别 `TRANSFER` 并关联对方账户。

## 重置数据
`node scripts/reset-data.mjs --dry-run` 查看将删除的行数；确认后加 `--yes` 执行。脚本会先 `VACUUM INTO` 备份到同目录，再清空 9 张业务表（保留 `users` / `settings`），最后重新播种内置 137 个分类。想让分类也留空加 `--no-seed`。
- 离线快照：生成的看板内联 Chart.js 源码、不含 CDN 引用，断网可独立打开；1.1.2 起按用户分文件落在 `dashboards/<用户名>.html`，多人共用一套服务时互不覆盖。

## 注意
- 金额用正数，方向由 `type` 决定；看板为生成时刻快照，实时交互请用工作台。
- 导入单向只读，不写回 MyLifeOS，绝不破坏其同步状态。
- 多用户：同一用户下账户名/分类名唯一；跨用户可重名，数据按 `user_id` 完全隔离。
- 启用 WAL（`journal_mode=WAL` + `busy_timeout=5000`）以支持 MCP 服务与工作台并发访问同一库。
