---
name: mylife-finance
description: 个人财务记账与报表。当用户要记账、报一笔收支、查某月或某分类花了多少、看收支明细、管账户与预算、记应收应付、或要看财务看板时使用。支持自然语言记账，如「记一笔餐饮 88 元，用招行卡」。
---

# MyLife 财务记账

本技能背后已注册 MCP 服务 `mylife-finance`，工具直接可用，**不需要你启动任何进程或安装依赖**。

## 最重要的一条

**不要给任何工具传 `userId`。**

用户身份由 MCP 服务地址承载（每个用户/专家配自己的地址），服务端会强制覆盖你传的任何 `userId`。传了不会串数据，但纯属多余。

## 记账

用户说「记一笔 xxx 元」时调用 `tx_add`：

| 参数 | 说明 |
|---|---|
| `type` | `EXPENSE` 支出 / `INCOME` 收入 / `TRANSFER` 转账 |
| `amount` | 正数；方向由 type 决定 |
| `account` | 账户名，如「招行」「微信」；不存在会自动创建 |
| `category` | 分类名，可直接给二级（如「三餐」） |
| `description` | 说明；尽量填，日后靠它检索 |
| `date` | `YYYY-MM-DD`；不传为今天。要精确到时分秒就再给 `time:"14:32:05"` |
| `merchant` / `member` / `project` / `tags` | 可选，不存在会自动创建 |

例：`tx_add({type:"EXPENSE", amount:88, account:"招行", category:"三餐", description:"午餐"})`

转账用 `type:"TRANSFER"` 并给 `toAccount`。

## 查账

- 某月某类花了多少 → `report_by_category({type:"EXPENSE", from:"2026-11-01", to:"2026-11-30"})`
- 拉明细 → `tx_list({type:"EXPENSE", category:"食品酒水", from, to})`
- 只看某一年 → `tx_list({year:2026})`；只查说明里含某个词 → 加 `q`
- 月度收支汇总 → `report_monthly({year:2026, month:11})`
- **多维透视**（收入/支出分别按分类、账户、成员、商家、项目）→ `report_overview({from, to})`，
  要饼图数据就取 `incomeByCategory` / `expenseByCategory` / `byAccount` 等字段；四个维度每项都带 `income` 与 `expense`，想拆「收入榜 / 支出榜」就各取一个字段

**传一级分类会自动包含其下全部二级分类**，所以「食品酒水」能查到「三餐」的交易。
用 `categoryId` 过滤同理，效果和传一级名称一致。

## 分类是两级的

顶级（食品酒水、行车交通…）下有二级（三餐、打车…）。
- **分类名在同一收支类型下唯一**：一个二级分类只能属于一个一级分类，不能同名挂两处
- 记账给二级更准；统计给一级自动汇总子树
- 不确定有哪些分类，先 `category_list` 看一眼
- 记账填了不存在的分类名会**新建**分类，所以不确定时先查再填
- 撞名会被拒（`category_add` / `category_update` 都拦），报错里会说清撞到了哪个、挂在谁下面

## 预算

- 预算只挂**一级分类**
- `report_budget({year, month})` 看预算 vs 已用；`month:"all"` 看全年
- 同分类的月预算会出现在该分类年预算的 `children` 里

## 其他常用

| 想做什么 | 工具 |
|---|---|
| 账户增改删 | `account_add` / `account_update` / `account_delete` |
| 改账户余额 | `account_update({id, balance: 新余额})` —— 会自动记一笔「余额调整」流水 |
| 应收应付 | `receivable_add` 等 + `report_receivables` |
| 清理重复分类 | `category_duplicates`（只读）→ `category_merge` |
| 生成离线看板 HTML | `dashboard_build` |

> **改余额前先想清楚**：`account_update` 传 `balance` 不是静默改数字，而是按差额补一笔
> 「其他收入 / 其他费用」的调整流水（备注 `余额调整：原值 → 新值`），这样账实始终一致。
> 如果用户只是想把期初数字对齐、不要这笔流水，加 `adjustBalance:false`。
> 用户说「卡里的钱对不上，改成 1500」属于前者；说「期初填错了，重填一下」属于后者。

完整参数见 `references/tools.md`。

## 注意

- 金额一律正数，别给负号
- 日期统一 `YYYY-MM-DD`，别用「昨天」这类相对表达
- 删除有引用的对象（如账户下还有交易）会被**拒绝**，这是保护不是故障；先把交易改到别处再删
- 查询结果为空时，先回头确认日期区间和分类名拼写，再判断真的没有数据
- 用户问「这个月」时，先确认当前日期再换算区间，不要凭猜测
- **报 403「凭据与地址不符」不要重试**，也别改 `userId` 绕开 —— 这说明连接器地址里的用户名与 token 所属用户不是同一个人。请用户核对连接器的 URL 与令牌是否配套（管理员可在工作台 `/admin` 查看每人一把 token）。
- **报 401 未认证**通常是 token 被轮换或账号被停用，只能请管理员重新生成/启用；你自己无法恢复。
