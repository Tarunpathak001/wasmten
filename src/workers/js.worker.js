import { transform } from 'sucrase'

const OUTPUT_FLUSH_MS = 50
const DEFAULT_FILENAME = 'main.js'

let stdoutBuffer = ''
let stderrBuffer = ''
let flushInterval = null
let isRunning = false
const timerHandles = new Set()

function postStatus(status) {
  self.postMessage({ type: 'status', status })
}

function appendOutput(kind, text) {
  if (!text) {
    return
  }

  if (kind === 'stderr') {
    stderrBuffer += text
    return
  }

  stdoutBuffer += text
}

function flushOutput() {
  if (stdoutBuffer.length > 0) {
    self.postMessage({ type: 'stdout', data: stdoutBuffer })
    stdoutBuffer = ''
  }

  if (stderrBuffer.length > 0) {
    self.postMessage({ type: 'stderr', data: stderrBuffer })
    stderrBuffer = ''
  }
}

function startFlushing() {
  if (!flushInterval) {
    flushInterval = setInterval(flushOutput, OUTPUT_FLUSH_MS)
  }
}

function stopFlushing() {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = null
  }

  flushOutput()
}

function clearTrackedTimers() {
  for (const handle of timerHandles) {
    clearTimeout(handle)
    clearInterval(handle)
  }
  timerHandles.clear()
}

function trackTimer(handle) {
  timerHandles.add(handle)
  return handle
}

function untrackTimer(handle) {
  timerHandles.delete(handle)
}

function isErrorLike(value) {
  return value instanceof Error || (value && typeof value === 'object' && 'message' in value)
}

function stringifyValue(value) {
  if (value === null) {
    return 'null'
  }

  if (value === undefined) {
    return 'undefined'
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  if (typeof value === 'symbol') {
    return value.toString()
  }

  if (isErrorLike(value)) {
    return value.stack || value.message || String(value)
  }

  const seen = new WeakSet()
  try {
    return JSON.stringify(
      value,
      (_, currentValue) => {
        if (typeof currentValue === 'object' && currentValue !== null) {
          if (seen.has(currentValue)) {
            return '[Circular]'
          }
          seen.add(currentValue)
        }
        return currentValue
      },
      2,
    ) || String(value)
  } catch {
    return String(value)
  }
}

function formatConsoleArgs(args) {
  return args.map(stringifyValue).join(' ')
}

function createConsoleProxy() {
  const writeStdout = (...args) => {
    appendOutput('stdout', `${formatConsoleArgs(args)}\n`)
  }

  return {
    log: writeStdout,
    info: writeStdout,
    debug: writeStdout,
    warn: (...args) => {
      appendOutput('stderr', `[warn] ${formatConsoleArgs(args)}\n`)
    },
    error: (...args) => {
      appendOutput('stderr', `[error] ${formatConsoleArgs(args)}\n`)
    },
    table: writeStdout,
    dir: writeStdout,
    trace: (...args) => {
      appendOutput('stderr', `[trace] ${formatConsoleArgs(args)}\n`)
    },
    clear: () => {
      appendOutput('stdout', '\x1b[2J\x1b[0;0H')
    },
  }
}

function stripExportKeywords(source) {
  return source
    .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?function|class|const|let|var)/gm, '')
}

function buildSourceUrl(filename) {
  const safeFilename = String(filename || DEFAULT_FILENAME)
    .replace(/[\n\r]+/g, '')
    .replace(/^\/+/u, '')

  return `wasmforge://${encodeURIComponent(safeFilename || DEFAULT_FILENAME)}`
}

function transpileTypeScript(source, filename) {
  const transformed = transform(source, {
    transforms: ['typescript'],
    filePath: filename,
    production: true,
  })

  return transformed.code
}

function normalizeRuntimeSource(source, filename) {
  const fileName = String(filename || DEFAULT_FILENAME)
  let code = String(source ?? '')

  if (/\.tsx$/i.test(fileName)) {
    throw new Error('TSX/JSX execution is not supported in the JS worker yet.')
  }

  if (/\.ts$/i.test(fileName)) {
    code = transpileTypeScript(code, fileName)
    code = stripExportKeywords(code)
  }

  if (/^\s*import\s/m.test(code)) {
    throw new Error('ES module imports are not supported in the JS worker yet.')
  }

  return `${code}\n//# sourceURL=${buildSourceUrl(fileName)}`
}

