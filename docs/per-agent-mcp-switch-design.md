# dsh-mcp-manager：全局开关 + 各预设开关 — 实现方案

> 状态：**范围已拍板，进入实现**。L3 与 v2 经用户确认取消（§7），单一阶段交付
> = L1（现状）+ L2（预设可见性矩阵）。矩阵落点定为 profile 目录 JSON 边文件
> （`dirname(patchFile)/mcp-manager.policy.json`），零未知 API；日后若需要宿主
> settings 通道可无痛迁移（读写集中在 `policy.ts`）。

本文引用的宿主机制均已在安装包（`app.asar`，DSH 0.2.2-rc.1）中逐条验证：
`@deepseek-ai/cordis-plugin-include`（patch 方言）、`@deepseek-ai/dsh-agent-preset` 与
`dsh-agent-preset-registry`（预设组合）、`@deepseek-ai/dsh-agent` README（Agent 作用域）、
`cordis-plugin-development` 技能中的 `cordis-composition-reference`（扩展点强弱次序）。

---

## 1. 语义结论先行

**`disabled: true` 是组合层（composition）机制，只作用于"本条 entry 自身"。**

| 写法 | 实际效果 |
|---|---|
| profile 补丁层根行 `- id: mcp-webdav, disabled: true` | 关**全局**连接（现状行为，HMR 热生效） |
| `dsh-agent-preset` 声明行 `{ id: preset-std, ..., disabled: true }` | 关**整个预设**（预设从 roster 消失，会话不可选） |
| 预设 `config.plugins` 里写一行同 id 的 `disabled: true` | **关不掉全局行**。全局行在宿主树，预设行在预设自己的 `PresetTree`——两个独立条目，补丁解析只索引"本组合层内的 entry"（`applyPatches` 的 `entryMap` 由当前 include 数据构建），不存在跨树"负引用" |

所以"默认全局开启 + 个别预设关闭"的**减法语义在组合层无处安放**。
宿主为它准备的是另一层机制，官方原话（cordis-composition-reference，扩展点由弱到强）：

> `ctx.tools.restrict()` can only remove tools … **Hiding tools from one agent is
> `ctx.tools.restrict()` on that agent's context; it keeps schema presentation,
> lookup, and execution aligned.**

以及 Agent README：

> `Agent.ctx` is the agent's scoped context: registrations made through it (tools,
> prompt sections, variables, event listeners, **restrictions**) apply to that agent
> alone … The same mechanism is what **agent presets** use to give one session a
> different capability set without affecting its neighbors.

**结论：预设开关 = 可见性层（scoped restrict），全局开关 = 组合层（row disabled）。
两层各管各的，正交。** 同仓库先例：dsh-ops 的 `hide-official` 就是对 Agent 作用域发
`restrict({ deny })`，模式成熟可对齐。

---

## 2. 三层模型

| 层 | 机制 | 语义 | 生效时机 | 阶段 |
|---|---|---|---|---|
| **L1 全局开关** | 现状不动：profile 补丁层行级 `disabled` | 连接层面开/断（stdio 子进程、HTTP 会话随之起停） | HMR 热生效（全体） | 已有 |
| **L2 预设开关（核心新增）** | `agent.ctx.tools.restrict({ deny: mcp__<server>__* 展开名 })`，按策略矩阵对每个 Agent 作用域装配掩码 | 该预设的 Agent **看不见、调不到**；连接仍由全局行持有（共享一条） | **热**：拨开关即对存量+新建 Agent 重新 reconcile（工具集本就每回合重组） | v1 |
| **L3 预设专属服务器（可选）** | 行放进 preset 声明的 `config.plugins`（组合层，加法/白名单） | 连接实例**只存在于该预设的代际**：不进该预设 = 不启动进程 | 新组合生效（live Agent 组合按设计保持稳定）；需 patch.ts 支持嵌套行 | v1.1+，见 §7 |

矩阵默认值：**开**（全局行 active ⇒ 每个预设默认可见）。关掉一格 = 该预设掩码。
这正好等于你预期的"默认全局开启，预设级别关闭"。

### L2 与 L3 怎么选（给 UI 的文案依据）

- 只是想"某个 agent 别用这个服务器" → **L2**（一条连接大家共享，成本最低，热切换）。
- 想"某服务器只允许某个 agent 用、其他场合连进程都不起"（安全/资源诉求）→ **L3**。
- L1 关掉时矩阵整行隐藏（无连接可掩）。

### L3 的实例与生命周期账目（宿主语义，已验证）

