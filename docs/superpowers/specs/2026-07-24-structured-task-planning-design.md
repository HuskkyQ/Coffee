# Coffee 结构化任务规划设计

日期：2026-07-24

## 1. 目标

为 Coffee 增加模型中立、可持久化、可验证的结构化任务计划。

复杂任务由模型自动创建计划，简单问答和单步操作不创建。计划跟随
当前 Session 保存到现有 SQLite 历史数据库，并通过 Planning 工具在
现有模型工具循环中更新。

第一版建立稳定的计划协议和状态机，不实现自动选择下一步骤的上层
执行 Loop。

## 2. 已确认的产品行为

- 采用模型中立的 Planning 工具方案。
- 复杂任务自动创建计划，不要求用户先输入命令。
- 每个 Session 最多一个当前计划。
- 计划创建后立即执行安全步骤。
- HITL 只出现在关键歧义、高风险操作、重大重规划和连续失败等节点。
- `/plan` 查看当前计划。
- `/plan cancel` 取消当前计划。
- 两个命令只在模型轮次之间使用。
- 模型执行期间自动显示计划进度，不支持并发输入 `/plan`。
- 计划使用 Codex 风格单行动态状态；非 TTY 降级为追加式文本。
- 计划状态立即持久化，`Ctrl+C` 不回滚已经保存的状态。

## 3. 非目标

第一版不实现：

- 自动调度下一步骤的上层 Loop。
- 本地语义规则强制判断一个任务是否复杂。
- 多个并行当前计划。
- 计划历史列表和历史计划恢复。
- 用户手动增加、删除、跳过或重排步骤。
- 模型运行期间的并发 `/plan` 输入。
- 不同 Planner 模型或额外 Planner 请求。
- 结构化规划之外的 RAG、长期知识库或多 Agent 调度。

## 4. 方案选择

### 4.1 采用方案

将计划能力实现为三个 RegisteredTool：

- `create_plan`
- `update_plan`
- `finish_plan`

工具由 Coffee 本地校验和执行，不绑定 DeepSeek 或任何特定模型协议。
模型通过现有工具调用循环创建和更新计划。

三个工具的风险等级为 `write`，因为它们会修改 Coffee 的本地计划状态；
但它们不修改用户工作区，也不单独触发确认。计划步骤中的实际副作用仍
由 read、edit、write、shell 等现有工具按各自策略处理。

### 4.2 未采用方案

不从普通回答文本或 Markdown 中提取 JSON 计划。该方式容易受流式分块、
解释文字和不同模型输出习惯影响。

不在第一版增加独立 Planner 请求。额外请求会增加成本、等待时间和
Planner 与执行模型之间的一致性处理。

## 5. 模块边界

新增：

```text
src/planning/
├── types.ts
├── state.ts
├── store.ts
├── manager.ts
├── tools.ts
└── render.ts
```

### 5.1 `types.ts`

定义计划、步骤、状态、Planning 工具参数和持久化结果的公共类型。

### 5.2 `state.ts`

实现纯状态机：

- 参数快照和运行时结构校验。
- 步骤依赖与循环检测。
- 状态转换。
- 完成条件。
- 重试和重规划边界。

该模块不访问 SQLite、终端或模型。

### 5.3 `store.ts`

封装 Planning 表的 SQLite 编解码和语句。它使用 HistoryStore 持有的
同一个数据库连接，不创建第二个连接。

需要跨 Session 与 Plan 的操作由 HistoryStore 在一个事务中协调，避免
先创建 Session、后创建计划时只成功一半。

### 5.4 `manager.ts`

把 Planning 状态绑定到当前 Session：

- 读取当前计划。
- 创建计划并确保新 Session 已持久化。
- 原子更新计划。
- 完成和取消计划。
- 在 `/new`、`/sessions` 和删除 Session 时切换当前计划。

### 5.5 `tools.ts`

注册三个模型工具并把结构化结果返回模型。工具只调用 PlanManager，
不直接访问数据库或 CLI。

### 5.6 `render.ts`

生成：

- `/plan` 完整视图。
- 计划创建摘要。
- 当前步骤单行进度。
- blocked、failed、completed 和 cancelled 的稳定文案。

## 6. 数据模型

```ts
export type TaskPlanStatus =
  | "active"
  | "blocked"
  | "completed"
  | "cancelled";

export type TaskStepStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "superseded";

export interface TaskPlan {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly status: TaskPlanStatus;
  readonly revision: number;
  readonly steps: readonly TaskStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskStep {
  readonly id: string;
  readonly title: string;
  readonly successCriteria: string;
  readonly status: TaskStepStatus;
  readonly dependsOn: readonly string[];
  readonly retryCount: number;
  readonly result?: string;
  readonly blockReason?: string;
}
```

