# Cmd Guard 插件设计（v0.1）

> 状态：仅设计，不含实现。  
> 工作名：`dsh-cmd-guard`。  
> 基线：DSH 0.2.1-rc.3（桌面 Web profile）。

> **公开版说明**：本项目原名 Delete Guard，公开版更名为 **Cmd Guard**（包名 `dsh-cmd-guard`，内部 id、审计目录与 trash 目录统一为 `cmd-guard`）。本文保留 v0.1 设计原貌与验证记录；与个人环境相关的 IP、主机、端口、本地路径已在发布前移除。

## 1. 设计决策摘要

1. **不新增权限类型**。插件是 `tools/pre-execute` 上的正交策略层，只读当前权限预设，不写 sandbox/approval，不注册新的 `auto`，不改变权限选择器。
2. **强制注入、但不打扰工作流**。插件作为 host-plane profile bundle 加载，对所有 in-process agent 的工具调用生效；只增加 1 个工具和 1 段很短的 system prompt section。
3. **Auto 分工**：
   - 当前预设是 `auto`：只运行本插件的**非 LLM 确定性筛查**，LLM 交给现有 Auto review；
   - 其他预设：确定性筛查 + 本插件的 LLM reviewer（可选 subagent 回退）。
4. **防误删优先采用“禁止 shell 删除 + trash_move”**，不追求完整解析任意 shell/PowerShell 表达式。这样既降低开发难度，也避免工作流变形。
5. **拒绝原因只给很短的事实**；“不要绕过安全防线、应请示用户”属于长期行为规则，放在 system prompt，不放在每条拒绝回复里。
6. **subagent 回退先设计机制、默认关闭**；通过审计/指标收集 investigate 率、超时率，再调整第一层 reviewer 的 system prompt。

## 2. 目标与非目标

### 目标

- 所有非 `auto` 预设下，危险操作在执行前经过本插件的策略层；`auto` 下至少经过确定性硬规则。
- 重点防范：误删、脚本误删、docker/venv 等打包内容删除、SSH 远端破坏性命令。
- 对 agent 的拒绝反馈短、稳定、可行动但不冗长。
- 对正常开发工作流尽量透明：只对高风险命令增加 LLM/subagent 延迟。
- 可观测：记录决策、原因、路径、SSH 目标、investigate 率。

### 非目标

- 不保证“任意 shell 脚本绝对安全”；shell 是图灵完备的，未知二进制/动态代码无法静态证明。
- 不替代 workspace-write 沙箱、docker/远端自身的权限系统。
- 不新增权限 UI、不改权限预设表、不做 per-agent 开关。
- 不在 MVP 中支持完整 bash/PowerShell 语法分析、完整脚本 AST、完整 docker/ssh 资源图。

## 3. 总体架构

```
                       tools/pre-execute
                              │
                  ┌───────────▼───────────┐
                  │  Cmd Guard plugin   │
                  │  (host-plane bundle)   │
                  └───────────┬───────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
  确定性筛查             LLM reviewer          subagent investigator
  (所有非 auto；          (非 auto，            (非 auto，investigate
   auto 下也运行)         高风险/不确定)         且开启时)
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                          next() → workspace-write / approval / Auto review
```

### 3.1 与权限系统的关系

- 预设仍是 `read-only` / `workspace-write` / `danger-full-access` / `auto` / `custom`。
- 插件只读取：
  - `permissionPresets.current(session)` 判断是否 `auto`；
  - `sandboxPolicy.resolve({session})` 读取当前沙箱模式/工作区根目录；
  - `approval` 仅用于需要用户审批时的现有流程。
- 插件不写 `permission/preset`、`sandbox/mode`、`approval/policy`。

### 3.2 Auto 分工

| 当前预设 | 确定性筛查 | 本插件 LLM | 现有 Auto review LLM |
|---|---|---|---|
| `auto` | 运行 | 不运行 | 运行 |
| 其他 | 运行 | 运行（按风险路由） | 不运行（gate 不匹配） |

`auto` 下确定性层如果放行，就 `next()` 给 Auto review；如果确定性层拒绝，直接拒绝，不再进入 Auto review；如果确定性层不确定，交给 Auto review 的 LLM 判断。

## 4. 审核流程