- **按预设共享，不按会话**：`PresetTree` 原文即 "Runtime plugin trees shared by
  Agents selecting one preset revision"——组合同一预设的所有 Agent（含其子代理）共用
  一棵树 ⇒ 预设内一行 stdio 只有 1 个子进程。
- **跨预设各一份**：同名服务器出现在 N 个预设的 `plugins` ⇒ N 份独立实例（各自
  initialize、各自凭据/端口）；若全局行同名字面并存，再加 1 份且**工具命名空间会撞**
  （见下）。
- **按需挂载、引用计数回收**：开机时 preset 只是声明数据（gateway："reading never
  mounts a preset"）；第一个选择它的 Agent 才挂树 spawn；最后一个使用者释放后世代
  回收、子进程随树处置。无人使用期间零成本。
- **进程数 = 含该行且"当前有人用"的预设数。**
- 设计红线两条：
  1. 有单例副作用的服务器（文件锁/写前日志/限并发远端账号/固定监听端口）**不得**用
     L3 跨预设复制——这类只能走 L2；
  2. serverName 唯一性在 v1.1 改为"**全局作用域 + 该预设**"成对检查（会话工具面 =
     宿主树 + 所组合预设树合并；不同预设之间允许同名，因为它们不会出现在同一会话）。

---

## 3. 数据结构增量（`src/shared.ts`）

```ts
/** 预设身份，来自 agentPresets.compositionInventory()。 */
export interface McpPresetInfo {
  /** config.id，会话记录的预设标识 */
  id: string
  name?: string
  description?: string
  /** 未指名预设的会话是否组合它（roster 至多一个） */
  isDefault: boolean
  /** 预设声明损坏（带诊断，不可参与掩码编辑） */
  broken?: string
}

/** 策略矩阵一格缺省 = 开。false 才需要掩码，存储只记例外。 */
export type McpPresetPolicy = Record<string /* serverId */, Record<string /* presetId */, boolean>>

export interface McpServerInfo extends McpServerConfig {
  // …既有字段不变…
  /** 各预设的期望可见性（已含默认 true；缺格 = true） */
  presetPolicy?: Record<string, boolean>
}
```

端点枚举追加：`'presets'`（roster 读取）、`'setPresetEnabled'`（矩阵一格）。
新错误码：`preset-not-found`、`agent-presets-unavailable`。

`entryIdTaken` / `serverNameTaken` 校验不变——L2 不新增条目，重名规则与现状完全一致。

---

## 4. 持久化

矩阵是**运行时策略**，不是组合定义：**不写 `cordis.patch.yml`**（保持补丁文件=组合真相、
手改友好的现有契约）。**已拍板落点**：`dirname(patchFile)/mcp-manager.policy.json`
（profile 作用域、随 profile 备份、零未知宿主 API）。读写集中在 `policy.ts`，日后若
要迁到宿主 settings 命名空间是无扩散改动。

L3（若做）才引入组合层写：preset 声明行嵌套行编辑（补丁方言原生支持：
`applyPatches` 递归索引 `group` 子条目、按 id 覆盖任意键含 `disabled`）。

---

## 5. L2 运行时流程

```
                    ┌─ 启动/补丁变更/SSE tick ──────────────┐
                    │                                       │
 ctx.get('agentPresets')?.compositionInventory()   读策略矩阵
                    │                                       │
                    ▼                                       ▼
             roster（预设清单） ────────────► 期望掩码表: presetId → deny 名字集合
                                                      │
  事件源（全部汇入同一 reconcile）：                    │
   · Agent 创建/销毁（agents 服务 + 生命周期事件）      │
   · 预设切换（recompose/select 后宿主 emit tools/change）
   · 桥工具表更新（tools/change）                       │
   · 矩阵写入（面板动作）                               │
                                                      ▼
 reconcile():
   for agent of liveAgents:
     presetId = agentPresets.composedPreset(agent.ctx) ?? DEFAULT
     lift = 旧掩码(agent)                     // entries: Map<agent, {lifts}> 模式，同 dsh-ops
     deny = flatten(矩阵中 presetId 为 false 的行 → 该 agent 作用域内
                    按前缀 mcp__<serverName>__ 枚举 tools.schemas(agent) 展开)
     变化时: lift.dispose(); agent.ctx.tools.restrict({ deny })
```

要点（均已在宿主/先例中验证）：

1. **deny 列表要展成具体工具名**（`restrict` 收名字数组）；桥随后新增工具由 `tools/change`
   触发 reconcile 兜住，不做通配符假设。
