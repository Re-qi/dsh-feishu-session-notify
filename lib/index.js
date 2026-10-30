/**
 * DSH <-> Feishu bridge.
 *
 * Completed turns are sent to Feishu without looking at window focus. Every
 * sent Feishu message is bound to the DSH session that produced it. A reply
 * to that Feishu message is routed back to the same DSH session.
 *
 * This plugin never calls an LLM itself. Only an intentional Feishu reply can
 * start a DSH follow-up, which naturally consumes the normal DSH model/tool
 * budget.
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { delimiter, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)
const MAX_CHARS = 3500
const MAX_BUFFER = 1024 * 1024
const STALE_EVENT_MS = 5 * 60 * 1000
const STATE_PATH = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh'), 'feishu-dsh-bindings.json')
const DEFAULT_CHAT_NAME = process.env.DSH_FEISHU_CHAT_NAME || 'DeepSeekHarness'
const DEBUG_LOG_PATH = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh'), 'feishu-session-notify.log')

function debugLog(message) {
  try { appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, 'utf8') } catch { /* diagnostics must never break the bridge */ }
}

export const name = 'dsh-feishu-session-notify'
export const inject = ['agents', 'sessionTitle', 'workspaceRegistry']

function loggerOf(ctx) {
  return ctx.logger ?? console
}

function larkCliPath() {
  const appData = process.env.APPDATA
  if (appData) return join(appData, 'npm', 'lark-cli.cmd')
  return 'lark-cli.cmd'
}

function nodeExecutable() {
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory.replace(/^\"|\"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(candidate)) return candidate
  }
  return 'node'
}

function larkInvocation() {
  const appData = process.env.APPDATA
  const entry = appData ? join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js') : ''
  if (process.platform === 'win32' && existsSync(entry)) return { file: nodeExecutable(), prefix: [entry] }
  return { file: larkCliPath(), prefix: [] }
}

async function runLark(args) {
  const invocation = larkInvocation()
  const { stdout } = await execFileAsync(invocation.file, [...invocation.prefix, ...args], {
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    timeout: 45_000,
  })
  return stdout
}

/**
 * One transient cli/network failure must not silently swallow a whole turn,
 * so every send is attempted twice with a short backoff before giving up.
 */
async function runLarkRetry(args, attempts = 2) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runLark(args)
    } catch (error) {
      lastError = error
      debugLog(`lark failed attempt=${attempt}/${attempts} cmd=${args.slice(0, 2).join(' ')} err=${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`)
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1200 * attempt))
    }
  }
  throw lastError
}

async function currentUser() {
  const status = JSON.parse(await runLark(['auth', 'status']))
  const identity = status?.identities?.user
  if (typeof identity?.openId !== 'string' || identity.openId.length === 0) {
    throw new Error('飞书用户身份不可用，请先运行 lark-cli auth login --recommend')
  }
  return { openId: identity.openId, name: identity.userName || DEFAULT_CHAT_NAME }
}

function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function assistantTextFromEvent(event) {
  const message = event?.data?.message
  if (!message || message.role !== 'assistant') return ''
  return textFromContent(message.content)
}

function sessionTitleOf(ctx, session) {
  try {
    const title = ctx.sessionTitle?.get?.(session)?.title
    if (typeof title !== 'string') return ''
    return title.trim()
  } catch {
    return ''
  }
}

export function failureTextFromReason(reason) {
  const kind = String(reason?.kind || 'error')
  if (kind === 'error') {
    const error = reason?.error
    const message = typeof error === 'string' ? error : error?.message
    const code = error?.code
    return `**DSH 运行失败**\n\n原因：${kind}${code ? `\n错误码：${code}` : ''}${message ? `\n\n${message}` : ''}`
  }
  if (kind === 'max-tokens') return '**DSH 运行失败**\n\n原因：已达到最大 Token 限制。'
  if (kind === 'interrupted') return '**DSH 运行失败**\n\n原因：任务被中断。'
  return `**DSH 运行失败**\n\n原因：${kind}`
}