### 4.1 非 auto 预设

```
1. pre-execute 进入
2. 无 agent / 插件未启用 → next()
3. 命令分类与确定性筛查
   - 明确安全 → next()
   - 明确危险 → deny(短原因)
   - 不确定/高风险 → LLM reviewer
4. LLM reviewer:
   - allow → next()
   - deny → deny(短原因)
   - investigate → 可选 subagent
5. subagent:
   - allow → next()
   - deny → deny(短原因)
   - 超时/不确定 → deny(短原因)
6. next() 返回 allow/ask/deny/cancel，按现有流水线处理
```

### 4.2 auto 预设

```
1. pre-execute 进入
2. 无 agent / 未启用 → next()
3. 确定性筛查
   - deny → deny(短原因)
   - allow / 不确定 → next()   // 交给 Auto review LLM
```

### 4.3 与 next() 的 AND 语义

- 本插件拒绝 → 工具体不执行。
- 本插件放行 → 仍要经过 `next()`：workspace-write 沙箱、审批、guard、Auto review 的 LLM 都可能拒绝。
- 只有本插件和下游都放行（或用户审批通过）才执行。
- `next()` 返回 `ask` 时走现有审批；返回 `deny`/`cancel` 时不执行。

## 5. 确定性筛查层

### 5.1 范围

MVP 只审核命令类工具：

- `bash`
- `pwsh`
- `terminal_send`
- 持久化 shell 工具使用同名 `bash`/`pwsh`，自然覆盖

文件读写工具、MCP 工具等不在 MVP 的删除策略内；后续按需扩展。

### 5.2 命令分类

优先级从高到低：

1. **trash_move**：走路径验证；允许。
2. **shell 删除命令**：`rm`、`rmdir`、`unlink`、`del`、`erase`、`rd`、`Remove-Item`、`ri`、`rmdir`、`find -delete`、`xargs rm`、`Get-ChildItem | Remove-Item` 等 → **deny**，提示使用 `trash_move`。
3. **脚本执行**：`python`、`node`、`pwsh -File`、`bash script`、`cmd /c`、`npm run`、`make` 等：
   - 能读取脚本且静态扫描未发现删除 → allow-safe（仍受沙箱约束）；
   - 脚本含删除模式 → deny / 需要 LLM/subagent；
   - 脚本不可读、二进制、下载后执行、`curl | bash`、`Invoke-Expression` → deny/ask。
4. **docker 删除**：`docker rm/rmi/volume rm/prune/system prune`：
   - 含 `$(...)`、`--filter`、`prune`、批量变量 → deny；
   - 显式 ID/名称 → LLM/审批（后续阶段）。
5. **ssh 破坏性命令**：`ssh`、`scp`、`rsync --delete`、`sftp`：
   - 解析 host + remote command；
   - 远端命令缺失/不透明/变量拼接 → deny/ask；
   - 显式远端删除 → LLM/审批（后续阶段）。
6. **其他**：明确安全 → allow；未知 → LLM（非 auto）或 allow（auto，交 Auto review）。

### 5.3 为什么可以不做完整路径解析

MVP 的核心规则是：**禁止 shell 删除**，只允许 `trash_move`。

- `rm`/`Remove-Item` 被 deny 后，不需要解析变量、通配符、相对路径、PowerShell provider。
- `trash_move` 的参数是 **JSON 字符串路径**，不是 shell 命令；没有 shell 展开、命令替换、通配符。
- 宿主可以可靠地 `path.resolve` + `realpath` + Windows 大小写规范化 + symlink/junction 检查。

这样就把“路径解析”从“解释任意 shell”降级为“验证一个 JSON 参数”，复杂度大幅下降。

### 5.4 trash_move 路径验证

对每个 `paths[]`：

- 必须是非空字符串、绝对路径（或明确允许的相对路径，MVP 只收绝对路径）。
- `path.resolve` + `fs.realpath`（存在时）；不存在则检查父链。
- Windows 大小写不敏感比较。
- 拒绝：
  - 工作区根目录本身；
  - `.git`、`.ssh`、用户主目录、系统目录、盘符根、回收站；
  - trash 根目录自身；
  - 通过 symlink/junction 最终指向保护区的路径；
  - 超过 `maxPaths`；
  - 非文件系统路径。
