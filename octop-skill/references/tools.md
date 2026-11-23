# 工具参考（mylife-finance）

共 43 个工具。**所有列出的 `userId` 参数在 Octop 部署下都被服务端忽略并强制覆盖**，传了也无害但没必要。

带 `*` 的是必填。

## 记账

| 工具 | 说明 | 参数 |
|---|---|---|
| `tx_add` | 记一笔收支或转账；账户/分类/成员/商家/项目不存在时按名自动创建 | `account*` `amount*` `type` `category` `description` `date` `time` `tags` `member` `merchant` `project` `toAccount` `accountType` `toAccountType` |
| `tx_list` | 查账，按类型/账户/分类/成员/商家/项目/日期区间/年份/tag/说明关键词过滤，倒序 | `type` `account` `category` `categoryId` `member` `merchant` `project` `from` `to` `year` `q` `tag` `page` `pageSize` `limit` `offset` `includeArchived` |
| `tx_update` | 按 id 改一笔 | `id*` + 任意可改字段 |
| `tx_delete` | 按 id 删一笔 | `id*` |

`type`：`EXPENSE` / `INCOME` / `TRANSFER`（转账需 `toAccount`）。
`category` 传一级名会自动匹配其下全部二级；`categoryId` 同理（按 id 展开整棵子树）。
`date` 只存日期，`time` 只存 `HH:MM:SS`；两者可分开传，也可用 `date: "2026-11-16T14:32:05"` 一次给全。
`year` 与 `from`/`to` 互斥，给了 `year` 就查整年。
`tx_list` 的返回带 `total`（命中总数）、`page` / `pageSize` / `pages`，以及 `sum`（按同一筛选条件**跨页**求出的收入 / 支出 / 净额，转账不计入）。分页用 `page` + `pageSize`（默认 50，上限 5000）；旧的 `limit` / `offset` 仍然可用。
每行还带 `categoryParent`：交易挂在**二级**分类时它是**一级分类名**，挂在**一级**或没挂分类时为 `null`。
（做分类展示时用它拼「一级 / 二级」两列，不必再查一遍分类树。）

## 账户

| 工具 | 说明 | 参数 |
|---|---|---|
| `account_add` | 新增账户 | `name*` `type` `currency` `balance` `cardNo` `note` `icon` `color` |
| `account_list` | 列出账户；`balance` 是**实际余额**（期初 + 流水），另给 `openingBalance` | `includeArchived` |
| `account_update` | 改名/类型/余额/币种/卡号/备注/归档 | `id*` `name` `type` `balance` `currency` `cardNo` `note` `icon` `color` `archived` `adjustBalance` `adjustNote` |
| `account_delete` | 删除；**有交易引用时拒绝**，请改用归档 | `id*` |

`type`：`DEBIT_CARD` 借记卡 / `CREDIT_CARD` 信用卡 / `INVESTMENT` 投资理财 / `CASH` 现金 / `E_WALLET` 电子钱包 / `OTHER` 其他。

> **改余额会落一笔调整流水**：传 `balance` 时，服务端按差额自动记一笔「余额调整」——
> 上调记 `INCOME`（分类「其他收入」）、下调记 `EXPENSE`（分类「其他费用」），
> 备注形如 `余额调整：2000 → 1500`。返回里的 `adjustment` 就是这笔流水。
> 只想改期初、不留痕迹，传 `adjustBalance: false`（备注可用 `adjustNote` 自定义）。

## 分类

两级结构：顶级分类 + 二级分类（`parentId` 指向顶级）。

**分类名在同一账户 + 同一收支类型下唯一**：一个二级分类只能属于一个一级分类，不能有「食品酒水/三餐」和「居家生活/三餐」并存。`category_add` / `category_update` 撞名会**直接报错**（错误里写明已存在的那个挂在哪个一级分类下）；一级与二级同名同样拦；二级下面不能再挂子级。

| 工具 | 说明 | 参数 |
|---|---|---|
| `category_add` | 新增分类；同父级同名直接返回既有（幂等），跨父级同名报错 | `name*` `type*` `parentId` `icon` `color` |
| `category_list` | 列出分类 | `type` |
| `category_update` | 改名/类型/图标/父级/排序；改成撞名同样报错 | `id*` `name` `type` `parentId` `icon` `color` `sortOrder` |
| `category_delete` | 删除；**有交易引用时拒绝** | `id*` |

### 查重与合并

| 工具 | 说明 | 参数 |
|---|---|---|
| `category_duplicates` | 只读查重：完全重名 / 空壳 / 同名不同父级，并给建议保留项 | `type` |
| `category_merge` | 把来源分类的交易+子级+预算并入目标后删除来源；类型必须一致，目标不能在来源子树内 | `targetId` 或 `targetName`，`sourceIds` 或 `sourceNames`，`type` `deleteSource` `dryRun` |
| `category_dedupe` | 批量合并「完全重名」组（保留交易最多者）；`includeShell` 连空壳一起 | `type` `includeShell` `dryRun` |