2. **只能掩继承来的工具，不能掩本作用域注册的**（dsh-ops L106 的自检）——全局行注册在
   宿主作用域，Agent 作用是继承层，正好合法。
3. **presentation/lookup/execution 三者一致**是官方承诺：不是"只藏 schema"，调用面同步关闭。
4. 子代理：`composeFrom` 继承父代际 → 天然命中同一 presetId；子代理另选预设
   （`select` 于首轮前）由同一 reconcile 覆盖。teammate 独立会话按自己的 preset 计算。
5. 未装 `agentPresets` 的部署：`ctx.get` 得 undefined → 面板隐藏矩阵列，行为退化为纯现状
   （优雅降级，无新故障面）。
6. ACP 外部会话（`session/new` 自带 `mcpServers`）不在矩阵管辖内，文档与 UI 注明。

---

## 6. RPC 面增量（`src/index.ts` dispatch）

| 端点 | payload | 返回/行为 |
|---|---|---|
| `presets` | — | `{ presets: McpPresetInfo[] }`；服务缺席 → `agent-presets-unavailable` |
| `setPresetEnabled` | `{ id, presetId, enabled }` | 写矩阵（缺省格不物化 true/false 之外的值）→ 立即 reconcile + `channel.broadcast()` |
| `list` | — | `servers[].presetPolicy` 附带矩阵行投影 |
| `remove` | 现状 | 顺带清理该行矩阵格（孤儿格忽略） |

SSE 事件通道零改动：面板写操作直接 `broadcast()`；tick 签名只覆盖 `listMcpServers` 的 L1 投影（不含 presetPolicy），**手改 policy 边文件不会触发推送**，面板与掩码在下一个宿主事件或面板操作时自然对齐。

---

## 7. 分期与复杂度（已按拍板收敛）

| 期 | 内容 | 估计 | 状态 |
|---|---|---|---|
| **v1（唯一阶段）** | L2 矩阵 + Agent 观察/reconcile + JSON 边文件 + UI 矩阵列 + i18n + 测试 | **1.5–2 人日** | 实施中 |
| ~~v1.1 L3 预设专属行~~ | 组合层嵌套行编辑 | — | **已取消**（用户拍板：接受 L2 的共享连接语义即可） |
| ~~v2 接管出货预设~~ | 快照复制 + 遮蔽警告 | — | **已取消**（随 L3 失去存在意义；L2 一律覆盖出货/自建预设） |
| **v1.2 三面收敛补丁** | `prompt-align.ts`：P1 剥 `mcp:<server>` instructions 段、P2 过滤/删 `mcp-resource-servers` 名册段、P3 pre-execute 守卫三个资源元工具——让"隐藏"在 schema/提示词/执行三面一致 | 0.5 人日 | ✅ 已交付（95/95，含身份回归守卫） |

取消 L3 的连带收益：不碰 `patch.ts`；serverName/entryId 校验规则零改动；
不需要嵌套行状态投影与声明行 id 发现；无快照漂移债。

---

## 8. UI（已按用户反馈收敛为极简一行）

```
┌ 服务器卡片：Cycani ── 9 个工具 · STDIO ──── 全局开关 [on] ┐
│  标准模式 [on]  PTC 模式 [on]  极简模式 [on]  创造模式 [on]   │
└──────────────────────────────────────────────────────────┘
```

- 一行紧凑 flex（gap 14，窄卡自动换行兜底）；**只有模式名 + 开关**，无标签、无徽标、无说明行。
- 语义说明收进整行 tooltip（"关掉 = 该预设的 Agent 看不到此服务器的工具；连接为全局共享"）；L1 关闭时整行隐藏。
- 出货预设按 id 字典本地化为 GUI 官方名（标准/PTC/极简/创造模式）；自建预设显示发布名，缺名回落 id（registry 拒绝重复 id，自建不可能冒充出货 id）。
- 默认预设不再显式标注——它只是"未指名会话读取的那一列"，tooltip 已覆盖语义。

---

## 9. 测试计划

- 单测（沿用 `test/` node:test 三件套风格）：
  - `policy.ts`：矩阵读写、缺省语义、remove 清格；
  - `mask.ts`：前缀展开、presetId 解析（含 default 回落）、reconcile 幂等
    （快照比对，防 dsh-ops 同款 publication/withdrawal 反馈环）、lift 释放；
  - 路由契约：新端点参数/错误码。
