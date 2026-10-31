# dsh-feishu-session-notify

让 DSH 和飞书双向协作：

- DSH 每个完成的回复自动发送到飞书；
- DSH 运行失败也自动发送错误通知到飞书，例如余额不足、限流、鉴权失败、达到最大 Token 限制；
- 使用 DSH 当前会话名称作为标题；
- 使用飞书 Markdown 富文本；
- 每个 DSH 会话的**第一条**输出直接发到主聊天窗口，作为该会话的话题入口；
- **后续**输出回复进由第一条消息创建的话题，点开那条消息就能看到全部历史；
- 回复飞书话题中的任意消息，会继续对应的 DSH 会话；
- DSH 的**审批请求**和 **`ask_user_question` 提问**也会推到飞书，可以直接在飞书里回复决定；
- 可以直接在飞书里用 `/dsh new --workspace <别名> <任务>` 在指定工作区新建 DSH 会话；
- 不依赖 DSH 是否处于前台，也不调用模型发送通知；
- 发送失败自动重试，话题回复失败时退回到新消息，不会静默丢消息；
- 重启后自动补发上次因退出而没送出的最终输出。

> 默认是**话题模式（混合）**：第一条进主窗口保证有入口，后续折叠进该话题。若某类聊天不需要话题，可切到平铺模式，见 [Topic vs flat mode](#topic-vs-flat-mode)。

> This README is written for AI agents. An agent should inspect the host profile first, preserve existing profile configuration, and restart DSH after changing Host plugin configuration.

## What the plugin does

```text
DSH assistant/message + turn/end(completed)
  -> lark-cli im +messages-send --markdown

DSH turn/end(error|max-tokens|interrupted)
  -> format failure reason/message
  -> lark-cli im +messages-send or +messages-reply --markdown
  -> save Feishu message_id -> DSH session_id
  -> create/use one Feishu topic root per DSH session

Feishu im.message.receive_v1
  -> require sender_id == the authenticated user
  -> `/dsh ...` command?  -> execute control command, reply a confirmation
  -> else require reply_to or root_id to match a saved message_id
  -> normalize outer ```text fences
  -> agent.followup() to the mapped DSH session
```

The notification path does not call an LLM and does not consume model tokens. A reply from Feishu intentionally starts normal DSH work and can consume the configured model/tool budget.

## Requirements

- Windows, macOS, or Linux with a DSH Host plugin profile;
- Node.js/npm available to the DSH process;
- `lark-cli` installed and authenticated;
- a Feishu app/bot that can send messages and receive `im.message.receive_v1`;
- Feishu Open Platform event `im.message.receive_v1` enabled in the app console;
- the app must have the message receive permission required by the event schema.

Check the CLI first:

```powershell
lark-cli --version
lark-cli auth status
```

The Bot identity must be `ready`. If needed:

```powershell
lark-cli auth login --recommend
```

The event schema and required permission can be inspected with:

```powershell
lark-cli event schema im.message.receive_v1
```

## Install from GitHub into DSH

The commands below use the Windows DSH home path. On another platform replace `$DSH_HOME` with the active DSH home and use the platform's path syntax.

### 1. Clone the plugin

```powershell
$DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
New-Item -ItemType Directory -Force (Join-Path $DSH_HOME 'plugins-src') | Out-Null
git clone https://github.com/Re-qi/dsh-feishu-session-notify.git `
  (Join-Path $DSH_HOME 'plugins-src/dsh-feishu-session-notify')
```

If the repository already exists, use `git pull` instead.

### 2. Add it to the active DSH profile

Find the active profile from the DSH Host launch arguments. For the standard Desktop profile it is usually:

```text
%USERPROFILE%\\.dsh\\profiles\\desktop
```

Add the local package to that profile's `package.json` dependencies and `dsh.profile.bundles` list:

```json
{
  "dependencies": {
    "dsh-feishu-session-notify": "link:C:/Users/123/.dsh/plugins-src/dsh-feishu-session-notify"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-feishu-session-notify"
      ]
    }
  }
}
```

Do not replace the profile's existing dependencies or bundles. The path must match the real user and clone location; the example above is Windows-specific.

If the profile's package manager does not expose the local package reliably, add a direct Host insertion to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: feishu-session-notify
      name: 'file:///C:/Users/123/.dsh/plugins-src/dsh-feishu-session-notify/lib/index.js'
```

Use the actual absolute path on the machine.

### 3. Install/link profile dependencies

Run from the active profile directory:

