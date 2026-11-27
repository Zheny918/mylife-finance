---
name: mylife-finance
description: 个人财务记账与报表技能。当用户要记录收支/转账、查询账目、管理账户与收支明细、生成月度/分类/预算/应收应付报表，或打开交互式财务工作台时使用。支持自然语言记账（如"记一笔餐饮88元，用招行卡"）。数据存于独立 SQLite 库，支持按 userId 多用户隔离，与 MyLifeOS 主程序同步解耦。
---

# MyLife 财务记账技能

通过内置的 Finance MCP Server 操作一个**独立**的财务 SQLite 库（默认 `~/.mylife-finance/finance.db`），与 MyLifeOS 主程序的 local-first 同步彻底解耦，互不干扰，数据可移植。

## 工具清单（由 MCP 提供）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tx_add` | 记一笔 | account(必填), type(INCOME/EXPENSE/TRANSFER), amount(必填), category, description, date, time(时分秒 HH:MM:SS), tags, member, merchant, project, toAccount(转账目标) |
| `tx_list` | 查账（支持分页/筛选） | type / account / category / **categoryId(含子树)** / member / merchant / project / from / to / **year** / **q(说明关键词)** / tag / **page / pageSize**(默认 50，上限 5000) / limit / offset；返回带 **total**、**pages**、**sum**(按同一筛选跨页求出的收入/支出/净额) |
| `tx_update` / `tx_delete` | 改/删一笔 | id(必填) + 待改字段 |
| `account_add` / `account_list` / `account_update` / `account_delete` | 账户（含归档；有交易则禁止删） | name, type, currency, balance, **cardNo(卡号)**, **note(备注)**；`account_list` 的 balance 是**实算余额**（期初+流水），另给 openingBalance |
| `category_add` / `category_list` / `category_update` / `category_delete` | 分类（INCOME/EXPENSE，两级；有交易则禁止删） | name, type, icon, color, parentId |
| `category_duplicates` | 分类查重（只读）：完全重名 / 空壳同名 / 同名不同父级 / 孤立顶级 | type（可选） |
| `category_merge` | 合并分类：把来源分类的交易 + 子级 + 预算迁到目标并删除来源（禁循环、禁跨类型） | targetId 或 targetName、sourceIds 或 sourceNames、dryRun |
| `category_dedupe` | 批量去重：自动合并「完全重名」，`includeShell:true` 连空壳同名一起；默认 dryRun 预览 | type、includeShell、dryRun |
| `project_add` / `project_list` / `project_update` / `project_delete` | 财务项目 | name, icon, color, startDate, endDate |
| `member_add` / `member_list` / `member_update` / `member_delete` | 成员 | name, phone, email, icon, color |
| `merchant_add` / `merchant_list` / `merchant_update` / `merchant_delete` | 商家（可填分类/图标/颜色；有交易引用则禁止删） | name, category, icon, color |
| `receivable_add` / `receivable_list` / `receivable_update` / `receivable_delete` | 应收应付（status：PENDING 待结清 / PARTIAL 部分结清 / PAID 已结清 / OVERDUE 已逾期） | counterparty, amount, receivedAmount, dueDate, status, contactName |
| `report_receivables` | 应收应付汇总（只统计未结清的） | 无 |
| `budget_add` / `budget_list` / `budget_update` / `budget_delete` | 预算（分类只挂一级；YEARLY 或 MONTHLY+month；同期间重复新增改金额） | category, amount, period, month, year |
| `report_budget` | 预算执行报表（年/月筛选 + 已用/剩余/使用率；月预算嵌在年预算 children） | year, month（1-12 或 all） |
| `user_list` / `user_create` | 多用户维度（Octop 多租户；`user_create` 在共享实例下被禁用） | name |
| `report_monthly` | 某月收支汇总 | year, month（默认当前月） |
| `report_by_category` | 按分类汇总 | type, from, to |
| `report_overview` | **多维报表**：总账 + 收入/支出各按一级分类 + 账户/成员/商家/项目四维度聚合。转账不计入 | type / from / to / account / member / merchant / project / categoryId / q |
| `dashboard_build` | 生成自包含离线 HTML 看板（内联 Chart.js） | 无，返回文件路径 |
| `import_from_mylife` | 从 MyLifeOS 只读导入历史 | dbPath(可选), userId(归属用户), scope(`all`=全量 / `categories`=仅期初账户+分类) |

> 所有工具均可带可选参数 **`userId`**（默认 `default`）。Octop 侧由登录用户身份注入；本地单用户恒为 `default`。

**`report_overview` 的返回**：`totals{income,expense,net,count}`、`incomeByCategory`、`expenseByCategory`（二级自动上卷到一级）、`byAccount`/`byMember`/`byMerchant`/`byProject`（每项含 `income`/`expense`/`amount`/`cnt`，按 amount 降序）、`filters`（回显生效条件）。**要饼图数据就用它，别自己拼多次 `report_by_category`。**

## 本地工作台（图形界面）

除 MCP 工具外，附带一个零依赖的本地 Web 工作台，给人点着用（与 MCP 服务共享同一 SQLite，互不依赖）：

```
node C:/zzytest/mylife-finance-skill/workbench.js
# 浏览器打开 http://127.0.0.1:3457
```