- 实盘清单（需真实 DSH 跑一轮）：
  1. 两个不同预设的会话并行，一格 off → 只有对应 agent 的工具集少掉 `mcp__*`，另一会话不变；
  2. 拨开关热测：进行中会话下一回合即见/即隐；
  3. 子代理 spawn/fork 继承与另选预设两种路径；
  4. 桥断连重连（tools/change 风暴）后掩码不丢不重；
  5. 卸载 `agentPresets` 场景降级无报错。

## 10. 确认项（已全部拍板）

1. 矩阵落点：**profile 目录 JSON 边文件** `dirname(patchFile)/mcp-manager.policy.json`；
2. L3：**取消**；
3. v2 接管出货预设：**取消**。

## 11. 实现锚点（对宿主 API 的已验证事实，写码者无需再考古）

| 表面 | 形状（已在安装包/dsh-ops 先例验证） |
|---|---|
| Agent 生命周期 | `ctx.on('agent/created', ({ agent }))` / `ctx.on('agent/disposed', ({ agent }))`；开机补挂 `ctx.get('agents')?.list?.()` |
| 每 Agent 作用域掩码 | `agent.ctx.tools.restrict({ deny: string[] })` → 返回 lift（函数或 `{ dispose() }`，双形态安全释放）；只能掩**继承来**的工具，宿主承诺 presentation/lookup/execution 一致 |
| 按作用域枚举工具名 | `ctx.get('tools').schemas(agent)` → `{ name }[]`，前缀 `mcp__<serverName>__` 展成具体名单 |
| 预设身份 | `ctx.get('agentPresets')?.composedPreset(agent.ctx)` → preset id；undefined（无预设组合）⇒ 不做掩码 |
| Roster | `await ctx.get('agentPresets').compositionInventory()` → `{ id, name?, description?, isDefault, broken?, rows }[]`——**返回 Promise，必须 await**（2026-11-10 实盘教训：同步消费会让 TypeError 被降级路径静默吞掉，矩阵整体隐形而一切看似正常）；服务缺席 ⇒ 功能整体优雅降级 |
| 变更重对齐 | `ctx.on('tools/change', reconcile)`；预设 select/recompose 后宿主会 emit tools/change，无需额外订阅 |
| 幂等防环 | 快照比对后才动 masks（防 publication/withdrawal 反馈环，dsh-ops 同款教训） |
| "隐藏"的唯二判定 | `hiddenServerNames`（visibility.ts）是权威，`hiddenForScope` 的列探测（prompt-align.ts）是其镜像优化——`=== false` 哨兵任何改动必须两处同改，否则掩码与提示词/执行面分叉（2026-11-12 评审 keep 增补） |
| 提示词装配 waterfall | `ctx.on('system-prompt/assemble', async (assembly, context, next))`；payload = `{ sections, contexts, variables }`（**tools 由宿主在 waterfall 之后才拼回**，listener 里别依赖 `result.tools`）；section 对象跨作用域共享——**复制返回，绝不 mutate**。`context.scope` 是 **Agent 对象**（`assembleContextFor`：`{ agent, scope: agent }`，dsh-agent-loop 0.2.2-rc.1 asar 实证） |
| 预设身份的层级 | `composedPreset` 读的是**带作用域标签的 Context**（`ctx[kScope]`，dsh-scope）——即 `agent.ctx`，把 Agent 原样喂进去会得 undefined。**2026-11-12 实盘教训**：prompt-align 首版在 assemble 路径传了 Agent 本体，P1/P2 在真实宿主上整体静默失效，而 fake 测试因 composedPreset 无视身份全绿；回归守卫 = fake 必须身份绑定 |
| 桥 instructions 段 | `@deepseek-ai/dsh-mcp-client`（0.2.2-rc.1 server-context.js）每台连接服务器注册 `name: 'mcp:<serverName>'`，text=服务器 instructions；不受 tools.restrict 管辖 |
| 资源名册段 | `@deepseek-ai/dsh-mcp-resources`（0.2.2-rc.1）注册 `name: 'mcp-resource-servers'`（interpolate:false），text 头含**真实换行**、尾部内嵌 `JSON.stringify(names)` + `.`；名册为空整段缺席 |
| 资源元工具 | `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` 是**裸名**（不在 `mcp__<server>__*` 前缀内，掩码永不覆盖），execute 经 provider 注册表按作用域解析、与工具掩码无关；pre-execute 载荷的解析后参数在 **`exec.arguments`**（`@deepseek-ai/dsh-tools` types；`exec.args` 不存在） |