- 允许根：session workspace + 显式配置的额外根；工作区外默认 ask/deny。
- 移动目标：`<session workspace>/tmp/.cmd-guard-trash/<sessionId>/<timestamp>/...`，会话级、同卷；trash 根及其父目录不能被移入 trash。
- 返回 `{ moved: [{from,to}], errors }`；审计记录映射。

### 5.5 脚本检查（MVP 简化）

- 只做关键词/命令位置扫描，不做完整 AST。
- 脚本必须可读、在工作区或允许根内、大小受限。
- 发现删除模式 → deny 或标记 `needs-review`。
- 不可读/动态/编码/下载执行 → deny/ask。
- 原则：**宁可否决，不做过度分析**；后续用 subagent 处理复杂脚本。

### 5.6 保护路径

- 删除命令已被禁止，保护路径主要用于 `trash_move`。
- 保护列表可配置，默认：工作区根、`.git`、`.ssh`、`$HOME`、`C:\Windows`、`C:\Program Files`、盘符根、回收站、trash 根。
- 对 docker/ssh 目标不适用文件保护，走各自规则。

## 6. LLM reviewer 层

### 6.1 复用方式

复制并适配 `@deepseek-ai/dsh-experimental-auto-review` 的：

- `snapshotAutoReview`：会话上下文/历史过滤/待执行动作；
- `readDecision` / `parseDecision`：流式读取和严格 JSON 校验；
- `classifyRisk` 的调用方式：`ctx.llm.stream`；
- 拒绝/失败的材料化方式。

修改：

- gate 改为 `permissionPresets.current(session) !== 'auto'`；
- 去掉 `registerAuto` / Auto 卸载迁移；
- 增加 `SANDBOX_POLICY` 和 `PREFLIGHT_FACTS` 两段输入；
- prompt 改为删除/生产安全导向；
- 输出协议扩展为 `allow | deny | investigate`。

### 6.2 输入

```
REVIEW_POLICY          固定、短小
SANDBOX_POLICY         当前 mode + workspaceRoot
ENVIRONMENT            cwd
PROJECT_INSTRUCTIONS   项目约束
FILTERED_HISTORY       裁剪后的用户指令/工具调用事实
PREFLIGHT_FACTS        命令族、目标路径、路径事实、脚本摘要、docker/ssh 目标
PENDING_ACTION         工具 schema + 完整参数
```

为控制延迟：

- 历史只保留最近 N 条用户指令和最近 N 条工具调用；
- 默认不发送完整脚本内容，只发送删除相关行/摘要；
- 大文件截断并标注。

### 6.3 输出协议

```json
{"decision":"allow"}
{"decision":"deny","reason":"short factual reason"}
{"decision":"investigate","reason":"what is missing","questions":["..."]}
```

- `deny.reason` 必须短；不允许长篇解释、修复建议、内部推理。
- `investigate` 只允许在 facts 不足时使用；第一层 prompt 明确“能判断就不要 investigate”。
- 非法输出 → deny（fail closed）。

### 6.4 拒绝原因

- 模型可见：`deny.reason`，例如：
  - `Blocked by cmd guard: shell deletion is disabled.`
  - `Blocked by cmd guard: protected path.`
  - `Blocked by cmd guard: script contains deletion.`
  - `Blocked by cmd guard: review budget exceeded.`
- 结构化细节放 `info`，给审计/UI，不给模型。
- 不写“你应该……”“你可以改用……”；这些属于 system prompt 的长期规则。

## 7. Subagent 回退层（后续阶段）

### 7.1 触发

仅当：

- 非 `auto`；
- 第一层 LLM 返回 `investigate`；
- `investigator.enabled = true`。

`auto` 下不启用本插件的 subagent。

### 7.2 机制

- `ctx.subagents.startActivation({
    provider: 'spawn',
    label: 'cmd-guard-review',
    request: {
      parent: exec.agent,
      agentPreset: 'cmd-review-investigator',
      prompt: [...],
      outputSchema: {...},
      maxDepth: 0
    },
    delivery: 'caller',
    signal: fusedSignal
  })`
