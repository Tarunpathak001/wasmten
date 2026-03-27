import { transform } from 'sucrase'

const OUTPUT_FLUSH_MS = 50
const DEFAULT_FILENAME = 'main.js'

let stdoutBuffer = ''
let stderrBuffer = ''
let flushInterval = null
let isRunning = false
let executionError = null
let runnerSettled = false
let pendingMicrotasks = 0
let pendingAsyncCallbacks = 0
let completionResolver = null
const timerHandles = new Map()

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

function maybeFinishExecution() {
  if (
    runnerSettled &&
    timerHandles.size === 0 &&
    pendingMicrotasks === 0 &&
    pendingAsyncCallbacks === 0 &&
    completionResolver
  ) {
    const resolve = completionResolver
    completionResolver = null
    resolve()
  }
}

function waitForPendingAsyncWork() {
  if (
    timerHandles.size === 0 &&
    pendingMicrotasks === 0 &&
    pendingAsyncCallbacks === 0
  ) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    completionResolver = resolve
  })
}

function clearTrackedTimers() {
  for (const [handle, kind] of timerHandles) {
    if (kind === 'interval') {
      clearInterval(handle)
    } else {
      clearTimeout(handle)
    }
  }

  timerHandles.clear()
  maybeFinishExecution()
}

function trackTimer(handle, kind) {
  timerHandles.set(handle, kind)
  return handle
}

function untrackTimer(handle) {
  timerHandles.delete(handle)
  maybeFinishExecution()
}

function resetExecutionState() {
  clearTrackedTimers()
  executionError = null
  runnerSettled = false
  pendingMicrotasks = 0
  pendingAsyncCallbacks = 0
  completionResolver = null
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

function validateRuntimeSource(source, filename) {
  const fileName = String(filename || DEFAULT_FILENAME)
  const code = String(source ?? '')

  if (/^\s*(?:import|export)\s/m.test(code)) {
    throw new Error('ES module syntax is not supported in the JS worker yet.')
  }

  if (!/\.ts$/i.test(fileName)) {
    return
  }

  if (/^\s*import\s+[^=\n]+\s*=\s*require\s*\(/m.test(code)) {
    throw new Error('TypeScript import=require syntax is not supported in the JS worker.')
  }

  if (/^\s*export\s*=\s*/m.test(code)) {
    throw new Error('TypeScript export= syntax is not supported in the JS worker.')
  }

  if (/^\s*(?:namespace|module)\s+\w+/m.test(code)) {
    throw new Error('TypeScript namespace syntax is not supported in the JS worker.')
  }
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

  validateRuntimeSource(code, fileName)

  if (/\.tsx$/i.test(fileName)) {
    throw new Error('TSX/JSX execution is not supported in the JS worker yet.')
  }

  if (/\.ts$/i.test(fileName)) {
    code = transpileTypeScript(code, fileName)
  }

  if (/\brequire\s*\(/m.test(code) || /\bmodule\.exports\b/m.test(code) || /\bexports\./m.test(code)) {
    throw new Error('CommonJS module syntax is not supported in the JS worker.')
  }

  return `${code}\n//# sourceURL=${buildSourceUrl(fileName)}`
}

function reportExecutionError(errorLike) {
  const message = errorLike?.stack || errorLike?.message || String(errorLike)

  if (!executionError) {
    executionError = message
  }

  appendOutput('stderr', `${message}\n`)
  clearTrackedTimers()
}

async function invokeCallback(callback, args = []) {
  pendingAsyncCallbacks += 1

  try {
    await callback(...args)
  } catch (error) {
    reportExecutionError(error)
  } finally {
    pendingAsyncCallbacks -= 1
    maybeFinishExecution()
  }
}

function queueMicrotaskProxy(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('queueMicrotask callback must be a function')
  }

  pendingMicrotasks += 1
  queueMicrotask(() => {
    void Promise.resolve()
      .then(() => callback())
      .catch((error) => {
        reportExecutionError(error)
      })
      .finally(() => {
        pendingMicrotasks -= 1
        maybeFinishExecution()
      })
  })
}

function createSandboxScope() {
  const consoleProxy = createConsoleProxy()
  const sandboxGlobal = Object.create(null)

  const setTimeoutProxy = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') {
      throw new TypeError('setTimeout callback must be a function')
    }

    let handle = null
    const wrapped = () => {
      untrackTimer(handle)
      void invokeCallback(callback, args)
    }

    handle = setTimeout(wrapped, delay)
    return trackTimer(handle, 'timeout')
  }

  const setIntervalProxy = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') {
      throw new TypeError('setInterval callback must be a function')
    }

    let handle = null
    const wrapped = () => {
      void invokeCallback(callback, args)
    }

    handle = setInterval(wrapped, delay)
    return trackTimer(handle, 'interval')
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
    queueMicrotask: queueMicrotaskProxy,
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
    Error,
    EvalError,
    Float32Array,
    Float64Array,
    Infinity,
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
    Function: undefined,
    eval: undefined,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    performance,
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

function createWorkerErrorHandlers() {
  const handleUnhandledRejection = (event) => {
    event.preventDefault?.()
    reportExecutionError(event.reason || new Error('Unhandled promise rejection'))
  }

  const handleWorkerError = (event) => {
    if (!isRunning) {
      return
    }

    event.preventDefault?.()
    reportExecutionError(event.error || new Error(event.message || 'Unhandled worker error'))
  }

  self.addEventListener('unhandledrejection', handleUnhandledRejection)
  self.addEventListener('error', handleWorkerError)

  return () => {
    self.removeEventListener('unhandledrejection', handleUnhandledRejection)
    self.removeEventListener('error', handleWorkerError)
  }
}

async function runUserCode(code, filename) {
  if (isRunning) {
    throw new Error('A JS/TS program is already running')
  }

  isRunning = true
  resetExecutionState()
  startFlushing()
  postStatus(/\.ts$/i.test(filename || '') ? 'Transpiling TypeScript...' : 'Executing JavaScript...')

  const cleanupErrorHandlers = createWorkerErrorHandlers()

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
    runnerSettled = true
    maybeFinishExecution()
    await waitForPendingAsyncWork()
  } catch (error) {
    reportExecutionError(error)
  } finally {
    cleanupErrorHandlers()
    clearTrackedTimers()
    stopFlushing()
    isRunning = false
    self.postMessage({ type: 'done', error: executionError })
    postStatus('JS/TS runtime ready')
    resetExecutionState()
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
      resetExecutionState()
      break

    default:
      self.postMessage({
        type: 'stderr',
        data: `[WasmForge] Unknown JS worker message type: ${type}\n`,
      })
  }
}