```powershell
pnpm install
```

If the profile uses npm instead, use its existing package-manager workflow. Do not delete the profile lockfile or reinstall unrelated plugins.

### 4. Restart DSH

Fully exit and reopen DSH. A browser refresh is not sufficient for a Host plugin or profile patch change.

## Verify installation

Check the Feishu event consumer:

```powershell
lark-cli event status
```

Expected output includes:

```text
Active consumers: 1
im.message.receive_v1
```

The plugin diagnostic log is normally:

```text
%USERPROFILE%\\.dsh\\feishu-session-notify.log
```

The persistent message/session mapping is normally:

```text
%USERPROFILE%\\.dsh\\feishu-dsh-bindings.json
```

To test routing:

1. Let DSH finish a real task;
2. find the resulting Feishu message;
3. reply directly to that message or to any message in its topic;
4. DSH should receive the reply as a user follow-up in the mapped session.

An ordinary Feishu message that is not a reply to a saved DSH message is ignored by design, preventing cross-session actions.

## Delivery guarantees

The log file records every delivery decision, so a missing Feishu message can
be diagnosed without the host console:

```text
sending session=... seq=... kind=completed chars=... chunks=... root=...
sent session=... messages=1 root=...
lark failed attempt=1/2 cmd=im +messages-reply err=...
thread reply failed root=om_...; falling back to a new root: ...
catch-up session=... chars=... root=...
```

- Every `lark-cli` send is attempted twice, 1.2 s apart.
- A failing topic reply is retried once as a fresh standalone message, so a
  deleted or inaccessible thread no longer swallows a finished turn.
- Each session stores `lastSentHash` in the bindings file. On startup the
  plugin compares it with the session's latest assistant text and re-sends the
  difference — that recovers a turn whose `turn/end` never arrived because the
  app was closing. The first run after installing only records the baseline.

## Feishu commands

Any message from the authorized user whose text starts with `/dsh` is treated
as a control command and is answered in Feishu instead of being forwarded to a
DSH session. Commands do not need to be a reply to an existing topic.

| Command | Effect |
| --- | --- |
| `/dsh workspaces` | List every DSH workspace with its alias and absolute path |
| `/dsh new --workspace demo 修复登录测试` | Create a new DSH session in workspace `demo` and send it the remaining text as the task |

`/dsh new` accepts both `--workspace demo` and `--workspace=demo`. Anything
else under `/dsh` returns the command help.

The workspace alias is resolved against the live `workspaceRegistry`: the
workspace id, its title/name, and the basename of its path all match
case-insensitively. A message can therefore never name an arbitrary filesystem
path — only a workspace DSH already knows about can be used.

Creating a session:

1. `agents.create` is called with the resolved `cwd`, the host's default
   model/provider, and the default agent preset (each field is omitted, not
   fatal, when the corresponding host service is unavailable);
2. the session is attached to its workspace so it also appears in the DSH
   sidebar;
3. the confirmation message in Feishu becomes the topic root for that session,
   so every later output is replied into the same thread;
4. the task text is delivered as the session's first user message.

## Approvals and questions from Feishu

DSH asks the human through two Cordis waterfalls. The plugin listens on both,
`prepend: true`, and answers them from Feishu **without calling any model**:

| Host hook | Feishu prompt | Reply resolves to |
| --- | --- | --- |
| `approval/request` | tool name + reason + `1 / 2` | `allowed-once` / `rejected` |
| `user-questions/request` | the question and its options | `{ answers: [{ id, selected, custom? }] }` |

Approval message:

```text
需要审批

会话：帮我安装飞书 CLI
工具：pwsh
原因：git push origin main

1 · 允许一次
2 · 拒绝

———
回复「1」允许、「2」拒绝，或回复「取消」放弃
```

Question message (one message per question, numbered when a call asks several):

```text
需要你回答（1/3）

项目用哪个端口？

1 · 3000
2 · 8080

———
回复选项编号（多选形如 1,3），或直接回复你的答案；回复「取消」跳过
```

How the user replies:

| Reply | Approval | Question |
| --- | --- | --- |
| `1` / `同意` / `允许` / `y` | allow once | — |
| `2` / `拒绝` / `n` | reject | — |
| `1` / `2` / … | — | select that option |
| `1,3` | — | select several (multi-select) |
| any other text | not an answer — a hint is posted and the wait continues | used as the custom answer |
| `取消` | reject | skip this question |

Rules:

- Every prompt ends with a fixed reply hint; there is **no extra timeout** — the
  wait follows DSH's own limits, and a Feishu answer still applies afterwards.
- The desktop card and Feishu **race**: whichever answers first wins, the other
  wait is dropped. Both surfaces show the same question by default, so it can be
  read and answered in DSH as usual and from Feishu when away.
- `{"feishuOnly": true}` (or `DSH_FEISHU_ASK_ONLY=1`) suppresses the desktop
  answerer once the Feishu prompt is delivered — the desktop card then no longer
  appears. Delivery failure always falls back to the desktop answerer.
- A reply that targets the prompt message answers that prompt. When exactly one
  prompt is open for a session, any reply in its topic also answers it.
- Only the authorized user's replies count.
- Answers are resolved by this plugin directly; the notify path never invokes a
  model, so answering costs no tokens.
- A plain Feishu message sent while the session is running is delivered with
  `agent.steer()` — the same interjection as the desktop composer's "插话" —
  instead of `agent.followup()`, which would only queue it behind the turn.
- Delegated child agents (`agents.roots()` does not contain them) are never
  surfaced: their approvals stay inside the parent's own UI.

## Topic vs flat mode

Feishu keeps a topic's replies inside the topic, and a bot p2p chat lists only
root messages in the main window. The default is therefore the **hybrid** that
keeps an entry point visible:

1. A session's first output is a normal `+messages-send` — it appears in the
   main chat window and becomes the topic root.
2. Every later output is `+messages-reply --reply-in-thread` on that root, so
   the whole history lives under one message the user can click.

| Mode | Behaviour | Visible where |
| --- | --- | --- |
| `thread` (default) | first turn is the root, later turns reply into it | first turn in main window, the rest inside the topic |
| `flat` | every turn is a standalone `+messages-send` | every turn in the main window, no topic |

Switch to flat mode with either:

```json
// %USERPROFILE%\.dsh\feishu-session-notify.json
{ "thread": false }
```

```powershell
$env:DSH_FEISHU_THREAD = 0
```

The environment variable wins over the file. Both modes bind every sent
message, so replying to any of them still routes back to the same DSH session.

In thread mode:

- The first completed output for a DSH session is sent as a Markdown root message.
- Later outputs use `lark-cli im +messages-reply --reply-in-thread` against the saved root message ID.
- If a human manually creates a topic by replying to an automatically sent message, the plugin adopts that topic's `root_id` and sends later output there.

A topic root must be a **main-window message**. When the stored root is itself a
thread reply, every later answer nests one level deeper and the chat window
stays empty. The plugin therefore verifies roots:

- `rootVerified` is set when the plugin posts the root itself;
- an unverified root is checked once with `im +messages-mget` before use, and a
  root living inside a topic is dropped so the next output re-anchors a visible
  message;
- the same check runs once at startup for every bound session, so older
  bindings repair themselves;
- the `/dsh new` confirmation is always posted as a root, never as a reply.

## Message formatting

The plugin sends `--markdown`, not `--text`:

```powershell
lark-cli im +messages-send --as bot --user-id ou_xxx --markdown '**Session name**`n`nAI output'
lark-cli im +messages-reply --as bot --message-id om_xxx --reply-in-thread --markdown '**Follow-up**'
```

The AI output is forwarded as Markdown, so Feishu can render bold text, lists, inline code, and fenced code blocks. Incoming outer fences such as ` ```text ... ``` ` are removed before the text is passed back into DSH.

## Security and safety

- Incoming messages are accepted only from the open ID of the authenticated Feishu user.
- A message must reply to a known DSH message, or be an explicit `/dsh` command; other unthreaded messages are ignored.
- `/dsh new` only accepts a workspace alias resolved from `workspaceRegistry`, never a raw path.
- Feishu replies can trigger DSH tools and file operations. Keep DSH's normal permission/approval policy enabled unless you explicitly understand the risk.
- The binding file contains message IDs and local session IDs. Treat it as local state.
- The plugin invokes the local `lark-cli`; it does not store the Feishu App Secret in source code.

## Uninstall

1. Stop DSH.
2. Remove `dsh-feishu-session-notify` from the active profile's dependencies and `dsh.profile.bundles` (and remove its direct `cordis.patch.yml` insertion if added).
3. Run the profile's package manager install/update command.
4. Restart DSH.
5. Optionally remove the clone and the local state files after confirming they are no longer needed.

## License

MIT. Add the repository's chosen license file before publishing if this project is redistributed.