function createSandboxScope() {
  const consoleProxy = createConsoleProxy()
  const sandboxGlobal = Object.create(null)

  const setTimeoutProxy = (callback, delay = 0, ...args) => {
    return trackTimer(setTimeout(callback, delay, ...args))
  }

  const setIntervalProxy = (callback, delay = 0, ...args) => {
    return trackTimer(setInterval(callback, delay, ...args))
  }

  const clearTimeoutProxy = (handle) => {
    untrackTimer(handle)
    clearTimeout(handle)
  }

  const clearIntervalProxy = (handle) => {
    untrackTimer(handle)
    clearInterval(handle)
  }

  Object.assign(sandboxGlobal, {
    console: consoleProxy,
    globalThis: sandboxGlobal,
    self: sandboxGlobal,
    setTimeout: setTimeoutProxy,
    clearTimeout: clearTimeoutProxy,
    setInterval: setIntervalProxy,
    clearInterval: clearIntervalProxy,
    queueMicrotask,
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Array,
    ArrayBuffer,
    BigInt,
    BigInt64Array,
    BigUint64Array,
    Boolean,
    DataView,
    Date,
    Infinity,
    Error,
    EvalError,
    Float32Array,
    Float64Array,
    Int8Array,
    Int16Array,
    Int32Array,
    JSON,
    Map,
    Math,
    NaN,
    Number,
    Object,
    Promise,
    RangeError,
    ReferenceError,
    RegExp,
    Set,
    String,
    Symbol,
    SyntaxError,
    TypeError,
    URIError,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    WeakMap,
    WeakSet,
    atob,
    btoa,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    Worker: undefined,
    importScripts: undefined,
    postMessage: undefined,
    close: undefined,
    navigator: undefined,
    location: undefined,
    caches: undefined,
    indexedDB: undefined,
    isFinite,
    isNaN,
    Function: undefined,
    eval: undefined,
    parseFloat,
    parseInt,
  })

  return new Proxy(sandboxGlobal, {
    has: () => true,
    get: (target, property) => {
      if (property === Symbol.unscopables) {
        return undefined
      }

      return target[property]
    },
    set: (target, property, value) => {
      target[property] = value
      return true
    },
  })
}

async function runUserCode(code, filename) {
  if (isRunning) {
    throw new Error('A JS/TS program is already running')
  }

  isRunning = true
  clearTrackedTimers()
  startFlushing()
  postStatus(/\.ts$/i.test(filename || '') ? 'Transpiling TypeScript...' : 'Executing JavaScript...')

  let error = null

  try {
    const executableSource = normalizeRuntimeSource(code, filename)
    const scope = createSandboxScope()
    const runner = new Function('scope', `
      return (async function () {
        with (scope) {
${executableSource}
        }
      }).call(scope.globalThis)
    `)

    await runner(scope)
  } catch (err) {
    error = err?.stack || err?.message || String(err)
    appendOutput('stderr', `${error}\n`)
  } finally {
    clearTrackedTimers()
    stopFlushing()
    isRunning = false
    self.postMessage({ type: 'done', error })
    postStatus('JS/TS runtime ready')
  }
}

self.onmessage = async (event) => {
  const { type, code, filename } = event.data || {}

  switch (type) {
    case 'init':
      postStatus('JS/TS runtime ready')
      self.postMessage({ type: 'ready' })
      break

    case 'run':
      await runUserCode(code, filename || DEFAULT_FILENAME)
      break

    case 'kill':
      clearTrackedTimers()
      stopFlushing()
      isRunning = false
      self.postMessage({ type: 'done', error: 'Execution killed by user' })
      postStatus('JS/TS runtime ready')
      break

    default:
      self.postMessage({
        type: 'stderr',
        data: `[WasmForge] Unknown JS worker message type: ${type}\n`,
      })
  }
}