- 子代理 preset：只读 `read`/`glob`/`grep`，无 shell、无删除、无写工具。
- prompt：只检查给定路径/脚本；最多读 N 个文件；必须返回结构化结论。
- 父 listener `await activation.result`，读取 `structured`；完成后 `dispose()`。
- 超时/失败/低置信 → deny(短原因)，不再继续验证。

### 7.3 防递归

- 子代理 preset 不含删除/脚本工具；
- 插件可通过 preset/session 标记跳过 review 子代理；
- 子代理 preset 不是 `auto`，Auto review 不介入；
- `maxDepth: 0`。

### 7.4 指标与调优

记录：

- 第一层 `allow/deny/investigate` 次数；
- investigate 转 subagent 次数；
- subagent 超时/失败/allow/deny；
- 平均延迟、token（可得时）；
- 用户最终是否批准/拒绝（可得时）。

调优：

- investigate 率过高 → 修改第一层 prompt / 增加 facts / 调整阈值；
- 子代理超时率高 → 降低任务范围或超时；
- 误拒率高 → 放宽确定性规则或增加 allow 规则。

## 7.5 SSH 远程只读核查（可选增强）

目标：让 reviewer/subagent 在判断 `ssh host "..."` 是否安全时，能读取远端的目标状态，而不是只看本地命令文本。

### 7.5.1 原则：给“只读探测工具”，不给 shell

不要让 review 子代理直接使用 `bash`/`pwsh`/`ssh`。那会重新引入任意 shell、递归审核和误操作风险。

建议增加一个**只对 review-investigator preset 可见**的工具：

```text
remote_inspect({
  host: string,                 // 必须是配置中的 SSH host/alias
  probe: "stat" | "list" | "read" | "docker_inspect" | "docker_ps" | "systemctl_status" | "git_status",
  path?: string,                // 远端绝对路径
  resource?: string,            // docker 容器/镜像/volume 的显式 ID 或名称
  maxBytes?: number             // read 的上限
})
```

- `host` 必须在 `ssh.allowedHosts` 中；生产 host 可要求额外审批。
- `probe` 是枚举，不接受任意命令字符串。
- `path` 必须是远端绝对路径，禁止 `..`、变量、通配符、管道、重定向。
- `resource` 必须是显式 ID/名称，禁止 `$(...)`、`--filter`、`prune`。
- 返回结构化事实和截断后的文本，不返回完整大文件。

### 7.5.2 执行方式

- 由宿主插件内部执行，不经过 agent 的 `bash`/`ssh` 工具。
- 使用固定 argv 模板，例如：
  - stat：`ssh -o BatchMode=yes -o ConnectTimeout=5 host -- stat --format=... -- /path`
  - list：`ssh ... -- ls -la -- /path`
  - read：`ssh ... -- head -c <maxBytes> -- /path`
  - docker：`ssh ... -- docker inspect --type container <id>`
  - systemctl：`ssh ... -- systemctl status --no-pager <unit>`
- 不使用 `shell=True`，不拼接命令字符串；参数逐项校验/转义。
- 使用用户现有 SSH config/agent/known_hosts；禁止 `StrictHostKeyChecking=no`。
- 超时、输出上限、每轮 probe 数量上限（例如 3 个）。
- 每次 probe 都写审计：host、probe、target、结果摘要、耗时、失败原因。
- 输出中的疑似 secret 做脱敏。

### 7.5.3 两种接入方式

**A. 父插件预探测（推荐优先做，复杂度低）**

- 在启动 reviewer 前，解析待执行的 `ssh` 命令，识别 host、远端命令、涉及的路径/docker 资源。
- 父插件先执行 1–3 个固定只读 probe，把事实放进 `PREFLIGHT_FACTS`。
- 子代理通常不需要直接访问远端；facts 不足时直接 deny/ask。

**B. 子代理按需探测（Phase 3 可选）**

- 仅在 `investigate` 时，把 `remote_inspect` 工具挂到 review-investigator preset。
- 子代理最多调用 2–3 次；父插件限流/超时/审计。
- 探测失败或超时 → `remote_state_unverified`；涉及远端删除时默认 deny/ask。

### 7.5.4 失败与安全

