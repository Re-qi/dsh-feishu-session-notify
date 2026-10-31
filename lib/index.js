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
const CONFIG_PATH = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh'), 'feishu-session-notify.json')

/**
 * A topic needs an entry point. Feishu keeps thread replies inside the topic
 * and a bot p2p chat only lists root messages, so the FIRST output of a
 * session is always posted as a normal message in the main window, and every
 * later output replies into the topic created from it — the thread is then
 * reachable by clicking that first message.
 *
 * `flat` mode is kept as an escape hatch for chats where topics are unwanted:
 * every turn becomes its own standalone message. Default is the hybrid above.
 * Override with feishu-session-notify.json {"thread": false} or
 * DSH_FEISHU_THREAD=0.
 */
function readConfig() {
  let fileConfig = {}
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object') fileConfig = parsed
  } catch { /* no config file: defaults */ }
  const envThread = process.env.DSH_FEISHU_THREAD
  const thread = envThread === undefined
    ? fileConfig.thread !== false
    : !/^(0|false|no)$/i.test(String(envThread).trim())
  // Both surfaces stay live by default: the desktop card shows the question as
  // usual and the same question is posted to Feishu, so the human can answer on
  // whichever they are looking at. Set {"feishuOnly": true} (or
  // DSH_FEISHU_ASK_ONLY=1) to suppress the desktop answerer once the Feishu
  // prompt is delivered.
  const envOnly = process.env.DSH_FEISHU_ASK_ONLY
  const feishuOnly = envOnly === undefined
    ? fileConfig.feishuOnly === true
    : !/^(0|false|no)$/i.test(String(envOnly).trim())
  return { thread, feishuOnly, path: CONFIG_PATH }
}

const CONFIG = readConfig()
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

/** Parse a Feishu reply that answers a pending approval prompt. */
export function parseApprovalReply(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^(取消|\/cancel|cancel|放弃)$/i.test(raw)) return 'cancel'
  if (/^(1|同意|允许|批准|可以|好|y|yes|ok)$/i.test(raw)) return 'allow'
  if (/^(2|拒绝|不行|不允许|不同意|n|no)$/i.test(raw)) return 'deny'
  return null
}

/**
 * Parse a Feishu reply that answers one pending question. Numbers select
 * options by their 1-based position; any other text becomes a custom answer.
 */
export function parseQuestionReply(value, question) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^(取消|\/cancel|cancel|跳过|skip)$/i.test(raw)) return { cancel: true }
  const options = Array.isArray(question?.options) ? question.options : []
  if (options.length === 0) return { selected: [], custom: raw }
  const parts = raw.split(/[,，、\s]+/).map(part => part.replace(/[.。、)）]$/, '')).filter(Boolean)
  const picked = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) { picked.length = 0; break }
    const index = Number(part)
    if (index < 1 || index > options.length) { picked.length = 0; break }
    const label = options[index - 1]?.label
    if (typeof label !== 'string') { picked.length = 0; break }
    picked.push(label)
  }
  if (picked.length === 0) return { selected: [], custom: raw }
  return { selected: question?.multiSelect === true ? picked : [picked[0]] }
}

/** The fixed reply hint every approval/question message ends with. */
const APPROVAL_FOOTER = '回复「1」允许、「2」拒绝，或回复「取消」放弃'
const QUESTION_FOOTER_OPTIONS = '回复选项编号（多选形如 1,3），或直接回复你的答案；回复「取消」跳过'
const QUESTION_FOOTER_FREE = '直接回复你的答案；回复「取消」跳过'

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

/** First message record out of any `messages-mget` response shape. */
function firstMessageRecord(data) {
  let found = null
  const walk = (node, depth) => {
    if (found || depth > 6 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && typeof item.message_id === 'string') { found = item; return }
        walk(item, depth + 1)
      }
      return
    }
    for (const value of Object.values(node)) walk(value, depth + 1)
  }
  walk(data, 0)
  return found
}