`superseded` 是 `replace_pending_steps` 的内部结果，不是用户手动跳过。
它保留被重规划步骤的历史，同时允许 `finish_plan` 判断新计划路径。

### 6.1 大小限制

- goal：1–1000 个 Unicode code point。
- 每个计划：2–12 个步骤。
- step id：1–64 个 ASCII 字母、数字、`-` 或 `_`。
- title：1–120 个 Unicode code point。
- successCriteria：1–300 个 Unicode code point。
- result 和 blockReason：最多 1000 个 Unicode code point。
- 每个步骤最多依赖 12 个步骤。
- 自动重试记录最多 3 次；第一版不自动触发重试。

输入必须是普通 JSON 数据对象和数组。访问器、污染原型、继承字段、
稀疏数组和额外字段均拒绝。

## 7. SQLite Schema V2

历史数据库版本从 1 升级到 2：

```sql
CREATE TABLE task_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE
    REFERENCES sessions(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'blocked', 'completed', 'cancelled')),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_steps (
  plan_id TEXT NOT NULL
    REFERENCES task_plans(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'pending', 'in_progress', 'blocked',
        'completed', 'failed', 'superseded'
      )
    ),
  depends_on_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  result TEXT,
  block_reason TEXT,
  PRIMARY KEY (plan_id, id),
  UNIQUE (plan_id, position)
);
```

迁移要求：

- V1→V2 在一个事务中执行。
- 迁移失败时保留原数据库内容和 `user_version=1`。
- 继续拒绝版本高于当前支持版本的数据库。
- 新表沿用现有 WAL、foreign_keys、busy_timeout 和文件权限策略。
- 删除 Session 时通过外键级联删除计划和步骤。

第一版只保留当前计划。已完成或取消的计划继续供 `/plan` 查看；创建
下一个计划时，在同一事务中替换旧计划及其步骤。

## 8. 新 Session 的即时持久化

现有 `/new` 保持懒创建：仅执行 `/new` 不产生数据库 Session。

如果一个尚未持久化的新 Session 调用 `create_plan`：

1. 使用计划 goal 生成 Session 标题。
2. 使用当前已选择的 provider 和 model 创建零 turn Session。
3. 设置该 Session 为 active。
4. 在同一事务中创建计划和步骤。
5. 更新 SessionManager 的当前 Session identity。

因此，计划创建后即使当前模型轮次被 `Ctrl+C` 取消，用户仍可输入
`/plan` 查看计划。该 Session 虽然暂时没有 turn，但包含计划，不属于
无内容的空 Session。

Agent 只允许 `create_plan` 触发这一次受控的 Session identity 刷新。
其他工具在回答期间改变 Session 仍按现有规则拒绝。

## 9. 状态机

### 9.1 计划状态

- 创建后为 `active`。
- `block_step` 后为 `blocked`。
- `resume_step` 后恢复为 `active`。
- `finish_plan` 验证成功后为 `completed`。
- `/plan cancel` 后为 `cancelled`。

`completed` 和 `cancelled` 为终态，不能继续更新。

### 9.2 步骤转换

允许：

```text
pending     -> in_progress
in_progress -> completed
in_progress -> failed
in_progress -> blocked
blocked     -> in_progress
failed      -> in_progress
pending     -> superseded
failed      -> superseded
```

规则：

- 同时最多一个 `in_progress`。
- 依赖步骤必须为 `completed` 或 `superseded` 才能开始。
- `completed` 不能回退。
- 从 `failed` 重试会增加 retryCount，超过 3 次必须 block、replan 或取消。
- `superseded` 只能由 `replace_pending_steps` 产生。
- `finish_plan` 要求不存在 pending、in_progress、blocked 或 failed 步骤。
- 至少一个步骤必须为 completed，不能用全部 superseded 完成计划。

## 10. Planning 工具

### 10.1 `create_plan`

输入：

```json
{
  "goal": "修复类型错误并通过测试",
  "steps": [
    {
      "id": "inspect",
      "title": "定位类型错误",
      "successCriteria": "获得明确的 tsc 报错位置",
      "dependsOn": []
    },
    {
      "id": "verify",
      "title": "修复并验证",
      "successCriteria": "npm run check 退出码为 0",
      "dependsOn": ["inspect"]
    }
  ]
}
```

当前存在 active 或 blocked 计划时拒绝创建。当前计划为 completed 或
cancelled 时，新计划事务性替换旧计划。