- SSH 认证失败/网络不可达：返回 `unavailable`，不得假装远端状态安全；破坏性远端命令 fail closed。
- 远端内容视为**不可信数据**：只作为 facts 输入 reviewer，不当作指令；防 prompt injection。
- 子代理只读、无写工具、无 shell；即使被远端内容诱导，也不能直接执行命令。
- 远程读取可能接触敏感文件：限制路径根、字节数、host 白名单，并审计。
- 仍然无法证明远端脚本/守护进程的完整状态；`remote_inspect` 是提高判断质量，不是硬保证。

### 7.5.5 复杂度取舍

- 已实现 A（父插件预探测）：`remote_inspect` 宿主侧只读 probe，不新增 agent 工具。
- B（子代理自行调用 `remote_inspect` 工具）**暂不实现**，仅记录为未来可选方案；如果未来数据表明 facts 不足是主要误拒/误放原因，再考虑。
- 这样不会让当前版本多出一个通用远程执行面。

### 7.5.6 “真实 Docker daemon 的 docker inspect 成功路径”指什么

指远端主机上确实运行着 Docker daemon，并且 SSH 用户有权访问它；此时：

```text
ssh <remote-host> -- docker inspect --type container <container-id>
```

会返回真实 JSON（State、Config.Labels、Mounts、Created、Image 等），插件把这些 facts
交给 reviewer，reviewer 才能判断：

- 容器是否仍在运行；
- 是否有 volume/bind mount 挂着生产数据；
- 是否属于 production/compose stack；
- 删除是否会波及其它服务。

当前 live 测试的 `dg-ssh-server` 容器**没有 Docker daemon**，所以只能验证
`docker_inspect` 命令的构造、SSH 执行和失败路径（`REMOTE_PROBE_FAILED`），
无法验证真实 JSON 成功返回。要做成功路径测试，需要额外的 Docker-in-Docker
（privileged 测试容器）或一个真实远端 Docker 主机；为了不挂载宿主机 Docker socket，
当前没有做。

## 8. System prompt 与拒绝原因

### 8.1 放 system prompt 的内容

一段很短的 section（约 2 句话）：

> Destructive operations are protected by a safety guard. If a tool call is denied by the guard, do not retry it through another tool, script, or alternate syntax; explain the intended operation to the user and ask for explicit confirmation. Use `trash_move` for cleanup; do not permanently delete files with shell commands.

内容原则：

- 只写长期行为规则；
- 不写具体命令/路径/实现细节；
- 不重复工具描述；
- 不写长政策。

### 8.2 不放回复的内容

- 不重复“不要绕过安全防线”；
- 不写修复建议；
- 不写内部审核过程；
- 不写 reviewer 的原始理由/推理；
- 不写 subagent 对话。

### 8.3 为什么放在 system prompt

- 这是跨轮次的长期行为约束，不是一次拒绝的局部信息；
- 放 system prompt 只增加一次固定 token，不随每次拒绝重复；
- 拒绝回复保持短，减少上下文污染和工作流变形；
- 如果插件被禁用，section 消失，行为规则也随之移除。

代价：section 变化会影响 system prompt 前缀/KV cache；只在插件启用/禁用时变化，可接受。

## 9. trash_move 工具

MVP 只增加一个工具：

```text
trash_move({
  paths: string[],     // 最多 20 个绝对路径
  reason?: string      // 可选，一句清理原因
})
→ { moved: [{from,to}], errors: [{path,error}] }
```

- 工具描述一句话：Move files/directories to the session trash instead of deleting them.
- 不提供永久删除工具。
- 不提供 `trash_restore`（MVP）；宿主/用户可从 trash 目录恢复；后续可加。
- 工具调用本身不触发 LLM；只做路径验证 + 移动 + 审计。
- 如果路径验证失败，返回结构化错误，不移动任何文件（要么全成功，要么不移动；MVP 可逐个处理但返回错误列表）。

## 10. 插件结构

```
cmd-guard/
  plugin/
    package.json          # dsh-cmd-guard, dsh.bundle.patch
    cordis.patch.yml      # host 行 + config
    lib/
      index.js            # 生命周期 + pre-execute listener + system section + tool
      policy.js           # 命令分类、删除/脚本/docker/ssh 规则
      path-guard.js       # trash 路径验证/保护根
      review.js           # LLM reviewer（复用 auto-review snapshot/parse）
      investigator.js     # subagent 回退（后续启用）
      audit.js            # JSONL 审计 + metrics
    tests/
```

