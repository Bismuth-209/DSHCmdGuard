# Cmd Guard — “完全增量”静态代码审查

> 范围：`lib/`（公开仓库根；原工作区版本为 `cmd-guard/plugin/lib/`）。  
> 方式：只读代码审查 + grep/逐文件检查；按用户要求，**不做运行时测试**。  
> 目标：确认插件对已有工具调用只可能“增加拒绝”或“交给下游”，不会把原本会被下游 reject/ask 的调用变成 accept。

## 结论

在以下前提下，静态审查通过：

1. 插件只通过 `tools/pre-execute` listener 参与已有工具调用；
2. 所有 allow 分支都调用 `next()`，没有直接返回 `{kind:'allow'}`；
3. 插件不修改 `exec.arguments`；
4. 插件不写 `sandbox/mode`、`approval/policy`、`permission/preset`；
5. 插件不注册新的权限预设，也不替 Auto review 做决定；
6. 下游 listener 的 `deny`/`ask`/`cancel` 仍然决定最终结果。

因此：**对同一个已有工具调用、同一个下游条件，插件不会把 reject/ask 变成 accept。**  
但“增量”不等于“没有新增能力/副作用”：插件新增了 `trash_move`/`trash_restore` 工具、system prompt section、远程 probe、investigator、LLM 审核和审计写入；这些是新增能力/新增副作用，不是对已有拒绝的覆盖。

## 证据

### 1. allow 分支全部委托给下游

`index.js` 中所有放行路径：

- 非目标工具 / 无 agent：`return next()`；
- 确定性 `allow`：`return next()`；
- `auto` 预设：`return next()`；
- reviewer `allow`：`return next()`；
- investigator `allow`：`return next()`。

没有分支直接构造 `{kind:'allow'}` 并返回。  
对应位置：`lib/index.js` 约 196–230、259、283、302–307 行。

### 2. 拒绝只能增加，不能减少

插件返回 `deny` 的分支包括：

- 确定性策略 deny；
- 远端状态无法验证且 `failClosed`；
- reviewer deny / 失败 / 非法输出；
- investigator deny / timeout / uncertain；
- investigate 但 investigator 未启用。

这些分支都在调用 `next()` 之前返回，或替代下游结果；没有“先调用 next() 再把它改成 allow”的路径。

### 3. 不修改执行参数

- `exec.arguments` 只被读取（`index.js` 分类、`review.js`/`investigator.js` 生成审核输入）；
- 没有对 `exec`、`session`、`sandbox`、`approval` 的写操作；
- 没有 `setSandboxMode`、`setApprovalPolicy`、`session.append('approval/policy')`、`permissionPresets.set` 等调用。

`trash_move`/`trash_restore` 只操作自己的输入路径；不修改工具调用参数。

### 4. `auto` 分工没有扩大权限

`auto` 预设下插件只做确定性层，然后 `next()` 交给 Auto review；不调用本插件 LLM，也不改变 Auto review 的判据。  
非 `auto` 下 reviewer/investigator allow 后仍然 `next()`，下游 workspace/approval/guard 继续生效。

### 5. 新增能力/副作用清单（不是“拒绝变允许”）

- 新增 `trash_move` / `trash_restore` 工具；
- 新增一段 system prompt section；
- 新增 reviewer LLM 调用；
- 新增 investigator 子代理（只读 preset）；
- 新增 remote `ssh` 只读 probe；
- 新增 JSONL 审计写入。

这些是“新增动作/新能力”，不会让一个原本被下游拒绝的现有工具调用通过。  
但审查时仍需注意：它们可能带来新的读取/网络/日志副作用，不能说“插件没有任何副作用”。

## 关键前提与风险

- 如果未来代码出现直接 `return {kind:'allow'}`、修改 `exec.arguments`、写 sandbox/approval、或替换下游 listener 的顺序，不变量会被破坏；
- 如果下游 `next()` 链本身被错误替换，插件无法保证；
- `trash_restore` 依赖宿主 manifest 的完整性；manifest 被篡改时可能恢复错误路径；
- 远程 probe 是只读固定命令，但仍会建立 SSH 连接并读取远端内容；
- 本审查不覆盖 DSH 沙箱实现、SSH/docker 远端权限、模型误判；“完全增量”只描述插件的授权决策。