### 10.2 `update_plan`

输入包含：

- planId
- expectedRevision
- action
- 与 action 对应的 stepId、result、reason 或 steps

动作：

- `start_step`
- `complete_step`
- `fail_step`
- `block_step`
- `resume_step`
- `add_steps`
- `replace_pending_steps`

运行时按 action 校验必需和禁止字段，不依赖 JSON Schema 的复杂
`oneOf`，保证 OpenAI-compatible provider 兼容性。

`replace_pending_steps` 可把 pending 或 failed 步骤标记为 superseded，
但不能修改 completed、in_progress 或 blocked 步骤。新步骤必须重新
通过依赖和循环检查。

### 10.3 `finish_plan`

输入：

- planId
- expectedRevision
- summary

只有状态机完成条件满足时才把计划设为 completed。模型不能仅凭文字
声称完成。

三个工具均检查 AbortSignal 后再开始同步事务。事务开始后不可中途
取消；成功提交的状态不会因随后发生的 AbortError 回滚。

## 11. 复杂任务判断

使用混合规则：

- 判断由模型负责。
- 系统提示明确要求以下任务必须先创建计划：
  - 多文件修改。
  - 多个不同工具。
  - 修改后需要测试或类型检查。
  - 存在明显步骤依赖。
  - 需要调研、比较、实现和验证的组合任务。
- 简单问答、翻译、单次读取和单步计算不创建计划。

第一版不在本地语义层强制拦截模型遗漏计划。该强制能力属于后续
上层 Loop。

## 12. 执行数据流

```text
用户复杂任务
  -> 模型 create_plan
  -> PlanManager 原子保存 Session + Plan
  -> CLI 显示计划摘要
  -> 模型 update_plan(start_step)
  -> 现有 read/edit/shell/search 等工具
  -> 模型依据真实结果 complete/fail/block
  -> 下一步骤
  -> finish_plan
  -> Coffee 验证并持久化 completed
  -> 模型给出最终答复
```

工具失败后，模型必须先更新当前步骤，再继续调用其他执行工具。系统
提示要求只有工具返回明确成功、Shell `exitCode` 为 0 或完成条件有其他
可验证证据时，才能 `complete_step`。

## 13. HITL

不在计划创建时统一暂停。

以下节点触发 HITL：

- 需求存在会改变结果的关键歧义。
- 现有工具策略要求确认的高风险操作。
- 计划范围发生重大变化。
- 步骤重试耗尽或无法继续。
- 需要新权限、外部协调或超出原任务范围。

结构化流程：

```text
update_plan(block_step)
  -> Plan status = blocked
  -> 模型向用户提出一个明确问题
  -> 本轮结束
  -> 用户回答
  -> update_plan(resume_step)
  -> Plan status = active
```

Shell 和写文件工具原有的逐次确认保持不变。用户拒绝后，模型根据结果
调用 fail_step、block_step 或 replace_pending_steps。

## 14. CLI 命令

### 14.1 `/plan`

显示当前 Session 的计划：

```text
计划：修复类型错误并通过测试
状态：进行中 · 2/4

✓ 1. 定位类型错误
◐ 2. 修改相关代码
○ 3. 运行测试
○ 4. 汇总结果
```

没有计划时显示：

```text
当前会话还没有任务计划。
```

### 14.2 `/plan cancel`

仅在输入轮次之间使用。命令本身已明确表达取消意图，因此不增加第二次
确认。它只取消计划，不删除对话历史和 Session。

active 或 blocked 计划可取消。completed、cancelled 或无计划时返回稳定
中文提示，不改变数据库。

### 14.3 Session 行为

- `/new` 切换到无计划的懒 Session。
- `/sessions` 恢复所选 Session 的当前计划。
- 删除 Session 级联删除计划。
- 切换模型不改变计划。
- 模型运行期间不接收 `/plan` 或 `/plan cancel`。

## 15. Codex 风格进度动画

TTY 示例：

```text
✓ 1/4 分析项目结构 · 1.2s
☕ 2/4 [█████░░░░░] 50%  ◐ 正在修改代码 · 2.4s
```

规则：

- 已完成步骤只保留一条静态记录。
- 只有当前步骤使用动态状态行。
- 动画帧使用 `◐ ◓ ◑ ◒`。
- 进度按 completed 与 superseded 的步骤数计算；superseded 使用不同
  标记，不伪装为成功。
- blocked 使用暂停文案，failed 使用失败文案。
- Shell 输出、HITL、确认提示和模型正文出现前暂停并清理动态行。
- 不使用多行光标回退重绘完整 Checklist。
- 动画复用现有 Activity Renderer 生命周期。
- 咖啡主题读取 `/like` 的 americano 或 latte 偏好，只影响小型图标或
  配色，不绘制大型咖啡帧。