不新增：

- 权限预设；
- client UI；
- 独立服务；
- 第二套 system prompt；
- 额外的 runtime context section。

## 11. 配置（草案）

```yaml
- id: cmd-guard
  name: 'dsh-cmd-guard'
  config:
    enabled: true
    commandTools: ['bash', 'pwsh', 'terminal_send']
    strictDelete: true            # shell 删除一律 deny
    trash:
      enabled: true
      relativeRoot: tmp/.cmd-guard-trash
      maxPaths: 20
      extraAllowedRoots: []
    reviewer:
      enabled: true
      timeoutMs: 20000
      maxHistoryItems: 12
    investigator:
      enabled: false              # 先关闭，收集数据后再开
      timeoutMs: 15000
      maxFiles: 5
      agentPreset: cmd-review-investigator
    audit:
      enabled: true
      root: !!js dshHomePath('cmd-guard')
```

## 12. 实施阶段

### Phase 1：确定性 MVP

- 插件骨架 + host bundle；
- `trash_move` + 路径验证；
- system prompt section；
- 确定性筛查：
  - shell 删除 deny；
  - 脚本含删除模式 deny/ask；
  - docker/ssh 明显危险 deny；
- 审计；
- `auto` 下只跑确定性层；
- 非 auto 下高风险但无法判定 → deny（暂不接 LLM）。

目标：先得到“不会 shell 删除 + 可恢复清理”的硬底座。

### Phase 2：LLM reviewer

- 复用 auto-review 的 snapshot/parse；
- 非 auto 的“不确定/高风险”进入 LLM；
- 短拒绝原因；
- 关闭 subagent。

目标：降低误拒/漏拒，同时控制延迟。

### Phase 3：subagent 回退 + 指标

- 只读 investigator preset；
- `investigate` 触发；
- 超时/失败回退；
- 指标收集与 prompt 调优。

### Phase 4：可选增强

- docker 资源事实收集；
- SSH host allowlist/审计增强；
- `trash_restore`；
- 更完整的 PowerShell 解析（仅在证明必要后）。

## 13. 测试计划

### 单元

- 命令分类：rm/Remove-Item/del/script/docker/ssh/trash_move；
- 路径验证：相对路径、变量、通配符、symlink、junction、保护根、工作区外；
- trash_move：成功/失败/部分失败/越界；
- system prompt 文本长度和内容；
- 审计字段。

### 集成

- 测试 profile（`.investigation`）加载插件；
- `workspace-write` 下 `rm` 被 deny；`trash_move` 成功；
- `auto` 下 `rm` 被确定性层 deny，安全命令交给 auto-review；
- 非 auto 下脚本/未知命令进入 LLM；
- 插件卸载后 listener 移除；
- reviewer 超时/非法输出 fail closed；
- subagent 超时/失败回退；
- 不产生双重 LLM（auto 下本插件不调 LLM）。

### 手工

- 安全命令不增加明显延迟；
- 拒绝原因短、模型不会反复重试；
- 用户能从 trash 恢复；
- SSH 命令审计可见。

## 14. 风险与限制

- **脚本/隐藏执行**：静态扫描不完整；trash/sandbox/备份是兜底，不能靠单层保证。
- **docker/SSH**：本地插件看不到 docker daemon/远端状态；只能审核命令文本，必要时转用户审批。
- **LLM 误判**：reviewer/subagent 都是概率性的；确定性层负责硬规则，LLM 只做补充。
- **Auto 信息差**：Auto 下本插件只做确定性层，Auto review 的 LLM 看不到 preflight facts；接受或后续改 Auto review。
- **插件加载失败**：需要启动健康检查/告警；否则可能 fail open。
- **工作流变形**：system prompt 和拒绝原因保持短；默认只对高风险命令增加 LLM。
- **维护成本**：复用 auto-review 的 snapshot 代码，跟随 rc 升级需要回归测试。

## 15. 待确认问题

1. `trash_move` 是否允许工作区外路径（例如工作区外的 venv）？默认 ask 还是 deny？
2. docker/ssh 破坏性命令默认 deny 还是转用户审批？
3. Phase 1 是否接受“高风险但未判定 → deny”的保守策略？
4. 脚本检查是否只做关键词扫描，还是 Phase 2 就接 subagent？
5. system prompt section 是否接受一次性 KV cache 影响？
6. 审计日志保留时间、是否脱敏。