十一个页签（按菜单顺序）：**首页**（原「报表看板」改名。**本年口径**：本年总收入/总支出/净结余 + **累计记账天数** + **累计记账明细数** + **本月**收入/支出/结余；趋势图是 1–12 月的**混合图**——收入、支出各一根**柱**、结余一条**折线**；下方两张饼图：本年支出一级分类占比 + 本月支出分类；「本月交易」把账户拆**发生账户 / 目标账户**、分类拆**一级 / 二级**）、**收支明细**（**年份默认本年**；类型 / 账户 / **人员** / **商家** / **项目** / 一级分类 / 二级分类 筛选；**日期是一个区间控件**——点开是双月日历 + 左侧快捷区间，选完按「确定」才生效；列表**撑满到浏览器底部**、表头吸顶、底部显示总笔数与合计；列为「日期 / 类型 / **发生账户 / 目标账户** / **一级分类 / 二级分类** / **人员 / 项目 / 商家** / 说明 / 标签 / 金额」）、**报表**（**一套筛选打到底**：类型 / 日期区间 / 账户 / 成员 / 商家 / 项目 / 说明关键词；出**十张饼图**：收入类型、支出类型，以及**账户/成员/商家/项目各拆「收入统计」+「支出统计」两张**；每张图口径固定（收入图只取收入、支出图只取支出），**「类型」只负责过滤数据**，不再单设口径下拉）、**手工记账**（布局按「类型·日期(到秒)」→「账户·金额」→「一级·二级分类」→「成员·商家·项目·说明·标签」；**日期精确到时分秒**；所有下拉**按使用频次排序**）、**应收应付**（**状态显示为中文**：待结清 / 部分结清 / 已结清 / 已逾期）、**预算**（按年/月筛选，预算额/已用/剩余/使用率；年/月两级；新增只列一级分类）、**账户管理**（新增/编辑/归档/删除；可填**卡号**与**备注**；**改余额会补一笔「余额调整」流水**，上调记其他收入、下调记其他费用；按账户类型过滤 + 底部合计余额）、**分类管理**（**支出 / 收入左右并排**，两级树形，可指定父级；**内置初始分类，首次运行自动写入**；顶部**分类查重 / 合并**）、**项目管理**、**人员**、**商家**（**分类是一级分类下拉**，颜色用**取色器**）。工作台所有写操作经 `/api/*` 复用同一套逻辑，**身份来自服务端会话 Cookie**（1.1.2 起 `x-user-id` 已彻底失效）。Chart.js 已本地内联，断网可用。

## 工作流

1. **记账**：账户/分类不存在时由 `tx_add` 自动按名创建，无需预置。
   例："记一笔餐饮88元，用招行卡" → `tx_add({ account:"招商银行", category:"餐饮", type:"EXPENSE", amount:88 })`
   转账："从招行转500到微信" → `tx_add({ account:"招商银行", toAccount:"微信", type:"TRANSFER", amount:500 })`
   要精确时间："今天 14:32:05 打车 26 元" → `tx_add({ ..., date:"2026-11-16", time:"14:32:05" })`
2. **账户/明细管理**：优先建议使用本地工作台（`workbench.js`）图形操作；确认无误也可直接调 `account_update` / `tx_update` / `tx_delete`。
3. **查账**："这个月餐饮花了多少" → `report_by_category` 或 `tx_list({ type:"EXPENSE", category:"餐饮", from, to })`；"2026 年全年明细" → `tx_list({ year:2026 })`。
4. **多维透视**："按账户/成员/商家/项目看看收支" → `report_overview({ from, to })`，取对应维度数组。
5. **报表/看板**：`dashboard_build` 生成网页看板并用 `present_files` 打开；如需 Excel/PPT/Word 再调用 `workbuddy-sheet-generation` / `workbuddy-pptx` / `workbuddy-docx` 处理返回数据。
6. **首次迁移 / 期初分类**：`import_from_mylife({})` 从 MyLifeOS 只读全量导入历史（不反向写回，避免破坏同步）。仅拉取期初基础数据时用 `import_from_mylife({ scope:"categories" })`（只导账户+分类）。多用户时用 `import_from_mylife({ userId:"octop_user_123" })` 把数据归属到指定用户。

## 注意事项
- 金额一律用正数，方向由 `type` 决定。
- 日期用 ISO（`YYYY-MM-DD`）；要时分秒就给 `time:"14:32:05"`，或直接传完整时间戳。
- **改账户余额前先分口径**：`account_update` 传 `balance` 会按差额补一笔「余额调整」流水（账实始终一致）；只想改期初不留痕迹，传 `adjustBalance:false`。用户说"卡里实际是 1500"属于前者，"期初填错了"属于后者。
- 看板为生成时刻快照；实时交互请用本地工作台。
- 预算/应收等仅本地维护；与 MyLifeOS 主库不共享。
- 多用户：同一用户下账户名/分类名唯一；跨用户可重名，数据按 `user_id` 完全隔离。
- **分类名在同一收支类型下全局唯一**：一个二级分类只能属于一个一级分类，「食品酒水/三餐」和「居家生活/三餐」不能并存；`category_add` / `category_update` 撞名会直接报错（报错里写明撞到了哪个、挂在谁下面），一级与二级同名同样拦，二级下面不能再挂子级。
- 导入 Excel 遇到同名分类会**归一到已存在的那个**，不新建也不报错；历史遗留的重名用 `category_duplicates` 查出 `same-name` 组，再 `category_merge` 合并。
- 删除有引用的对象（账户下还有交易、分类还被引用）会被**拒绝**，这是保护不是故障；先把引用改到别处再删。
