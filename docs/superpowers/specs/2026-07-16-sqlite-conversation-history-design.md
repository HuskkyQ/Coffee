# Coffee SQLite 会话持久化与上下文压缩设计

日期：2026-07-16

## 背景

Coffee 当前只在 `Conversation` 进程内存中保存消息。CLI 退出后历史丢失，长对话也会把全部消息直接发送给模型，没有持久化会话、上下文预算或压缩策略。

本设计增加嵌入式 SQLite 历史库、会话命令和滚动摘要。SQLite 随 Coffee 进程直接读写，不需要启动独立数据库服务。

## 目标

- 把成功完成的用户、assistant、工具调用、工具结果和必要 reasoning 元数据持久化。
- 启动时自动恢复上次活动会话。
- 提供 `/new`、`/sessions`、`/delete` 管理会话。
- 每个会话记住最后使用的模型，同时保留现有全局默认模型。
- 达到软阈值时生成滚动摘要，超过硬阈值时只发送最近完整轮次。
- 任意失败、取消或并发冲突都不能留下半个回合。
- API Key 永远不进入历史库。

## 非目标

- 不增加 SQLite 服务进程、云同步或跨设备同步。
- 不实现会话重命名、搜索、导出或批量删除。
- 不删除被摘要覆盖的原始消息。
- 不把原始 reasoning 展示给用户。
- 不按精确 tokenizer 计数；首版使用可预测的字符预算。
- 不为每个模型维护不同的上下文窗口元数据。

## 用户体验

### 启动与恢复

数据库默认位于 `~/.coffee/history.sqlite`。启动时读取活动会话：

- 有活动会话时，恢复其全部持久化消息、最后模型和最新摘要，并显示简短的“已恢复会话”提示。
- 没有活动会话时，进入未持久化的空白会话，使用 `coffee.settings.json` 中的全局默认模型。
- 会话记录的模型不存在或缺少凭证时，仍允许查看和切换该会话；发送消息时明确要求 `/login` 或 `/model`，绝不静默换模型。

### `/new`

`/new` 立即离开当前会话并进入空白会话，同时把活动会话 ID 设为空。新会话使用全局默认模型。

空白会话采用延迟创建：只有首个回合成功生成且成功写入 SQLite 后，才创建 `sessions` 记录。重复执行 `/new`、直接退出、首轮失败或 Ctrl+C 都不会产生空会话。

### `/sessions`

`/sessions` 按 `updated_at` 从新到旧列出所有已持久化会话，展示：

- 当前会话标记。
- 标题。
- 平台和模型。
- 消息数量。
- 最后更新时间。

用户输入序号切换会话，Esc 取消。首版不在该菜单中提供删除或重命名。

### `/delete`

`/delete` 只删除当前持久化会话，并使用默认否定的确认提示。确认后级联删除 turns、messages 和 summaries，再进入新的延迟创建空白会话。空白会话执行该命令时提示“当前没有可删除的会话”。模型或工具请求进行期间不允许切换、新建或删除会话。

### 标题

会话标题取首条用户消息：转成单行、压缩连续空白、截取前 40 个 Unicode 字符。标题只在会话首次创建时生成。

### 模型

每个持久化会话保存 `provider_id` 和 `model_id`：

- 恢复或切换会话时使用该会话最后模型。
- `/model` 同时更新当前会话模型和 `coffee.settings.json` 的全局默认模型。
- 当前是空白会话时，`/model` 只更新内存中的待用模型和全局默认模型，不提前创建会话。
- `/new` 始终从全局默认模型开始。

## 架构

新增三个边界清晰的组件：

```text
CLI commands
  -> SessionManager：活动会话、延迟新建、切换、删除、模型更新
     -> HistoryStore：SQLite schema、迁移、事务、查询、权限

Conversation
  -> ConversationContext：字符预算、完整轮次选择、滚动摘要
  -> SessionManager.commitTurn()：成功回合的原子持久化
```

### `HistoryStore`

负责打开数据库、迁移、SQLite 配置、短事务、行与领域对象之间的序列化，以及关闭连接。上层不接触 SQL。

### `SessionManager`

持有当前会话快照和期望的 `revision`，提供：

- 恢复活动会话。
- 进入延迟空白会话。
- 列出和切换会话。
- 删除当前会话。
- 更新当前模型。
- 原子提交成功回合。