`dryRun` 默认只预览。**改库前先跑一次 dryRun 看结果**。

## 成员 / 商家 / 项目

| 工具 | 说明 | 参数 |
|---|---|---|
| `member_add` / `member_list` | 成员 | `name*` / — |
| `member_update` / `member_delete` | 成员改删 | `id*` `name` `phone` `email` `icon` `color` `isDefault` |
| `merchant_add` / `merchant_list` | 商家 | `name*` `category` `icon` `color` |
| `merchant_update` / `merchant_delete` | 商家改删（有交易引用时禁删） | `id*` `name` `category` `icon` `color` |
| `project_add` / `project_list` | 项目 | `name*` `icon` `color` `startDate` `endDate` |
| `project_update` / `project_delete` | 项目改删 | `id*` `name` `icon` `color` `startDate` `endDate` |

## 应收应付

| 工具 | 说明 | 参数 |
|---|---|---|
| `receivable_add` | 新增 | `counterparty*` `amount*` `receivedAmount` `description` `dueDate` `status` `contactName` |
| `receivable_update` / `receivable_delete` / `receivable_list` | 改删列 | `id*` 等 |
| `report_receivables` | 按状态汇总 + 明细 | — |

`status`：`PENDING` 待结清 / `PARTIAL` 部分结清 / `PAID` 已结清 / `OVERDUE` 已逾期。
（工作台新增界面是中文下拉，不要再猜 `RECEIVED` —— 服务端已结算用的是 `PAID`。）

## 预算

预算只挂**一级分类**；传二级会自动上卷到一级。同分类同期间重复新增会**更新金额**而非新增行。

| 工具 | 说明 | 参数 |
|---|---|---|
| `budget_add` | 新增 | `amount*` `category` `period` `month` `year` |
| `budget_update` / `budget_delete` / `budget_list` | 改删列 | `id*` 等 |
| `report_budget` | 预算 vs 已用 / 剩余 / 使用率；月预算嵌在年预算 `children` | `year` `month`（传 `all` 不限月份） |

`period`：`YEARLY`（默认）/ `MONTHLY`（需同时给 `month`，格式 `YYYY-MM`）。

## 报表

| 工具 | 说明 | 参数 |
|---|---|---|
| `report_monthly` | 某月收入/支出/净额 + 分类与账户明细 | `year` `month` |
| `report_by_category` | 按分类汇总金额与笔数 | `type` `from` `to` |
| `report_overview` | **多维报表**：一次给出收支总账 + 收入/支出各按一级分类，以及账户/成员/商家/项目四个维度的收支聚合。转账不计入 | `type` `from` `to` `account` `member` `merchant` `project` `categoryId` `q` |
| `report_budget` | 见上 | `year` `month` |
| `dashboard_build` | 生成自包含 HTML 看板，返回 `path` / `url` / `relativeUrl` | — |

`report_overview` 的返回：

```
totals              { income, expense, net, count }
incomeByCategory    收入按一级分类，[{ name, income, expense, amount, cnt }]，降序
expenseByCategory   支出按一级分类（挂二级的自动上卷到根）
byAccount / byMember / byMerchant / byProject   同结构，按 amount 降序
filters             回显本次生效的筛选条件（未给的字段为 null，type 为 'ALL'）
```

要「收入类型饼图」用 `incomeByCategory`，「支出类型饼图」用 `expenseByCategory`，
「账户/成员/商家/项目收支饼图」用对应维度并按需在 `income` 与 `expense` 之间切口径。
`categoryId` 会展开整棵子树；`q` 只匹配说明文字。

> `dashboard_build` 的 `path` 是**服务端容器内路径**，你在对话里读不到那个文件。可用的做法：① 若返回了 `url`（部署方已设 `MYLF_PUBLIC_BASE_URL`），把它原样给用户，浏览器可直接打开；② 未返回 `url` 时用 `relativeUrl` 提示用户访问 `<服务地址>/dashboard.html`；③ 只想要数字，优先用 `report_*` 类工具。

## 数据

| 工具 | 说明 | 参数 |
|---|---|---|
| `import_from_mylife` | 从 MyLifeOS 库只读导入 | `dbPath` `scope`（`all` / `categories`） |

> **容器部署下通常用不了**：需要把 MyLifeOS 的 `mylife-os.db` 挂载进容器并传 `dbPath`。没有该库时忽略此工具。

> **Excel 批量导入没有对应的 MCP 工具**。它只在本地工作台网页里提供（`node workbench.js` → 六个页签各一个「导入 Excel」按钮）。从 Octop 对话里要导表格，请让用户在能打开工作台的机器上操作；容器部署默认没有暴露工作台端口。

## 不可用

| 工具 | 原因 |
|---|---|
| `user_create` | 共享实例下由部署者通过 MCP URL 决定用户，不允许模型自建租户 |
| `user_list` | 仅返回当前用户自己，不暴露其他租户 |
