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
import { randomUUID } from 'node:crypto'

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
export const inject = ['agents', 'sessionTitle']

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
    timeout: 30_000,
  })
  return stdout
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

async function sendToFeishu(openId, text, sessionId, seq, chatName, bindings, threadRootId = '') {
  const pieces = chunks(text)
  const sent = []
  let rootId = threadRootId
  for (let index = 0; index < pieces.length; index += 1) {
    const marker = pieces.length > 1 ? ` [${index + 1}/${pieces.length}]` : ''
    const isRoot = !rootId && index === 0
    // Use Feishu Markdown so bold, code blocks and lists render as rich text.
    // The first message is the topic root; all later messages stay in its thread.
    const body = isRoot
      ? `**${chatName || DEFAULT_CHAT_NAME}**${marker}\n\n${pieces[index]}`
      : `${marker ? `**${marker.trim()}**\n\n` : ''}${pieces[index]}`
    const idempotencyKey = `dsh-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)}-${seq}-${index + 1}`
    const args = isRoot
      ? [
          'im', '+messages-send', '--as', 'bot', '--user-id', openId,
          '--markdown', body,
        ]
      : [
          'im', '+messages-reply', '--as', 'bot', '--message-id', rootId,
          '--reply-in-thread', '--markdown', body,
        ]
    const raw = await runLark([...args, '--idempotency-key', idempotencyKey.slice(0, 50), '--format', 'json'])
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
    if (!text) { log.warn?.('feishu-session-notify: turn had no output or error text'); return }

    notified.add(key)
    try {
      const user = await getUser()
      const existing = Object.values(bindings.sessions).find(item => item.sessionId === sessionId)
      // Use the DSH conversation title, not the Feishu chat/bot name.
      const conversationName = sessionTitleOf(ctx, session) || existing?.sessionTitle || existing?.chatName || DEFAULT_CHAT_NAME
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
        updatedAt: Date.now(),
      }
      saveBindings(bindings)
      log.info?.(`feishu-session-notify: sent session=${sessionId} turn=${turn} messages=${sent.length} root=${result.rootId || ''}`)
    } catch (error) {
      notified.delete(key)
      log.warn?.('feishu-session-notify: send failed', error)
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
      if (event?.type === 'turn/end') void notifyTurnEnd(session, event)
    } catch (error) { log.warn?.('feishu-session-notify: session event handler failed', error) }
  })

  // Start the receive stream only after the DSH host has mounted the agents service.
  void getUser().then(() => {
    consumer = startIncomingConsumer({ onEvent: event => void routeIncoming(event), log })
    log.info?.('feishu-session-notify: listening for Feishu replies')
  }).catch(error => log.warn?.('feishu-session-notify: incoming listener not started', error))

  // The host owns this plugin fiber; do not bind the child to a short-lived
  // disposable context. The host process will reap it on shutdown.
  log.info?.('feishu-session-notify: listening for completed DSH turns (no model call)')
}
