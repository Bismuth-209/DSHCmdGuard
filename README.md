# Cmd Guard（命令护栏）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

DSH 的命令安全护栏：在 agent 真正执行 shell 命令之前拦截删除类操作，并提供可恢复的 `trash_move` / `trash_restore`；对可疑命令可交给紧凑的 LLM reviewer 复核。

> A host-side command safety layer for DeepSeek Harness (DSH). It blocks destructive shell deletion before the tool body runs, offers recoverable trash tools, and reviews ambiguous commands with a compact LLM reviewer. Formerly named **Delete Guard**; renamed to **Cmd Guard** in this public release.

---

## 开发方式：全程 AI vibe coding

**本项目从设计、编码、调试、测试到文档，全程使用 DeepSeek 模型 + DeepSeek Harness（DSH）以 vibe coding 方式开发完成。** 人类只负责提出需求、验收结果和做发布决策。

This project was built end-to-end via **vibe coding with DeepSeek models inside DeepSeek Harness (DSH)** — design, implementation, debugging, tests, and documentation. Human involvement was limited to requirements, acceptance, and release decisions.

因此请注意：代码由 AI 生成，可能存在缺陷或未覆盖的边界情况；安全类插件请务必自行审查与测试后再用于关键环境。本项目以 MIT 协议开源。

---

## 功能

- 在 host 侧注册 `tools/pre-execute` 监听器，对所有 in-process agent 的工具调用生效。
- 拒绝 `rm`、`Remove-Item`、`del`、`rmdir`、`find -delete`、`xargs rm`、嵌套的字面 shell 删除，以及动态调用。
- 识别「脚本中包含删除模式」的命令，并路由到复核流程。
- 解析 docker 删除、SSH/rsync/scp/sftp 命令；宽泛或不可判定的远端删除默认 fail closed。
- 对被复核的 SSH 命令执行固定的只读探针（`stat`、`list`、`read`、`docker_inspect`、`systemctl_status`），把事实交给 reviewer。
- 新增两个小工具 `trash_move` / `trash_restore`，以及一段很短的 system prompt 说明。
- **不新增权限预设、不加客户端 UI、不修改 sandbox/approval 行为。**
- 在 `auto` 预设下只运行确定性的非 LLM 筛查，LLM 决定交给 DSH 自带的 Auto review。

## 安装

前提：DSH `>= 0.2.1-rc.3`，Node.js `>= 24`。

```sh
# 从 GitHub 安装（推荐）
dsh plugin add github:Bismuth-209/DSHCmdGuard
```

也可以克隆后本地安装：

```sh
git clone https://github.com/Bismuth-209/DSHCmdGuard.git
dsh plugin add ./DSHCmdGuard
```

安装后**重启一次 DSH**。bundle patch 会插入两行：`cmd-guard` 主机插件和 `cmd-review-investigator` 只读复核 preset。

## 工作方式

```
tools/pre-execute
       │
       ▼
  Cmd Guard（host 插件）
       │
       ├── 确定性筛查（所有非 auto；auto 下也运行）
       ├── LLM reviewer（非 auto，按风险路由）
       └── 只读 investigator（非 auto，investigate 且启用时）
       │
       └── next() → 既有 workspace-write / approval / Auto review
```

插件只读取权限预设与 sandbox 策略，不写 `permission/preset`、`sandbox/mode`、`approval/policy`；所有放行分支最终都调用下游 `next()`。

## 配置

默认配置见 [cordis.patch.yml](cordis.patch.yml) 的 `cmd-guard` 行。主要字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| `commandTools` | `bash`, `pwsh`, `terminal_send` | 参与命令分类的工具名 |
| `trash.relativeRoot` | `tmp/.cmd-guard-trash` | 会话工作区内的回收站目录（相对路径，同卷 rename） |
| `trash.maxPaths` | `20` | 单次 `trash_move` 的最大路径数 |
| `trash.extraAllowedRoots` | `[]` | 显式允许的工作区外根目录 |
| `reviewer.enabled` | `true` | 对 `review` 类决策启用紧凑 LLM reviewer |
| `reviewer.timeoutMs` | `20000` | reviewer 超时 |
| `investigator.enabled` | `false` | 启用只读 in-process investigator |
| `investigator.agentPreset` | `cmd-review-investigator` | 本 bundle 插入的只读 preset |
| `remote.enabled` | `false` | 对复核的远端命令启用固定只读 SSH 探针 |
| `remote.allowedHosts` | `[]` | 允许探针的 host/alias 白名单 |
| `remote.user` / `remote.port` / `remote.identityFile` | 无 / 22 / 无 | SSH 连接参数 |
| `remote.strictHostKeyChecking` | `yes` | `yes`、`accept-new` 或 `no`（`no` 只建议测试用） |
| `remote.failClosed` | `true` | 无法收集远端事实时拒绝删除 |
| `audit.root` | `$DSH_HOME/cmd-guard` | JSONL 审计目录（脱敏） |