/**
 * Whether a message is a real main-window root. Feishu hides a topic's replies
 * inside the topic, so replying into a message that is itself a thread reply
 * buries every later answer one level deeper and nothing shows in the chat
 * window. Unknown answers keep the current behaviour instead of churning roots.
 */
async function isRealRoot(messageId) {
  try {
    const raw = await runLarkRetry(['im', '+messages-mget', '--as', 'bot', '--message-ids', messageId, '--format', 'json'])
    const record = firstMessageRecord(typeof raw === 'string' ? JSON.parse(raw) : raw)
    if (!record) return true
    return !record.thread_id && !record.parent_id
  } catch (error) {
    debugLog(`root verify failed id=${messageId}: ${String(error?.message || error).slice(0, 160)}`)
    return true
  }
}

async function sendToFeishu(openId, text, sessionId, seq, chatName, bindings, threadRootId = '', allowThread = CONFIG.thread) {
  const pieces = chunks(text)
  const sent = []
  // Topic mode needs an existing root to reply into; flat mode never threads.
  let rootId = allowThread ? threadRootId : ''
  if (rootId) {
    const binding = bindings?.sessions?.[sessionId]
    if (binding && binding.rootVerified !== true) {
      if (await isRealRoot(rootId)) {
        binding.rootVerified = true
      } else {
        debugLog(`root ${rootId} is a thread reply, not a main-window root; re-anchoring session=${sessionId}`)
        binding.rootMessageId = ''
        binding.rootVerified = false
        rootId = ''
      }
      try { saveBindings(bindings) } catch { /* best effort */ }
    }
  }
  for (let index = 0; index < pieces.length; index += 1) {
    const marker = pieces.length > 1 ? ` [${index + 1}/${pieces.length}]` : ''
    const titled = `**${chatName || DEFAULT_CHAT_NAME}**${marker}\n\n${pieces[index]}`
    const untitled = `${marker ? `**${marker.trim()}**\n\n` : ''}${pieces[index]}`
    const idempotencyKey = `dsh-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)}-${seq}-${index + 1}`
    let isRoot = !rootId
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
      // Only a message we posted as a ROOT can become a topic root.
      if (isRoot && allowThread && !rootId) {
        rootId = sentMessage.messageId
        const binding = bindings?.sessions?.[sessionId]
        if (binding) binding.rootVerified = true
      }
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
    if (!text && kind === 'completed') text = assistantTextFromDerived(session)
    if (kind !== 'completed') {
      const failure = failureTextFromReason(reason)
      text = text ? `${failure}\n\n${text}` : failure
    }
    if (!text) { debugLog(`skip session=${sessionId} seq=${seq}: no assistant or failure text`); return }
    // turn/end and the agent/status fallback can fire within the same second.
    // Claim the text BEFORE awaiting so the second path cannot send it again.
    if (sentTextBySession.get(sessionId) === text) {
      debugLog(`skip duplicate session=${sessionId} seq=${seq}`)
      return
    }

    notified.add(key)
    sentTextBySession.set(sessionId, text)
    try {
      const user = await getUser()
      const existing = Object.values(bindings.sessions).find(item => item.sessionId === sessionId)
      // Use the DSH conversation title, not the Feishu chat/bot name.
      const conversationName = sessionTitleOf(ctx, session) || existing?.sessionTitle || existing?.chatName || DEFAULT_CHAT_NAME
      debugLog(`sending session=${sessionId} seq=${seq} kind=${kind} chars=${text.length} chunks=${chunks(text).length} thread=${CONFIG.thread} root=${existing?.rootMessageId || ''}`)
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
      debugLog(`sent session=${sessionId} turn=${turn} messages=${sent.length} root=${result.rootId || ''}`)
    } catch (error) {
      notified.delete(key)
      sentTextBySession.delete(sessionId)
      debugLog(`SEND FAILED session=${sessionId} seq=${seq}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 400)}`)
      log.warn?.('feishu-session-notify: send failed', error)
    }
  }

  /**
   * Older versions adopted whatever message the user replied to as a topic
   * root, including messages that already live inside another topic. Every
   * later output then replied deeper into that topic and the main window stayed
   * empty. Verify every stored root once at startup (one batched API call) and
   * drop the ones that are not real roots, so the next output re-anchors a
   * visible message.
   */
  async function repairThreadRoots() {
    const sessions = Object.values(bindings.sessions || {}).filter(item => item?.rootMessageId)
    if (sessions.length === 0) return
    let changed = false
    const batchSize = 40
    for (let offset = 0; offset < sessions.length; offset += batchSize) {
      const batch = sessions.slice(offset, offset + batchSize)
      const ids = batch.map(item => item.rootMessageId)
      let raw
      try {
        raw = await runLarkRetry(['im', '+messages-mget', '--as', 'bot', '--message-ids', ids.join(','), '--format', 'json'])
      } catch (error) {
        debugLog(`root repair skipped: ${String(error?.message || error).slice(0, 160)}`)
        return
      }
      let data
      try { data = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
      const byId = new Map()
      const walk = (node, depth) => {
        if (depth > 6 || !node || typeof node !== 'object') return
        if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return }
        if (typeof node.message_id === 'string') byId.set(node.message_id, node)
        for (const value of Object.values(node)) walk(value, depth + 1)
      }
      walk(data, 0)
      for (const item of batch) {
        const record = byId.get(item.rootMessageId)
        if (!record) continue
        if (record.thread_id || record.parent_id) {
          debugLog(`root repair: ${item.rootMessageId} sits inside a topic; clearing session=${item.sessionId}`)
          item.rootMessageId = ''
          item.rootVerified = false
          changed = true
        } else {
          item.rootVerified = true
        }
      }
    }
    if (changed) {
      saveBindings(bindings)
      debugLog('root repair: cleared roots that were not main-window messages')
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

  /**
   * Reply to a control command. `asRoot` posts a standalone main-window message
   * instead of a topic reply — required whenever the message id is about to
   * become a session's topic root, because a thread reply as a root buries
   * every later answer inside that topic.
   */
  async function sendControlReply(event, userOpenId, markdown, options = {}) {
    const messageId = String(event?.message_id || event?.id || '').trim()
    const args = messageId && !options.asRoot
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
      // The confirmation is posted as a MAIN-WINDOW root: its id becomes the
      // topic root every later output replies into, and a thread reply here
      // would hide the whole session inside that topic.
      const confirmation = await sendControlReply(event, user.openId, notice, { asRoot: true }).catch(error => {
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
        rootVerified: Boolean(confirmation?.messageId),
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

  // ── approvals and questions ───────────────────────────────────────────────
  // DSH asks the human through two Cordis waterfalls (`approval/request` and
  // `user-questions/request`). This bridge answers both from Feishu without
  // calling any model: it posts the prompt, waits for the authorized user's
  // reply, and resolves with the vocabulary the in-page UI would have used.
  // The desktop card and Feishu race — whichever answers first wins.
  const pendingByKey = new Map() // key -> pending record
  const pendingByMessage = new Map() // feishu message id -> key
  const pendingBySession = new Map() // session id -> Set<key>

  function trackPending(record, messageId) {
    pendingByKey.set(record.key, record)
    let set = pendingBySession.get(record.sessionId)
    if (!set) { set = new Set(); pendingBySession.set(record.sessionId, set) }
    set.add(record.key)
    if (messageId) pendingByMessage.set(messageId, record.key)
  }

  function untrackPending(record) {
    pendingByKey.delete(record.key)
    const set = pendingBySession.get(record.sessionId)
    if (set) {
      set.delete(record.key)
      if (set.size === 0) pendingBySession.delete(record.sessionId)
    }
    for (const [id, key] of pendingByMessage) if (key === record.key) pendingByMessage.delete(id)
  }

  /** Post one prompt as a standalone message so it is visible and replyable. */
  async function postPrompt(sessionId, markdown) {
    const user = await getUser()
    const raw = await runLarkRetry([
      'im', '+messages-send', '--as', 'bot', '--user-id', user.openId,
      '--markdown', markdown,
      '--idempotency-key', `dsh-ask-${randomUUID().replace(/-/g, '').slice(0, 30)}`,
      '--format', 'json',
    ])
    const sent = messageIdFromSend(raw)
    if (sent.messageId) {
      bindings.messages[sent.messageId] = {
        sessionId,
        chatId: sent.chatId,
        chatName: '审批/提问',
        createdAt: Date.now(),
      }
      saveBindings(bindings)
    }
    return sent
  }

  /**
   * Only live root agents may ask the human. A delegated child has no human
   * answerer of its own, so surfacing its approval in Feishu would let one
   * click decide something the child was told to resolve itself.
   */
  function isHumanFacingAgent(agent) {
    if (!agent) return false
    try {
      const roots = ctx.agents?.roots?.()
      if (Array.isArray(roots) && roots.length > 0) return roots.includes(agent)
    } catch { /* registry shape changed: fall through and allow */ }
    return true
  }

  async function onApprovalRequest(request, next) {
    const agent = request?.agent
    if (!isHumanFacingAgent(agent)) return next()
    const sessionId = String(agent?.id || agent?.session?.id || '')
    if (!sessionId) return next()
    const record = { key: `approval:${randomUUID()}`, kind: 'approval', sessionId, done: false }
    const body = [
      '**需要审批**',
      '',
      '会话：' + (sessionTitleOf(ctx, agent?.session) || DEFAULT_CHAT_NAME),
      '工具：' + code(request?.toolName || '未知'),
      ...(request?.reason ? ['原因：' + code(request.reason)] : []),
      '',
      '1 · 允许一次',
      '2 · 拒绝',
      '',
      '———',
      APPROVAL_FOOTER,
    ].join('\n')
    let sent = null
    try { sent = await postPrompt(sessionId, body) } catch (error) {
      debugLog(`approval prompt failed session=${sessionId}: ${String(error?.message || error).slice(0, 200)}`)
    }
    // Nothing reached Feishu: the desktop answerer is the only surface left, so
    // hand the request back instead of waiting for a reply that cannot come.
    if (!sent?.messageId) return next()
    const ui = CONFIG.feishuOnly
      ? null
      : Promise.resolve().then(() => next()).catch(() => 'unavailable')
    return new Promise(resolve => {
      const finish = (value, note) => {
        if (record.done) return
        record.done = true
        untrackPending(record)
        debugLog(`approval answered session=${sessionId} outcome=${value}`)
        if (note) void postPrompt(sessionId, note).catch(() => {})
        resolve(value)
      }
      record.finish = finish
      trackPending(record, sent?.messageId)
      // 'unavailable' means no in-page answerer existed; keep waiting on Feishu
      // instead of failing the request closed.
      if (ui) ui.then(value => { if (value !== 'unavailable') finish(value) })
    })
  }

  async function onQuestionsRequest(request, next) {
    const agent = request?.agent
    if (!isHumanFacingAgent(agent)) return next()
    const sessionId = String(agent?.id || agent?.session?.id || '')
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!sessionId || questions.length === 0) return next()

    const answers = new Map()
    const records = []
    let settled = false
    let resolveBatch
    const batch = new Promise(resolve => { resolveBatch = resolve })
    const finishBatch = value => {
      if (settled) return
      settled = true
      for (const record of records) untrackPending(record)
      resolveBatch(value)
    }
    const maybeFinish = () => {
      if (answers.size < questions.length) return
      finishBatch({ answers: questions.map(question => answers.get(question.id) ?? { id: question.id, selected: [] }) })
    }

    let delivered = 0
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]
      const counter = questions.length > 1 ? `（${index + 1}/${questions.length}）` : ''
      const options = Array.isArray(question.options) ? question.options : []
      const lines = ['**需要你回答' + counter + '**', '']
      if (question.header) lines.push(`**${question.header}**`, '')
      lines.push(String(question.question || ''), '')
      options.forEach((option, optionIndex) => {
        lines.push(`${optionIndex + 1} · ${option.label}`)
        if (option.description) lines.push(`　${option.description}`)
      })
      if (options.length > 0) lines.push('')
      lines.push('———', options.length > 0 ? QUESTION_FOOTER_OPTIONS : QUESTION_FOOTER_FREE)

      const record = { key: `question:${question.id}:${randomUUID()}`, kind: 'question', sessionId, question, done: false }
      record.apply = (value, note) => {
        if (record.done) return
        record.done = true
        untrackPending(record)
        answers.set(question.id, value)
        debugLog(`question answered session=${sessionId} id=${question.id}`)
        if (note) void postPrompt(sessionId, note).catch(() => {})
        maybeFinish()
      }
      records.push(record)

      let sent = null
      try { sent = await postPrompt(sessionId, lines.join('\n')) } catch (error) {
        debugLog(`question prompt failed session=${sessionId}: ${String(error?.message || error).slice(0, 200)}`)
      }
      trackPending(record, sent?.messageId)
      if (sent?.messageId) delivered += 1
    }

    // No prompt reached Feishu: keep only the desktop answerer.
    if (delivered === 0) {
      for (const record of records) untrackPending(record)
      return next()
    }

    if (CONFIG.feishuOnly) return batch

    // Desktop fallback: the in-page UI answering the whole batch first wins.
    const ui = Promise.resolve().then(() => next()).catch(() => null)
    ui.then(value => {
      if (value && Array.isArray(value.answers)) finishBatch(value)
    })
    return batch
  }

  /**
   * Turn one Feishu reply into an approval outcome or a question answer.
   * Returns true when the reply belonged to a pending prompt, so the caller
   * must NOT also start a follow-up turn.
   */
  async function answerPendingFromFeishu(parentId, sessionId, text, event, user) {
    let record = null
    const key = pendingByMessage.get(parentId)
    if (key) record = pendingByKey.get(key) || null
    if (!record) {
      const open = [...(pendingBySession.get(sessionId) || [])]
        .map(pendingKey => pendingByKey.get(pendingKey))
        .filter(item => item && !item.done)
      if (open.length === 1) record = open[0]
      else if (open.length > 1) {
        await sendControlReply(event, user.openId, '**有多个待处理项**\n\n请直接回复对应的问题消息。')
        return true
      }
    }
    if (!record || record.done) return false

    if (record.kind === 'approval') {
      const verdict = parseApprovalReply(text)
      if (!verdict) {
        await sendControlReply(event, user.openId, `**没看懂这个回复**\n\n${APPROVAL_FOOTER}`)
        return true
      }
      if (verdict === 'allow') record.finish('allowed-once', '已允许。')
      else if (verdict === 'deny') record.finish('rejected', '已拒绝。')
      else record.finish('rejected', '已取消。')
      return true
    }

    const parsed = parseQuestionReply(text, record.question)
    if (!parsed) return true
    if (parsed.cancel) {
      record.apply({ id: record.question.id, selected: [] }, '已跳过这个问题。')
      return true
    }
    const answer = { id: record.question.id, selected: parsed.selected }
    if (parsed.custom !== undefined) answer.custom = parsed.custom
    record.apply(answer, '已记录答案：' + (parsed.custom ?? parsed.selected.join('、')))
    return true
  }

  ctx.on('approval/request', (request, next) => onApprovalRequest(request, next).catch(() => next()), { prepend: true })
  ctx.on('user-questions/request', (request, next) => onQuestionsRequest(request, next).catch(() => next()), { prepend: true })

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

    // A pending approval/question owns this reply: answering it must not also
    // run a normal follow-up turn.
    if (await answerPendingFromFeishu(parentId, binding.sessionId, text, event, user)) {
      if (incomingId) {
        bindings.handledIncoming[incomingId] = Date.now()
        saveBindings(bindings)
      }
      return
    }

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

  // Stored topic roots may predate the root check; fix them before the next
  // output would bury itself inside someone else's topic.
  const rootRepairTimer = setTimeout(() => { void repairThreadRoots() }, 4000)
  rootRepairTimer.unref?.()

  // The host owns this plugin fiber; do not bind the child to a short-lived
  // disposable context. The host process will reap it on shutdown.
  log.info?.('feishu-session-notify: listening for completed DSH turns (no model call)')
}