function assistantTextFromDerived(session) {
  try {
    const messages = session?.deriveMessages?.()
    if (!Array.isArray(messages)) return ''
    for (const message of messages.slice().reverse()) {
      if (message?.role !== 'assistant') continue
      const text = textFromContent(message.content)
      if (text) return text
    }
  } catch {
    // Older hosts may not expose deriveMessages; event cache is sufficient.
  }
  return ''
}

/** Remove only an outer Markdown text fence from an incoming Feishu message. */
export function normalizeIncomingText(value) {
  let text = String(value ?? '').trim()
  const fenced = text.match(/^```(?:text|plaintext)?\s*\r?\n([\s\S]*?)\r?\n```$/i)
  if (fenced) text = fenced[1].trim()
  text = text.replace(/^`(?:text|plaintext)`\s*\r?\n/i, '').trim()
  return text
}

/** Parse explicit Feishu control commands; ordinary replies remain session work. */
export function parseDshCommand(value) {
  const text = normalizeIncomingText(value)
  if (!/^\/dsh(?:\s|$)/i.test(text)) return null
  const rest = text.replace(/^\/dsh\s*/i, '').trim()
  if (/^workspaces?$/i.test(rest) || /^ls(?:\s+workspaces?)?$/i.test(rest)) return { kind: 'workspaces' }
  const match = rest.match(/^new\s+--workspace(?:=|\s+)([^\s]+)(?:\s+([\s\S]+))?$/i)
  if (match) return { kind: 'new', workspace: match[1], task: (match[2] || '').trim() }
  return { kind: 'help' }
}

function code(value) {
  return '`' + String(value ?? '') + '`'
}

function samePath(a, b) {
  const norm = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function workspaceBasename(path) {
  return String(path || '').replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || ''
}

export function workspaceEntries(ctx) {
  const list = ctx.workspaceRegistry?.list?.() || []
  return list.filter(ws => typeof ws?.path === 'string' && ws.path.trim()).map(ws => {
    const path = ws.path.trim()
    const aliases = [ws.id, ws.name, ws.title, workspaceBasename(path)]
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim().toLowerCase())
    return { workspace: ws, path, aliases: [...new Set(aliases)], label: ws.title || ws.name || workspaceBasename(path) || path }
  })
}

export function resolveWorkspace(ctx, alias) {
  const wanted = String(alias || '').trim().toLowerCase()
  return workspaceEntries(ctx).find(entry => entry.aliases.includes(wanted)) || null
}

/**
 * Build the `agents.create` request for a Feishu-started session. Model and
 * preset are copied from the host defaults so the new conversation behaves
 * like one the sidebar created; every lookup degrades to "omit the field"
 * rather than failing the whole command.
 */
async function createRequest(ctx, sessionId, cwd) {
  const request = { sessionId, meta: { cwd } }
  try {
    const picked = ctx.agentDefaultModel?.currentSelection?.()
    if (typeof picked?.provider === 'string' && picked.provider && typeof picked?.model === 'string' && picked.model) {
      const agentOptions = { provider: picked.provider, model: picked.model }
      if (picked.reasoningEffort !== undefined) agentOptions.reasoningEffort = picked.reasoningEffort
      request.agentOptions = agentOptions
    }
  } catch { /* no default model service: let the host decide */ }
  try {
    const presets = ctx.agentPresets
    if (presets?.resolve && presets?.mount) {
      const resolved = await presets.resolve(undefined)
      if (resolved?.id) {
        request.preset = resolved.id
        request.setup = async agentCtx => { await presets.mount(agentCtx, resolved.id) }
      }
    }
  } catch { /* preset service absent or refused: run with host defaults */ }
  return request
}

function chunks(text) {
  const chars = Array.from(text)
  const result = []
  for (let offset = 0; offset < chars.length; offset += MAX_CHARS) {
    result.push(chars.slice(offset, offset + MAX_CHARS).join(''))
  }
  return result
}

function readBindings() {
  try {
    const value = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (value && typeof value === 'object') {
      value.messages ||= {}
      value.sessions ||= {}
      value.handledIncoming ||= {}
      return value
    }
  } catch {
    // First run or a partially written old state: start cleanly.
  }
  return { version: 1, messages: {}, sessions: {}, handledIncoming: {} }
}