回收站位于**会话工作区内**（默认 `<workspace>/tmp/.cmd-guard-trash`），因此 `trash_move` 使用同卷 rename，不会跨盘复制；它不是 DSH_HOME 下的全局目录。

## 工具与行为

- `trash_move`：把文件/目录移动到会话回收站（默认上限 20 个路径），拒绝工作区根、回收站根及越界路径。
- `trash_restore`：从回收站恢复，恢复目标必须在当前工作区内。
- system prompt：被护栏拒绝时，要求 agent 不要换语法重试，而是说明意图并向用户确认；清理用 `trash_move`，不要用 shell 永久删除。

## 安全边界（请读）

- 这是一个**策略层，不是沙箱**：不替代 workspace-write、Docker 或远端主机自身的权限控制。
- shell 是图灵完备的，静态分类无法证明任意脚本“绝对安全”；对无法判定的情况默认拒绝。
- LLM reviewer / investigator 可能误判；超时、非法输出、不确定一律按拒绝处理（fail closed）。
- 远端探针是固定的只读命令，但仍会建立 SSH 连接并读取远端信息。
- 审计只写判定元数据（脱敏），不复制文件内容。
- 本项目不包含任何真实 API key；live reviewer 测试需要由调用方临时通过环境变量提供 `DEEPSEEK_API_KEY`。

## 测试

### 单元 / 集成测试

```sh
node --test "tests/*.test.mjs"
```

测试设计为安全：不会执行真实删除命令；policy 测试只调用分类器，plugin 测试使用假 `next()`，trash 测试只在临时目录操作。没有对应环境的 live/Windows 测试会自动 skip。

### 容器测试（隔离、无宿主挂载）

```sh
docker build -f container/Dockerfile -t dsh-cmd-guard-test:local .
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=256m dsh-cmd-guard-test:local
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=512m dsh-cmd-guard-test:local sh /work/smoke-profile.sh
```

### 可选 live 测试

live reviewer 测试（需要临时 `DEEPSEEK_API_KEY`，key 只作为 Docker `-e` 变量传入，不写入镜像）：

```sh
CMD_GUARD_LIVE_REVIEW=1 node --test tests/live-review.test.mjs
```

远端 SSH 探针测试（可复现的双容器环境，见 `container/ssh-server/`）：

```sh
docker build -t dg-ssh-server:local ./container/ssh-server
docker network create dg-test-net
docker volume create dg-ssh-keys
docker run -d --name dg-ssh-server --network dg-test-net -v dg-ssh-keys:/keys dg-ssh-server:local

docker run --rm --network dg-test-net -v dg-ssh-keys:/keys:ro \
  --read-only --tmpfs /tmp:rw,size=256m -e HOME=/tmp \
  -e CMD_GUARD_REMOTE_LIVE=1 -e REMOTE_SSH_HOST=dg-ssh-server \
  -e REMOTE_SSH_USER=tester -e REMOTE_SSH_KEY=/keys/id_ed25519 \
  -e REMOTE_SSH_KNOWN_HOSTS=/tmp/known_hosts \
  dsh-cmd-guard-test:local \
  node --test tests/remote-live.test.mjs tests/remote-plugin-live.test.mjs
```

## 目录结构

```
.
├── lib/
│   ├── index.js        # host 插件：pre-execute 监听、工具、prompt、接线
│   ├── policy.js       # 确定性命令分类
│   ├── review.js       # 紧凑 LLM reviewer
│   ├── investigator.js # 只读 in-process investigator
│   ├── remote.js       # 固定只读 SSH 探针
│   ├── path-guard.js   # 工作区/回收站路径校验
│   ├── trash.js        # trash_move / trash_restore
│   └── audit.js        # JSONL 审计（脱敏）
├── tests/              # node --test 测试（live 测试默认 skip）
├── container/          # 隔离容器测试与 SSH 服务端
├── docs/
│   ├── DESIGN.md       # v0.1 设计稿
│   └── MONOTONICITY_REVIEW.md  # “完全增量”静态审查
├── cordis.patch.yml
├── icon.svg
└── package.json
```

## 兼容性与状态

- 状态：**v0.1.0 / developer preview**，配置项与内部实现可能变化。
- 开发与验证环境：DSH `0.2.1-rc.3`（Desktop + Web GUI），Node.js 24；容器测试为 Linux。
- 已知限制：Windows 专属的路径大小写、junction、ACL 只在 Windows host 做了部分测试；未做 Windows Sandbox/VM 逃逸测试；Auto 预设切换、investigator 端到端触发仍待补。
- 更名说明：本项目原名 **Delete Guard**，公开版更名 **Cmd Guard**；内部插件 id、审计目录（`$DSH_HOME/cmd-guard`）与回收站目录（`tmp/.cmd-guard-trash`）已同步改名。

## License

[MIT](LICENSE) © 2026 Bismuth

本项目在实现与文档中参考了 DeepSeek Harness（MIT）的公开文档与 API；DSH 本体及其相关包版权归 DeepSeek AI 所有，遵循其各自的 MIT 许可。本项目不是 DeepSeek 官方插件。