### `ConversationContext`

负责把系统提示、滚动摘要、已提交完整轮次和当前回合组装为模型消息。它只做上下文选择和摘要编排，不执行 SQL。

## SQLite 方案

### 驱动

使用 `better-sqlite3`。Coffee 的数据库操作短小且本地，同步事务可以保持实现简单；所有调用仍封装在 `HistoryStore` 中，以免驱动细节扩散。

当前 Node.js 22 的 `node:sqlite` 会打印实验性功能警告，因此本版本不使用它。

### 数据库配置

每次打开连接后设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

`~/.coffee` 目录权限为 `0700`；主数据库、`-wal` 和 `-shm` 文件权限校正为 `0600`。正常退出时关闭连接，异常退出依赖 SQLite/WAL 恢复。

### Schema

Schema 版本使用 `PRAGMA user_version`，首版为 1。

```sql
CREATE TABLE app_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_calls_json TEXT,
  reasoning_json TEXT,
  UNIQUE (turn_id, sequence)
);

CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  through_turn_sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

系统提示不存储，每次由当前程序注入。`tool_calls_json` 和 `reasoning_json` 必须在读写边界严格校验并深拷贝。API Key 没有对应字段。

### 迁移与损坏保护

- 新数据库在单个事务中创建 schema 并设置 `user_version = 1`。
- 后续版本使用从 N 到 N+1 的顺序迁移，每次启动只向前迁移。
- 数据库版本高于程序支持版本时拒绝打开。
- 无法打开、迁移失败、JSON 字段损坏或完整性检查失败时给出数据库绝对路径和可执行建议。
- Coffee 不自动覆盖、删除、改名或重建异常数据库，也不静默退化为仅内存模式。

## 持久化事务

网络请求和工具执行期间不持有 SQLite 事务。一个成功回合按以下顺序完成：

1. 在内存暂存用户消息、所有 assistant 工具调用、工具结果和最终 assistant 消息。
2. Provider 发出合法的最终 `done`。
3. 使用一个短 SQLite 事务创建或更新 session、插入 turn/messages、更新模型、标题、活动会话和 `revision`。
4. SQLite 提交成功后，才把本轮加入 Conversation 已提交历史并发出 Conversation `done`。

写入现有会话时使用乐观并发：

```sql
UPDATE sessions
SET revision = revision + 1, updated_at = ?, provider_id = ?, model_id = ?
WHERE id = ? AND revision = ?;
```

影响行数不是 1 代表另一 Coffee 进程已修改该会话；整个事务回滚，并提示重新打开会话。

若回答已经显示但保存失败，CLI 显示：“回答已生成，但历史保存失败，本轮未记录。”本轮不进入内存已提交历史，数据库也没有部分 turn。

## 上下文预算

### 配置

项目根目录 `coffee.settings.json` 增加：

```json
{
  "history-preferences": {
    "compression-threshold-chars": 30000,
    "max-context-chars": 40000,
    "summary-target-chars": 5000
  }
}
```

首版使用以上默认值。配置缺失时使用默认值；类型错误、非正整数或 `threshold >= max` 时显示警告并整体回退默认值。

### 字符成本

字符成本使用稳定 JSON 序列化后的字符串长度，计入：

- 消息 role 和 content。
- 工具调用 ID、名称和参数。
- 工具结果。
- reasoning 字段、文本和 opaque details。
- 系统提示、摘要包装文本和当前用户输入。

该算法不是 tokenizer，但可以跨模型稳定工作，并为 provider 请求保留明显余量。

### 完整轮次选择

每次模型调用都按以下顺序构建上下文：

1. 系统提示。
2. 如存在，注入一条明确标记为“较早对话摘要”的 system 消息。
3. 从最新向更早选择连续的完整已提交 turn。
4. 当前用户消息和当前进行中的工具回合。

任何 turn 都不可拆分，assistant 工具调用及其全部 tool result 视为同一 turn 的一部分。遇到第一个放不下的较新候选 turn 后立即停止，不跳过它再加入更老 turn。

当前回合始终整体保留并优先丢弃旧 turn。若系统提示、摘要和当前回合本身仍超过 40,000 字符，则终止本轮并且不保存。

## 滚动摘要

当“系统提示 + 现有摘要 + 尚未摘要的历史 + 当前输入”达到 30,000 字符时，在主回答前显示“正在整理较早的对话…”，并使用当前会话选择的同一模型和凭证生成新摘要。

摘要输入由“已有摘要 + 本次要压缩的最老连续完整 turns”组成。选择足够多的旧 turns，使“目标 5,000 字符摘要 + 保留的最近完整 turns + 当前输入”回到软阈值内。

摘要必须保留：

- 用户偏好和明确事实。
- 已确认的决定与约束。
- 未解决问题和待办。
- 工具结果的结论与必要来源。

摘要必须排除：

- 原始 reasoning 文本和 opaque reasoning details。
- API Key、凭证或疑似秘密。
- 冗长工具日志和无关过程信息。

摘要成功后，以 `through_turn_sequence` 标记覆盖到哪个原始 turn；原始 turns/messages 永不删除。写入摘要时校验 `source_revision`，确保生成期间会话未被其他进程修改。

摘要调用失败时不阻断主请求，退回到 40,000 字符内的最近连续完整 turns。Ctrl+C 取消摘要则取消整个用户回合，不修改摘要或历史。

## 取消、错误与并发

- 继续使用现有 `turnActive` 阻止同进程并发模型请求。
- 模型或工具活跃期间，SessionManager 的 `/new`、`/sessions` 切换和 `/delete` 返回忙碌错误。
- 任意模型错误、工具错误、流解析错误或 Ctrl+C 都回滚内存暂存回合，且不写数据库。
- 摘要保存与回合保存分别使用短事务和 revision 校验。
- 数据库繁忙最多等待 5 秒，之后返回安全、可操作的错误。
- 原始 SQLite 错误不得包含 API Key；路径可以展示。

## 测试策略

测试使用临时 HOME 和临时数据库；CLI 通过仅供测试/诊断的 `COFFEE_HISTORY_PATH` 覆盖默认路径，绝不触碰真实 `~/.coffee/history.sqlite`。

### HistoryStore

- 首次建库、schema v1、WAL、外键和权限。
- 完整 user/assistant/tool/reasoning 往返。
- 单事务提交和级联删除。
- revision 冲突与 busy timeout。
- 未来版本、损坏数据库和损坏 JSON 安全失败且不覆盖文件。

### SessionManager

- 自动恢复、延迟创建和活动会话清空。
- `/new` 不产生空记录。
- 会话列表排序、消息数和当前标记。
- 切换、删除、模型恢复与模型更新。
- 缺模型或凭证时保留会话但阻止聊天。

### ConversationContext

- 字符成本包含工具与 reasoning 元数据。
- 从新到旧的连续完整轮次选择。
- 30,000 阈值触发滚动摘要。
- 摘要覆盖范围、5,000 字符目标提示和 raw history 保留。
- 摘要失败退回 40,000 字符截断。
- 当前工具回合超硬限制时失败。
- 摘要内容不包含 raw reasoning 或凭证。

### Agent 与 CLI

- Provider 完成后才原子写入并发出 `done`。
- 模型/工具/取消/保存失败不留下部分历史。
- 保存失败时已显示内容保留且本轮不进入后续上下文。
- `/new`、`/sessions`、`/delete` 命令提示与阻断。
- 启动自动恢复和无凭证恢复。
- `/model` 同时更新会话模型与全局默认模型。
- 全部测试使用 fake gateway/SSE，不请求真实厂商。

## 验收标准

- 退出并重启 Coffee 后可自动继续最后活动会话。
- `/new` 仅在首个成功回合后产生新会话。
- `/sessions` 可列出并切换历史；`/delete` 经确认只删除当前会话。
- 每个会话恢复自己的模型，缺模型或凭证时不静默切换。
- 成功回合完整持久化；失败、取消和保存错误不产生半个回合。
- 达到 30,000 字符时自动滚动摘要，原始数据库历史保留。
- 摘要失败仍能在 40,000 字符硬限制内继续；当前回合自身超限时明确失败。
- reasoning 可用于同 provider 回放但永不展示，API Key 永不写库。
- 数据库损坏、未来版本和多进程冲突不会导致静默覆盖。
- 全量测试与 `npm run check` 通过。