function saveBindings(bindings) {
  mkdirSync(join(STATE_PATH, '..'), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(bindings, null, 2), 'utf8')
}

function parseCliJson(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

function messageIdFromSend(raw) {
  const data = parseCliJson(raw)
  return {
    messageId: data?.data?.message_id || data?.data?.messageId || '',
    chatId: data?.data?.chat_id || data?.data?.chatId || '',
  }
}

function textHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex')
}

function chunkArgs({ isRoot, rootId, openId, body, idempotencyKey }) {
  const base = isRoot
    ? ['im', '+messages-send', '--as', 'bot', '--user-id', openId, '--markdown', body]
    : ['im', '+messages-reply', '--as', 'bot', '--message-id', rootId, '--reply-in-thread', '--markdown', body]
  return [...base, '--idempotency-key', idempotencyKey.slice(0, 50), '--format', 'json']
}

async function sendToFeishu(openId, text, sessionId, seq, chatName, bindings, threadRootId = '') {
  const pieces = chunks(text)
  const sent = []
  let rootId = threadRootId
  for (let index = 0; index < pieces.length; index += 1) {
    const marker = pieces.length > 1 ? ` [${index + 1}/${pieces.length}]` : ''
    const titled = `**${chatName || DEFAULT_CHAT_NAME}**${marker}\n\n${pieces[index]}`
    const untitled = `${marker ? `**${marker.trim()}**\n\n` : ''}${pieces[index]}`
    const idempotencyKey = `dsh-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)}-${seq}-${index + 1}`
    let isRoot = !rootId && index === 0
    let raw
    try {
      raw = await runLarkRetry(chunkArgs({
        isRoot,
        rootId,
        openId,
        body: isRoot ? titled : untitled,
        idempotencyKey,
      }))
    } catch (error) {
      if (isRoot || !rootId) throw error
      // The topic may be gone (recalled parent, deleted thread, permission
      // change). Posting a fresh root is worse than the topic but far better
      // than dropping the turn, so retry once as a standalone message.
      debugLog(`thread reply failed root=${rootId}; falling back to a new root: ${String(error?.message || error).slice(0, 200)}`)
      isRoot = true
      raw = await runLarkRetry(chunkArgs({ isRoot, rootId: '', openId, body: titled, idempotencyKey: `${idempotencyKey}-root` }))
    }
    const sentMessage = messageIdFromSend(raw)
    if (sentMessage.messageId) {
      sent.push(sentMessage)
      if (!rootId) rootId = sentMessage.messageId
      bindings.messages[sentMessage.messageId] = {
        sessionId,
        chatId: sentMessage.chatId,
        chatName: chatName || DEFAULT_CHAT_NAME,
        createdAt: Date.now(),
      }
    } else {
      debugLog(`send returned no message id chunk=${index + 1} session=${sessionId}`)
    }
  }
  return { sent, rootId }
}

export function replyParentId(event) {
  return String(event?.reply_to || event?.root_id || '').trim()
}

/**
 * Resolve one incoming Feishu reply without touching DSH. Keeping this pure
 * makes the anti-cross-talk rule testable: only an authorized user replying
 * to a message we sent can produce a binding.
 */
export function resolveIncomingBinding(event, bindings, authorizedOpenId) {
  if (event?.type !== 'im.message.receive_v1') return null
  if (event?.sender_type === 'bot') return null
  if (authorizedOpenId && event?.sender_id !== authorizedOpenId) return null
  const parentId = replyParentId(event)
  if (!parentId) return null
  const binding = bindings?.messages?.[parentId]
  if (!binding?.sessionId) return null
  const text = normalizeIncomingText(event.content)
  if (!text) return null
  return { parentId, binding, text }
}

