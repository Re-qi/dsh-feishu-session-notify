# dsh-feishu-session-notify

让 DSH 和飞书双向协作：

- DSH 每个完成的回复自动发送到飞书；
- 使用 DSH 当前会话名称作为标题；
- 使用飞书 Markdown 富文本；
- 每个 DSH 会话自动创建一个飞书话题，后续回复持续在同一话题中；
- 回复飞书话题中的任意消息，会继续对应的 DSH 会话；
- 不依赖 DSH 是否处于前台，也不调用模型发送通知。

> This README is written for AI agents. An agent should inspect the host profile first, preserve existing profile configuration, and restart DSH after changing Host plugin configuration.

## What the plugin does

```text
DSH assistant/message + turn/end(completed)
  -> lark-cli im +messages-send --markdown
  -> save Feishu message_id -> DSH session_id
  -> create/use one Feishu topic root per DSH session

Feishu im.message.receive_v1
  -> require sender_id == the authenticated user
  -> require reply_to or root_id to match a saved message_id
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
- A message must reply to a known DSH message; unthreaded messages are ignored.
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