## 16. 容器测试基线（已执行）

为避免“测试逃逸造成真实删除”，所有测试都在隔离容器中运行：

- 镜像：`node:24-slim`，构建时安装 `@deepseek-ai/dsh@0.2.1-rc.3`（CLI 可用）；
- 运行参数：`--network none --read-only --tmpfs /tmp`；
- **不挂载任何宿主机路径**；测试文件、canary、trash、DSH profile 都在容器内 `/tmp` 或镜像层；
- 双容器 SSH 测试：`dg-ssh-server` 容器 + `dg-test-net` + named key volume；DSH 测试容器通过 SSH 读取远端 `stat`/`list`/`read` 事实，无宿主机挂载；
- 构建上下文为仓库根（Dockerfile 位于 `container/`）。

测试安全设计：

1. **危险命令不执行**：policy 测试只调用分类器；
2. **canary 测试**：plug-in 测试用假 `next()` 记录“工具体是否被调用”，工具体不执行任何文件操作；
3. **trash 测试**：只在容器 `/tmp` 创建合成文件，验证 move 到 trash，不做永久删除；
4. **fuzz corpus**：危险命令变体只做分类断言，不进入 shell；
5. **DSH smoke**：在容器内创建临时 DSH_HOME/profile，运行 `--dump-config`，确认 `dsh-cmd-guard` 行被组装。

当前结果：

- `node --test`：45 个测试，37 通过，8 个 live/Windows test 在无对应环境时跳过；
- 带临时 key 的 live reviewer 测试：危险远端 `rm -rf` 返回 `deny`，只读 `systemctl status` 返回 `allow`；
- 双容器 SSH 测试（`dg-test-net` + `dg-ssh-server` + named key volume）：
  - live `stat`/`list` 读取 `/srv/app` 成功；
  - live `read` 读取 `/srv/app/config` 成功；
  - plugin 集成测试确认 remote facts 进入 reviewer 输入；
- 真实远端 Docker 测试（隔离主机 + 独立 key volume）：
  - 目标容器 `dg-review-target` 的 `docker inspect` 返回真实 facts；
  - 远端挂载仅包含一个只读 temp 目录；
  - plugin 集成测试确认真实 Docker facts 进入 reviewer；
- 真实 host DSH 测试（独立测试 DSH_HOME/profile、workspace-write、workspace 位于隔离测试目录）：
  - 安全 headless 任务成功；
  - `pwsh` 安全命令被插件审计；
  - `trash_move` 移动到 `<workspace>/tmp/.cmd-guard-trash/...`，`trash_restore` 在 owning session 中恢复成功；
  - `ssh <remote-host> 'docker inspect dg-review-target'` 经 reviewer allow 后成功，未修改容器；
  - 发现并修复：reviewer 直接读取 `ctx.llm` 会在未 inject 时抛错，改为 `ctx.get('llm')`；
- 隔离 desktop profile 副本（独立 DSH_HOME）：
  - 加载 desktop 的全部主要 bundle：web-app、auto-review、agent-team、tool-worktree、terminal、plugin-market、ralph、session-search、workspace-pipeline、subagent；
  - `cmd-guard` 行和 `cmd-review-investigator` preset 在组合树中存在；
  - 独立端口启动 Web，`workspace/create` + `session/create` + 真实模型 turn 成功；
  - 第二次 prompt 的真实 `pwsh` 安全命令被插件审计；
  - 测试后已停止该实例；当前 DSH 未受影响；
- Windows host 路径测试：
  - 大小写不敏感 workspace 根；
  - junction 被 path guard 拒绝；
  - trash_move/restore 真实路径；
  - 显式 Deny ACL 阻止 DSH workspace-write 写测试文件；
- DSH `--dump-config`：组合树包含 `cmd-guard` 行和 `cmd-review-investigator` preset；
- DSH CLI `--help`：容器内可运行。

已知限制：