function startIncomingConsumer({ onEvent, log }) {
  const invocation = larkInvocation()
  debugLog(`starting consumer file=${invocation.file} args=${JSON.stringify(invocation.prefix)}`)
  const child = spawn(invocation.file, [
    ...invocation.prefix,
    'event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--quiet',
  // Keep stdin open. lark-cli treats stdin EOF as a request to stop an
  // unbounded consumer; `ignore` would therefore exit immediately.
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { onEvent(JSON.parse(line)) } catch { log.warn?.('feishu-session-notify: ignored non-JSON event line') }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    const text = String(chunk).trim()
    debugLog(`consumer stderr=${text}`)
    log.warn?.(`feishu-session-notify event consumer: ${text}`)
  })
  child.on('error', error => {
    debugLog(`consumer error=${error?.stack || error}`)
    log.warn?.('feishu-session-notify: event consumer failed', error)
  })
  child.on('exit', (code, signal) => {
    debugLog(`consumer exit code=${code} signal=${signal || ''}`)
    log.warn?.(`feishu-session-notify: event consumer exited code=${code} signal=${signal || ''}`)
  })
  return child
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const log = loggerOf(ctx)
  const consumerStartedAt = Date.now()
  const assistantTextBySession = new Map()
  const notified = new Set()
  const runningSessions = new Set()
  const sentTextBySession = new Map()
  const bindings = readBindings()
  let userPromise
  let consumer

  function getUser() {
    if (!userPromise) {
      userPromise = currentUser().catch(error => { userPromise = undefined; throw error })
    }
    return userPromise
  }

  function rememberAssistantText(sessionId, turn, text) {
    if (!text) return
    let byTurn = assistantTextBySession.get(sessionId)
    if (!byTurn) {
      byTurn = new Map()
      assistantTextBySession.set(sessionId, byTurn)
    }
    byTurn.set(turn, text)
  }

  async function notifyTurnEnd(session, event) {
    const sessionId = String(session?.id ?? '')
    const seq = Number(event?.seq ?? 0)
    const turn = Number(event?.data?.turn ?? 0)
    const reason = event?.data?.reason || {}
    const kind = String(reason.kind || '')
    if (!sessionId || !Number.isFinite(seq) || !Number.isFinite(turn)) return
    if (kind === 'aborted') return
    const key = `${sessionId}:${seq}`
    if (notified.has(key)) return
    try { await ctx.sessions?.flush?.(session) } catch { /* best effort */ }
    let text = assistantTextBySession.get(sessionId)?.get(turn) ?? ''
    if (!text) text = assistantTextFromDerived(session)
    if (kind !== 'completed') {
      const failure = failureTextFromReason(reason)
      text = text ? `${failure}\n\n${text}` : failure
    }
    if (!text) { debugLog(`skip session=${sessionId} seq=${seq}: no assistant or failure text`); return }

    notified.add(key)
    try {
      const user = await getUser()
      const existing = Object.values(bindings.sessions).find(item => item.sessionId === sessionId)
      // Use the DSH conversation title, not the Feishu chat/bot name.
      const conversationName = sessionTitleOf(ctx, session) || existing?.sessionTitle || existing?.chatName || DEFAULT_CHAT_NAME
      debugLog(`sending session=${sessionId} seq=${seq} kind=${kind} chars=${text.length} chunks=${chunks(text).length} root=${existing?.rootMessageId || ''}`)
      const result = await sendToFeishu(
        user.openId,
        text,
        sessionId,
        seq,
        conversationName,
        bindings,
        existing?.rootMessageId || '',
      )
      const sent = result.sent
      bindings.sessions[sessionId] = {
        sessionId,
        chatId: sent[0]?.chatId || existing?.chatId || '',
        chatName: conversationName,
        sessionTitle: conversationName,
        rootMessageId: result.rootId || existing?.rootMessageId || '',
        cwd: session?.cwd || existing?.cwd || '',
        lastMessageIds: sent.map(item => item.messageId),
        lastSentHash: textHash(text),
        updatedAt: Date.now(),
      }
      saveBindings(bindings)
      sentTextBySession.set(sessionId, text)
      debugLog(`sent session=${sessionId} turn=${turn} messages=${sent.length} root=${result.rootId || ''}`)
    } catch (error) {
      notified.delete(key)
      debugLog(`SEND FAILED session=${sessionId} seq=${seq}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 400)}`)
      log.warn?.('feishu-session-notify: send failed', error)
    }
  }

  /**
   * A turn can end while the app is quitting or right before a restart: no
   * `turn/end` reaches the plugin, so that final output is lost even though
   * DSH still has it. On startup, compare each bound session's latest
   * assistant text with the hash of what was last delivered and resend the
   * difference. The first run only records a baseline, so upgrading the
   * plugin never floods the chat with old answers.
   */
  async function catchUpMissedTurns() {
    let agents
    try { agents = ctx.agents?.list?.() } catch { return }
    if (!Array.isArray(agents) || agents.length === 0) return
    const user = await getUser().catch(() => null)
    if (!user) return
    for (const agent of agents) {
      const session = agent?.session
      const sessionId = String(agent?.id || session?.id || '')
      if (!sessionId || runningSessions.has(sessionId)) continue
      const existing = Object.values(bindings.sessions).find(item => item.sessionId === sessionId)
      if (!existing) continue // only sessions this bridge already owns
      let text = ''
      try { text = assistantTextFromDerived(session) } catch { text = '' }
      if (!text) continue
      const hash = textHash(text)
      if (!existing.lastSentHash) {
        existing.lastSentHash = hash // baseline: never resend history
        saveBindings(bindings)
        continue
      }
      if (existing.lastSentHash === hash) continue
      if (sentTextBySession.get(sessionId) === text) continue
      try { await ctx.sessions?.flush?.(session) } catch { /* best effort */ }
      const title = sessionTitleOf(ctx, session) || existing.sessionTitle || existing.chatName || DEFAULT_CHAT_NAME
      debugLog(`catch-up session=${sessionId} chars=${text.length} root=${existing.rootMessageId || ''}`)
      try {
        const result = await sendToFeishu(user.openId, text, sessionId, Date.now(), title, bindings, existing.rootMessageId || '')
        bindings.sessions[sessionId] = {
          ...existing,
          chatId: result.sent[0]?.chatId || existing.chatId || '',
          chatName: title,
          sessionTitle: title,
          rootMessageId: result.rootId || existing.rootMessageId || '',
          lastMessageIds: result.sent.map(item => item.messageId),
          lastSentHash: hash,
          updatedAt: Date.now(),
        }
        saveBindings(bindings)
        sentTextBySession.set(sessionId, text)
        debugLog(`catch-up sent session=${sessionId} messages=${result.sent.length}`)
      } catch (error) {
        debugLog(`catch-up failed session=${sessionId}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    }
  }

  async function sendControlReply(event, userOpenId, markdown) {
    const messageId = String(event?.message_id || event?.id || '').trim()
    const args = messageId
      ? ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--reply-in-thread', '--markdown', markdown]
      : ['im', '+messages-send', '--as', 'bot', '--chat-id', String(event?.chat_id || ''), '--markdown', markdown]
    const raw = await runLark([...args, '--idempotency-key', `dsh-control-${randomUUID().replace(/-/g, '').slice(0, 30)}`, '--format', 'json'])
    return messageIdFromSend(raw)
  }

  async function handleDshCommand(event, command, user) {
    if (command.kind === 'workspaces') {
      const entries = workspaceEntries(ctx)
      const body = entries.length
        ? '**可用工作区**\n\n' + entries.map(entry => '- **' + entry.label + '** → ' + code(entry.path)).join('\n')
          + '\n\n创建新会话：\n' + code('/dsh new --workspace <别名> <任务>')
        : '**没有发现可用工作区**\n\n请先在 DSH 中添加工作区。'
      await sendControlReply(event, user.openId, body)
      return
    }
    if (command.kind === 'help') {
      await sendControlReply(event, user.openId, '**DSH 飞书命令**\n\n- `/dsh workspaces`：列出可用工作区\n- `/dsh new --workspace <别名> <任务>`：在指定工作区创建新会话\n\n普通消息请直接回复已有 DSH 话题。')
      return
    }
    const entry = resolveWorkspace(ctx, command.workspace)
    if (!entry) {
      const names = workspaceEntries(ctx).map(item => `**${item.label}**`).join('、') || '（无）'
      await sendControlReply(event, user.openId, `**找不到工作区：** ${command.workspace}\n\n可用别名：${names}`)
      return
    }
    if (!command.task) {
      await sendControlReply(event, user.openId, '请提供任务，例如：\n\n`/dsh new --workspace demo 修复登录测试`')
      return
    }
    if (!ctx.agents?.create) {
      await sendControlReply(event, user.openId, '当前 DSH Host 不支持创建新会话。')
      return
    }
    const sessionId = `session-${randomUUID()}`
    let created
    try {
      created = await ctx.agents.create(await createRequest(ctx, sessionId, entry.path))
      const agent = created?.agent
      if (!agent?.followup) throw new Error('新会话 Agent 不可用')
      try {
        const workspace = workspaceEntries(ctx).find(item => samePath(item.path, entry.path))?.workspace
        if (workspace?.attachSession) await workspace.attachSession(agent.id)
      } catch (error) {
        log.warn?.('feishu-session-notify: workspace attach failed', error)
      }
      const parentOrRoot = String(event?.root_id || event?.reply_to || '').trim()
      const notice = '**已创建新会话**\n\n工作区：' + code(entry.label)
        + '\n路径：' + code(entry.path)
        + '\n\n任务已开始，后续输出会发送到本话题。'
      // The confirmation is replied into a thread (a new one when the command
      // was itself unthreaded); its id is the topic root every later output
      // must reply into, so bind it before the first turn finishes.
      const confirmation = await sendControlReply(event, user.openId, notice).catch(error => {
        log.warn?.('feishu-session-notify: confirmation reply failed', error)
        return null
      })
      const rootMessageId = confirmation?.messageId || parentOrRoot
      // `agents.create` normally keeps the id we minted; trust the Agent's own
      // id when it differs so turn/end lookups by session id still resolve.
      const boundId = String(agent.id || sessionId)
      bindings.sessions[boundId] = {
        sessionId: boundId,
        chatId: confirmation?.chatId || event.chat_id || '',
        chatName: entry.label,
        sessionTitle: `${entry.label} · 新会话`,
        rootMessageId,
        cwd: entry.path,
        lastMessageIds: rootMessageId ? [rootMessageId] : [],
        updatedAt: Date.now(),
      }
      if (confirmation?.messageId) {
        bindings.messages[confirmation.messageId] = {
          sessionId: boundId,
          chatId: confirmation.chatId || event.chat_id || '',
          chatName: entry.label,
          createdAt: Date.now(),
        }
      }
      saveBindings(bindings)
      agent.followup({
        id: randomUUID(),
        role: 'user',
        source: { kind: 'feishu-new', chatId: event.chat_id, messageId: event.message_id || event.id, workspace: entry.path, at: Date.now() },
        content: [{ type: 'text', text: command.task }],
      })
      log.info?.(`feishu-session-notify: created session=${boundId} cwd=${entry.path} root=${rootMessageId}`)
    } catch (error) {
      log.warn?.('feishu-session-notify: create session failed', error)
      await sendControlReply(event, user.openId, `**创建会话失败**\n\n${error?.message || error}`)
    }
  }

  async function routeIncoming(event) {
    const incomingId = String(event?.message_id || event?.id || '').trim()
    if (incomingId && bindings.handledIncoming[incomingId]) return
    const eventTime = Number(event?.create_time || event?.timestamp || 0)
    if (incomingId && Number.isFinite(eventTime) && eventTime > 0 && consumerStartedAt - eventTime > STALE_EVENT_MS) {
      bindings.handledIncoming[incomingId] = Date.now()
      saveBindings(bindings)
      debugLog(`ignored stale incoming message=${incomingId} ageMs=${consumerStartedAt - eventTime}`)
      return
    }
    const user = await getUser()
    if (event?.sender_type === 'bot' || event?.sender_id !== user.openId) return
    const command = parseDshCommand(event?.content)
    if (command) {
      try {
        await handleDshCommand(event, command, user)
      } catch (error) {
        log.warn?.('feishu-session-notify: command failed', error)
        await sendControlReply(event, user.openId, `**命令执行失败**\n\n${error?.message || error}`).catch(() => {})
      }
      if (incomingId) {
        bindings.handledIncoming[incomingId] = Date.now()
        saveBindings(bindings)
      }
      return
    }
    const resolved = resolveIncomingBinding(event, bindings, user.openId)
    if (!resolved) return
    const { parentId, binding, text } = resolved
    const sessionBinding = bindings.sessions[binding.sessionId]
    if (sessionBinding && !sessionBinding.rootMessageId) {
      // If the user manually started a Feishu topic, adopt its root so all
      // later DSH outputs continue in that same thread.
      sessionBinding.rootMessageId = String(event.root_id || parentId)
      saveBindings(bindings)
    }

    let agent = ctx.agents?.get?.(binding.sessionId)
    if (!agent && ctx.agents?.resume) {
      try { agent = (await ctx.agents.resume({ resumeSessionId: binding.sessionId })).agent } catch (error) {
        log.warn?.(`feishu-session-notify: cannot resume ${binding.sessionId}`, error)
        return
      }
    }
    if (!agent?.followup) { log.warn?.(`feishu-session-notify: session unavailable ${binding.sessionId}`); return }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      source: { kind: 'feishu', chatId: event.chat_id, messageId: incomingId, replyTo: parentId, at: Date.now() },
      content: [{ type: 'text', text }],
    })
    if (incomingId) {
      bindings.handledIncoming[incomingId] = Date.now()
      saveBindings(bindings)
    }
    log.info?.(`feishu-session-notify: routed reply to session=${binding.sessionId}`)
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'assistant/message') {
        rememberAssistantText(String(session?.id ?? ''), Number(event?.data?.turn ?? 0), assistantTextFromEvent(event))
        return
      }
      if (event?.type === 'turn/end') {
        debugLog(`turn-end session=${session?.id || ''} kind=${event?.data?.reason?.kind || ''} seq=${event?.seq || ''}`)
        void notifyTurnEnd(session, event)
      }
    } catch (error) { log.warn?.('feishu-session-notify: session event handler failed', error) }
  })

  // Some DSH surfaces can emit agent/status without replaying all durable
  // session events to a late-mounted plugin. Use the non-running transition as
  // a lossless fallback for successful final text, while sentTextBySession
  // prevents duplicates when turn/end was already observed.
  ctx.on('agent/status', ({ agent, status }) => {
    try {
      const sessionId = String(agent?.id || agent?.session?.id || '')
      if (!sessionId) return
      if (status === 'running') {
        runningSessions.add(sessionId)
        return
      }
      if (!runningSessions.delete(sessionId)) return
      const session = agent?.session
      const text = assistantTextFromDerived(session)
      if (!text || sentTextBySession.get(sessionId) === text) return
      debugLog(`status-fallback session=${sessionId} status=${status}`)
      void notifyTurnEnd(session, { seq: Date.now(), data: { turn: 0, reason: { kind: 'completed' } } })
    } catch (error) { log.warn?.('feishu-session-notify: status fallback failed', error) }
  })

  // Start the receive stream only after the DSH host has mounted the agents service.
  void getUser().then(() => {
    consumer = startIncomingConsumer({ onEvent: event => void routeIncoming(event), log })
    log.info?.('feishu-session-notify: listening for Feishu replies')
  }).catch(error => log.warn?.('feishu-session-notify: incoming listener not started', error))

  // Late catch-up pass: a turn that ended during the previous shutdown never
  // reached `turn/end`, so deliver it once the host has reloaded the sessions.
  const catchUpTimer = setTimeout(() => { void catchUpMissedTurns() }, 8000)
  catchUpTimer.unref?.()

  // The host owns this plugin fiber; do not bind the child to a short-lived
  // disposable context. The host process will reap it on shutdown.
  log.info?.('feishu-session-notify: listening for completed DSH turns (no model call)')
}
