# dsh-feishu-session-notify

让 DSH 和飞书双向协作：

- DSH 每个完成的回复自动发送到飞书；
- DSH 运行失败也自动发送错误通知到飞书，例如余额不足、限流、鉴权失败、达到最大 Token 限制；
- 使用 DSH 当前会话名称作为标题；
- 使用飞书 Markdown 富文本；
- 每个 DSH 会话自动创建一个飞书话题，后续回复持续在同一话题中；
- 回复飞书话题中的任意消息，会继续对应的 DSH 会话；
- 可以直接在飞书里用 `/dsh new --workspace <别名> <任务>` 在指定工作区新建 DSH 会话；
- 不依赖 DSH 是否处于前台，也不调用模型发送通知；
- 发送失败自动重试，话题回复失败时退回到新消息，不会静默丢消息；
- 重启后自动补发上次因退出而没送出的最终输出。

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

## Topic behavior

- The first completed output for a DSH session is sent as a Markdown root message.
- Later outputs use `lark-cli im +messages-reply --reply-in-thread` against the saved root message ID.
- If a human manually creates a topic by replying to an automatically sent message, the plugin adopts that topic's `root_id` and sends later output there.
- Every sent root/reply message is recorded so replying to any of them resolves to the same DSH session.

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