- 容器是 Linux；Windows 专属的路径大小写、junction、ACL 行为已在 Windows host 做了部分测试，但仍需 Windows Sandbox/VM 做真实逃逸边界测试。
- desktop 测试使用的是复制 profile + 最小 node_modules 链接；没有对真实 desktop profile 做任何修改。
- desktop 测试没有验证 Auto 预设切换、Auto review 与本插件的实际叠加、investigator 真正触发，也没有做 Web UI 视觉检查；这些仍待补。
- headless 测试 profile 没有 `agentPresets` 服务，`cmd-review-investigator` preset 显示 pending；desktop 副本有 agent preset registry，但没有触发 investigator 端到端。
- 真实远端测试使用一次性 Docker-only key volume，测试后已清理；没有向远端主机添加新 key，也没有挂载宿主机 `.ssh`。
- 容器测试证明策略逻辑与插件集成边界，不证明“任意脚本/远端命令绝对安全”。
- `trash_move` 使用 rename，但 trash 根现在固定在工作区内、同卷；跨盘问题已通过会话级 `tmp/.cmd-guard-trash` 消除。trash 仍是工作区内目录，删除/篡改风险由 shell 删除拦截和 path guard 共同约束。

## 17. 当前实现状态

已实现（Phase 1 确定性 + Phase 2 reviewer 接线 + Phase 3 只读 investigator + Phase 4 remote probe/trash restore）：

- host plugin `dsh-cmd-guard`；
- `tools/pre-execute` listener；
- 确定性分类：shell 删除、嵌套 shell、脚本、docker、ssh/scp/rsync/sftp、git clean、动态调用；
- `trash_move` + `trash_restore` + 路径保护 + 工作区边界；
- 短 system prompt section；
- 紧凑 LLM reviewer（`allow/deny/investigate`）；
- 只读 `cmd-review-investigator` preset（`read`/`glob`/`grep`；无写、无 shell）；
- `investigate` 触发 in-process subagent：`delivery: 'caller'`、结构化 verdict、超时/失败/uncertain fail closed、完成后 dispose；
- `remote_inspect` 宿主侧只读 SSH probe：`stat`/`list`/`read`/`docker_inspect`/`systemctl_status`；
- 远端删除在无法收集事实时 fail closed；
- JSONL 审计 + 脱敏；
- `auto` 下跳过本插件 LLM，只做确定性层；
- 容器测试与 DSH profile smoke；
- 真实 DeepSeek API 的 reviewer 冒烟：危险远端删除返回 deny，只读远端命令返回 allow；
- 双容器 SSH 集成测试：真实 `stat`/`list`/`read` 事实进入 reviewer；
- 真实远端 Docker daemon 的 `docker inspect` 成功路径：真实容器 facts 进入 reviewer；
- 真实 host DSH headless 测试（隔离测试 DSH_HOME、workspace-write）：安全命令、`trash_move`/`trash_restore`、远端 Docker inspect 都成功；
- 隔离 desktop profile 副本测试：Web 启动、session/agent 创建、真实模型 turn、插件审计成功；当前 DSH 未受影响；
- Windows host 路径测试：大小写、junction、trash 真实路径、显式 Deny ACL；
- 修复 reviewer 直接读取 `ctx.llm` 导致 “without inject” 的问题，改为 `ctx.get('llm')`；
- 静态“完全增量”审查：[MONOTONICITY_REVIEW.md](MONOTONICITY_REVIEW.md)（未做运行时测试）。

未实现（后续）：

- B 方案：子代理自行调用 `remote_inspect` 工具（当前只做父插件预探测；记录为未来可选，不计划当前实现）；
- `trash_restore` 的 UI/交互入口；
- Auto 预设切换 + Auto review 与本插件在 desktop 下的实际叠加验证；
- desktop/web 中的 investigator 端到端触发；
- Web UI 视觉/交互回归；
- Windows Sandbox/VM 的真实逃逸边界测试（当前只做 host 路径/ACL 行为测试）；
- 真实 DSH agent turn 中的 subagent 端到端测试（headless 测试 profile 没有 `agentPresets`，investigator preset 显示 pending；desktop 副本尚未触发 investigator）。

尚未执行、需要用户授权的测试：

- Windows Sandbox/VM 的破坏性逃逸测试：需要一次性 Windows 环境。
- Auto 预设/审批 UI 的交互测试：需要 Web UI 操作或对应 API。