- 非 TTY 和日志环境降级为追加式文本，不输出 cursor ANSI。
- 动画或 Output.write 抛错时停止动画，但不回滚计划状态。

## 16. 错误与并发处理

- 所有 Planning 参数在数据库事务前完整校验。
- 任何非法状态转换均不写入部分数据。
- expectedRevision 不匹配返回稳定冲突错误。
- 两个 Coffee 进程同时更新同一计划时只有一个成功。
- SQLite busy_timeout 和 WAL 沿用历史数据库设置。
- 读取损坏的计划记录时拒绝渲染，不猜测或修复原数据。
- 工具结果和错误不回显超长、不可信原始参数。
- goal、title、result、reason 在 CLI 边界再次做终端清洗。
- `/plan cancel` 与 Planning 工具共享同一 PlanManager 锁，拒绝重入。
- Session 在模型执行期间被外部切换时，沿用现有 Session identity
  冲突保护。

## 17. Agent 提示

Workspace 系统提示增加：

- 复杂任务必须先调用 create_plan。
- 创建计划后再执行写文件或 Shell 工具。
- 每个步骤执行前 start_step。
- 只有满足 successCriteria 后 complete_step。
- 工具失败必须 fail、block 或 replan，不能跳过状态更新。
- 关键歧义先 block，再向用户提问。
- 全部步骤满足后调用 finish_plan。
- 简单问答不要创建计划。
- 不向用户暴露模型隐藏推理，只展示任务步骤和可验证状态。

## 18. 测试策略

### 18.1 状态机

- 2 和 12 步边界。
- 重复 ID、未知依赖、自依赖和依赖环。
- 所有允许和禁止状态转换。
- 同时两个 in_progress。
- retryCount 边界。
- replace_pending_steps 与 superseded。
- finish_plan 完成条件。
- getter、Proxy、污染原型和稀疏数组。

### 18.2 SQLite

- 新数据库直接创建 V2。
- 真实 V1 数据库迁移到 V2，原 Session、turn 和 summary 不变。
- 迁移失败不提升 user_version。
- Session 与 Plan 一对一。
- 删除 Session 级联删除步骤。
- revision 冲突和多连接更新。
- 立即创建零 turn Session 与计划。
- completed/cancelled 计划的事务性替换。
- 文件权限和 close 行为不回归。

### 18.3 工具

- 三个工具的模型中立定义和风险等级。
- create、start、complete、fail、block、resume、replan 和 finish。
- 缺失、额外和错误类型参数。
- AbortSignal 和普通错误边界。
- 简单任务 fixture 不调用 create_plan。

### 18.4 Agent 与 Session

- 复杂任务第一轮先 create_plan。
- 工具结果进入后续模型轮次。
- Shell 成功和失败分别更新正确状态。
- HITL block、用户回答和 resume。
- `/new`、`/sessions`、模型切换和 Session 删除。
- Ctrl+C 后恢复最后已持久化状态。
- 新 Session create_plan 后中断仍可 `/plan`。

### 18.5 CLI 与动画

- `/plan` active、blocked、completed、cancelled 和无计划。
- `/plan cancel` 的所有状态。
- TTY 动态行只出现一次并正确固定。
- 非 TTY 追加式降级。
- Shell、HITL 和流式正文前暂停动画。
- americano 与 latte 偏好。
- 动画回调异常不影响计划状态。
- 无重复文案、readline 堆栈或 cursor 残留。

### 18.6 完整回归

- `npm test`
- `npm run check`
- 现有 Shell、代码编辑、历史 Session、流式输出和 CLI 测试全部通过。
- 无真实模型、网络或包仓库调用。
- 无 fixture、PID、marker 或 SQLite 临时文件残留。

## 19. 验收标准

- 复杂任务可通过模型工具创建结构化计划。
- 简单问答不创建计划。
- 计划和步骤状态经过本地状态机验证。
- 计划在 Session 中立即持久化，Ctrl+C 后可查看。
- `/plan` 和 `/plan cancel` 工作且只在轮次之间使用。
- HITL 能 block 并在用户回答后 resume。
- 完成前必须通过 finish_plan 的本地验证。
- TTY 显示单行动态进度，非 TTY 稳定降级。
- Session 切换、删除和 SQLite V1→V2 迁移正确。
- 不实现或暗示上层自动 Loop 已完成。
- 全量测试和 TypeScript 检查退出码为 0。
