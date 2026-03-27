import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const WS_BASE_URL = 'wss://38lntx2341.execute-api.us-east-1.amazonaws.com/prod'

type BotType = 'aidoc'

type SessionConfig = {
  bot: BotType
  sessionId: string
  userId: string
}

type BackendResponse = {
  response?: string
  sources?: unknown
  relevantDocsCount?: number
  timestamp?: string
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sourceNames?: string[]
  relevantDocsCount?: number
  timestamp?: string
}

type ViewStep = 'landing' | 'session' | 'chat'

const createRandomSessionId = () =>
  `sesion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const cleanSourceName = (value: string) => {
  const withoutQuery = value.split('?')[0]
  const normalized = withoutQuery.replaceAll('\\', '/')
  const basename = normalized.split('/').at(-1) ?? normalized
  const withoutNumericPrefix = basename.replace(/^\d{8,}[-_]/, '')
  const decoded = decodeURIComponent(withoutNumericPrefix)
  const withoutExtension = decoded.replace(/\.(pdf|docx?|txt|md)$/i, '')
  return withoutExtension.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

const sourceNameFromUnknown = (source: unknown) => {
  if (typeof source === 'string') {
    return cleanSourceName(source)
  }
  if (!source || typeof source !== 'object') {
    return null
  }
  const record = source as Record<string, unknown>
  const candidates = [
    record.name,
    record.fileName,
    record.filename,
    record.path,
    record.source,
    record.title,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return cleanSourceName(candidate)
    }
  }
  return null
}

const extractSourceNames = (sources: unknown) => {
  if (!Array.isArray(sources)) {
    return []
  }
  const unique = new Map<string, string>()
  for (const source of sources) {
    const name = sourceNameFromUnknown(source)
    if (name) {
      const key = name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
      if (!unique.has(key)) {
        unique.set(key, name)
      }
    }
  }
  return Array.from(unique.values())
}

const splitResponseAndSources = (value: string) => {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return {
      content: '',
      sourceNames: [] as string[],
    }
  }

  const sourcesInText = new Set<string>()
  const uploadMatches = trimmedValue.match(/uploads\/[^\s,\n)]+/gi) ?? []
  for (const match of uploadMatches) {
    const cleaned = cleanSourceName(match)
    if (cleaned) {
      sourcesInText.add(cleaned)
    }
  }

  const splitByFuentes = trimmedValue.split(/\n?\s*fuentes:\s*/i)
  const mainContent = splitByFuentes[0] ?? trimmedValue
  const content = mainContent
    .replace(/uploads\/[^\s,\n)]+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    content,
    sourceNames: Array.from(sourcesInText),
  }
}

const mergeUniqueSources = (...groups: string[][]) => {
  const unique = new Map<string, string>()
  for (const group of groups) {
    for (const name of group) {
      const key = name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
      if (!unique.has(key)) {
        unique.set(key, name)
      }
    }
  }
  return Array.from(unique.values())
}

const cleanAssistantMessage = (value: string) => {
  const lines = value.split('\n')
  const filtered = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return true
    }
    if (/^fuentes:?\s*$/i.test(trimmed)) {
      return false
    }
    if (/^uploads\//i.test(trimmed)) {
      return false
    }
    return true
  })
  return filtered.join('\n').trim()
}

type AssistantResponseProps = {
  content: string
}

function AssistantResponse({ content }: AssistantResponseProps) {
  const [visibleText, setVisibleText] = useState('')

  useEffect(() => {
    let cursor = 0
    let timeoutId: number | null = null

    const writeNext = () => {
      const remaining = content.length - cursor
      const chunkSize = remaining > 260 ? 8 : remaining > 140 ? 5 : 3
      cursor = Math.min(content.length, cursor + chunkSize)
      setVisibleText(content.slice(0, cursor))
      if (cursor < content.length) {
        timeoutId = window.setTimeout(writeNext, 16)
      }
    }

    timeoutId = window.setTimeout(writeNext, 16)

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [content])

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {visibleText || ' '}
    </ReactMarkdown>
  )
}

function App() {
  const [viewStep, setViewStep] = useState<ViewStep>('landing')
  const [selectedBot, setSelectedBot] = useState<BotType>('aidoc')
  const [sessionIdInput, setSessionIdInput] = useState(createRandomSessionId())
  const [userIdInput, setUserIdInput] = useState('')
  const [activeSession, setActiveSession] = useState<SessionConfig | null>(null)
  const [connectionState, setConnectionState] = useState<
    'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
  >('idle')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messageInput, setMessageInput] = useState('')
  const [isAssistantTyping, setIsAssistantTyping] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const manualCloseRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const statusLabel = useMemo(() => {
    if (!activeSession) {
      return 'Sin sesión activa'
    }
    if (connectionState === 'connecting') {
      return 'Conectando...'
    }
    if (connectionState === 'connected') {
      return `Conectado · sessionId: ${activeSession.sessionId}`
    }
    if (connectionState === 'error') {
      return 'Error de conexión'
    }
    return 'Desconectado'
  }, [activeSession, connectionState])

  const addMessage = (message: Omit<ChatMessage, 'id'>) => {
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        ...message,
      },
    ])
  }

  const goToSession = () => {
    setViewStep('session')
  }

  const goToLanding = () => {
    manualCloseRef.current = true
    socketRef.current?.close()
    socketRef.current = null
    setViewStep('landing')
    setActiveSession(null)
    setConnectionState('idle')
    setMessages([])
    setMessageInput('')
    setUserIdInput('')
    setSessionIdInput(createRandomSessionId())
    setIsAssistantTyping(false)
  }

  const connectChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const sessionId = sessionIdInput.trim()
    const userId = userIdInput.trim()
    if (!sessionId || !userId) {
      return
    }

    setMessages([])
    setConnectionState('connecting')
    setMessageInput('')
    setIsAssistantTyping(false)
    setViewStep('chat')
    setActiveSession({
      bot: selectedBot,
      sessionId,
      userId,
    })
  }

  const startNewChat = () => {
    if (!activeSession) {
      return
    }
    const nextSessionId = createRandomSessionId()
    manualCloseRef.current = true
    socketRef.current?.close()
    socketRef.current = null
    setConnectionState('connecting')
    setIsAssistantTyping(false)
    setMessages([])
    setMessageInput('')
    setSessionIdInput(nextSessionId)
    setActiveSession({
      ...activeSession,
      sessionId: nextSessionId,
    })
  }

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const socket = socketRef.current
    const text = messageInput.trim()

    if (!socket || socket.readyState !== WebSocket.OPEN || !text) {
      return
    }

    addMessage({
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    })

    setIsAssistantTyping(true)
    setMessageInput('')
    socket.send(
      JSON.stringify({
        action: 'sendMessage',
        message: text,
      }),
    )
  }

  useEffect(() => {
    if (!activeSession) {
      return
    }

    manualCloseRef.current = false

    const socketUrl = `${WS_BASE_URL}?sessionId=${encodeURIComponent(activeSession.sessionId)}&userId=${encodeURIComponent(activeSession.userId)}`
    const ws = new WebSocket(socketUrl)
    socketRef.current = ws

    ws.onopen = () => {
      setConnectionState('connected')
    }

    ws.onmessage = (event) => {
      setIsAssistantTyping(false)
      try {
        const parsed: BackendResponse = JSON.parse(String(event.data))
        if (parsed.response || parsed.sources) {
          const fromBackend = extractSourceNames(parsed.sources)
          const split = splitResponseAndSources(parsed.response ?? '')
          const unifiedSources = mergeUniqueSources(
            fromBackend,
            split.sourceNames,
          )
          addMessage({
            role: 'assistant',
            content: cleanAssistantMessage(split.content),
            sourceNames: unifiedSources,
            relevantDocsCount: parsed.relevantDocsCount ?? 0,
            timestamp: parsed.timestamp,
          })
          return
        }
      } catch {
        addMessage({
          role: 'assistant',
          content: String(event.data),
        })
        return
      }
      addMessage({
        role: 'assistant',
        content: String(event.data),
      })
    }

    ws.onerror = () => {
      setConnectionState('error')
      setIsAssistantTyping(false)
      addMessage({
        role: 'system',
        content: 'No se pudo conectar al servidor.',
      })
    }

    ws.onclose = () => {
      setIsAssistantTyping(false)
      setConnectionState((current) => (current === 'error' ? current : 'disconnected'))
      if (!manualCloseRef.current) {
        addMessage({
          role: 'system',
          content: 'La conexión se cerró.',
        })
      }
    }

    return () => {
      manualCloseRef.current = true
      ws.close()
      socketRef.current = null
    }
  }, [activeSession])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    })
  }, [messages, isAssistantTyping])

  return (
    <main className="app-shell">
      {viewStep === 'landing' ? (
        <section className="landing">
          <div className="landing-card">
            <p className="eyebrow">MEDISMART · AI CHAT</p>
            <h1>Selecciona tu asistente</h1>
            <p className="subtitle">
              Elige el bot clínico con el que quieres trabajar y continúa a la
              configuración de sesión.
            </p>
            <button
              className={`bot-tile ${selectedBot === 'aidoc' ? 'selected' : ''}`}
              onClick={() => setSelectedBot('aidoc')}
              type="button"
            >
              <span>AIDOC</span>
              <small>Asistente clínico documental</small>
            </button>
            <button className="primary-btn" type="button" onClick={goToSession}>
              Continuar
            </button>
          </div>
        </section>
      ) : null}

      {viewStep === 'session' ? (
        <section className="session">
          <div className="session-card">
            <p className="eyebrow">CONFIGURACIÓN</p>
            <h2>Conectar sesión</h2>
            <p className="subtitle">
              Bot seleccionado: <strong>{selectedBot.toUpperCase()}</strong>
            </p>
            <form className="session-form" onSubmit={connectChat}>
              <label>
                User ID
                <input
                  value={userIdInput}
                  onChange={(event) => setUserIdInput(event.target.value)}
                  placeholder="ej: doctor-01"
                  required
                />
              </label>
              <label>
                Session ID
                <input
                  value={sessionIdInput}
                  onChange={(event) => setSessionIdInput(event.target.value)}
                  required
                />
              </label>
              <div className="actions-row">
                <button type="button" className="ghost-btn" onClick={goToLanding}>
                  Volver
                </button>
                <button type="submit" className="primary-btn">
                  Iniciar chat
                </button>
              </div>
            </form>
          </div>
        </section>
      ) : null}

      {viewStep === 'chat' ? (
        <section className="chat-layout">
          <header className="chat-topbar">
            <div>
              <h3>AIDOC</h3>
              <p>{statusLabel}</p>
            </div>
            <div className="actions-row">
              <button type="button" className="ghost-btn" onClick={goToSession}>
                Cambiar datos
              </button>
              <button type="button" className="primary-btn" onClick={startNewChat}>
                Nuevo chat
              </button>
            </div>
          </header>

          <div className="messages-panel">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span className="message-author">
                  {message.role === 'assistant'
                    ? 'Aidoc'
                    : message.role === 'user'
                      ? 'Tú'
                      : 'Sistema'}
                </span>
                <div className="message-body">
                  {message.role === 'assistant' ? (
                    <AssistantResponse content={message.content} />
                  ) : (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {message.content}
                    </ReactMarkdown>
                  )}
                </div>
                {message.role === 'assistant' ? (
                  <div className="message-meta">
                    <small>Documentos relevantes: {message.relevantDocsCount ?? 0}</small>
                    {message.sourceNames && message.sourceNames.length > 0 ? (
                      <ul className="document-list">
                        {message.sourceNames.map((source) => (
                          <li key={source}>
                            <span className="document-dot"></span>
                            {source}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}

            {isAssistantTyping ? (
              <article className="message assistant typing">
                <span className="message-author">Aidoc</span>
                <div className="typing-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </article>
            ) : null}
            <div ref={messagesEndRef}></div>
          </div>

          <form className="compose" onSubmit={sendMessage}>
            <input
              value={messageInput}
              onChange={(event) => setMessageInput(event.target.value)}
              placeholder="Escribe tu mensaje clínico..."
              disabled={connectionState !== 'connected'}
            />
            <button
              type="submit"
              className="primary-btn"
              disabled={
                connectionState !== 'connected' ||
                isAssistantTyping ||
                !messageInput.trim()
              }
            >
              Enviar
            </button>
          </form>
        </section>
      ) : null}
    </main>
  )
}

export default App
