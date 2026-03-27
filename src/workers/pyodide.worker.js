let pyodide = null
let heartbeatInterval = null
let stdoutBuffer = ''
let stderrBuffer = ''
let flushInterval = null
let workspaceHandle = null
let workspaceMount = null
let stdinBuffer = null
let stdinSignalView = null
let stdinBytesView = null
let baseUrl = '/'
let initializationPromise = null
const textDecoder = new TextDecoder()
const STDIN_SIGNAL_INDEX = 0
const STDIN_LENGTH_INDEX = 1
const STDIN_HEADER_INTS = 2
const STDIN_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * STDIN_HEADER_INTS
const PACKAGE_IMPORT_PATTERNS = [
  { packageName: 'pandas', pattern: /^\s*(?:from\s+pandas\b|import\s+pandas\b)/m },
  { packageName: 'numpy', pattern: /^\s*(?:from\s+numpy\b|import\s+numpy\b)/m },
]

function normalizeErrorMessage(err) {
  const message = err?.message || String(err)
  return message.replace(/\n?PythonError\s*$/u, '')
}

function flushBufferedOutput() {
  if (stdoutBuffer.length > 0) {
    self.postMessage({ type: 'stdout', data: stdoutBuffer })
    stdoutBuffer = ''
  }

  if (stderrBuffer.length > 0) {
    self.postMessage({ type: 'stderr', data: stderrBuffer })
    stderrBuffer = ''
  }
}

function startFlushInterval() {
  flushInterval = setInterval(() => {
    flushBufferedOutput()
  }, 50)
}

function stopFlushInterval() {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = null
  }

  flushBufferedOutput()
}

function startHeartbeat() {
  heartbeatInterval = setInterval(() => {
    self.postMessage({ type: 'heartbeat' })
  }, 1000)
}

function sendHeartbeat() {
  self.postMessage({ type: 'heartbeat' })
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
}

function getPyodideAssetUrls() {
  const baseHref = new URL(baseUrl, self.location.origin)
  return {
    indexURL: new URL('pyodide/', baseHref).toString(),
    scriptURL: new URL('pyodide/pyodide.js', baseHref).toString(),
    lockFileURL: new URL('pyodide/pyodide-lock.json', baseHref).toString(),
  }
}

function initWorker({ stdinBuffer: incomingStdinBuffer, baseUrl: incomingBaseUrl } = {}) {
  if (typeof incomingBaseUrl === 'string' && incomingBaseUrl.length > 0) {
    baseUrl = incomingBaseUrl
  }

  const hasSharedArrayBuffer =
    typeof SharedArrayBuffer === 'function' &&
    incomingStdinBuffer instanceof SharedArrayBuffer

  stdinBuffer = hasSharedArrayBuffer ? incomingStdinBuffer : null
  stdinSignalView = stdinBuffer
    ? new Int32Array(stdinBuffer, 0, STDIN_HEADER_INTS)
    : null
  stdinBytesView = stdinBuffer
    ? new Uint8Array(stdinBuffer, STDIN_HEADER_BYTES)
    : null

  if (stdinSignalView) {
    Atomics.store(stdinSignalView, STDIN_SIGNAL_INDEX, 0)
    Atomics.store(stdinSignalView, STDIN_LENGTH_INDEX, 0)
  }

  if (!initializationPromise) {
    initializationPromise = initPyodide()
  }
}

function stdinHandler(prompt = '') {
  if (!stdinSignalView || !stdinBytesView) {
    throw new Error(
      '[WasmForge] Interactive stdin requires SharedArrayBuffer. Verify window.crossOriginIsolated === true on this origin.'
    )
  }

  flushBufferedOutput()
  Atomics.store(stdinSignalView, STDIN_LENGTH_INDEX, 0)
  Atomics.store(stdinSignalView, STDIN_SIGNAL_INDEX, 0)
  self.postMessage({ type: 'stdin_request', prompt: String(prompt ?? '') })
  Atomics.wait(stdinSignalView, STDIN_SIGNAL_INDEX, 0)

  const byteLength = Atomics.load(stdinSignalView, STDIN_LENGTH_INDEX)
  const valueBytes = new Uint8Array(byteLength)
  valueBytes.set(stdinBytesView.subarray(0, byteLength))
  const value = textDecoder.decode(valueBytes)

  Atomics.store(stdinSignalView, STDIN_LENGTH_INDEX, 0)
  Atomics.store(stdinSignalView, STDIN_SIGNAL_INDEX, 0)

  return value
}

async function mountWorkspace() {
  if (workspaceMount) {
    return
  }

  self.postMessage({ type: 'load_progress', msg: 'Mounting OPFS workspace...' })

  const rootHandle = await navigator.storage.getDirectory()
  workspaceHandle = await rootHandle.getDirectoryHandle('workspace', { create: true })
  workspaceMount = await pyodide.mountNativeFS('/workspace', workspaceHandle)

  pyodide.runPython(`
import os
import sys

os.chdir("/workspace")
if "/workspace" not in sys.path:
    sys.path.insert(0, "/workspace")
  `)
}

async function syncWorkspaceFromOpfs() {
  if (!workspaceHandle) {
    return
  }

  const opfsFiles = new Map()
  for await (const [name, handle] of workspaceHandle.entries()) {
    if (handle.kind !== 'file') {
      continue
    }

    const file = await handle.getFile()
    opfsFiles.set(name, await file.text())
  }

  const mountedFiles = pyodide.FS.readdir('/workspace').filter((name) => !['.', '..'].includes(name))
  for (const name of mountedFiles) {
    if (!opfsFiles.has(name)) {
      try {
        pyodide.FS.unlink(`/workspace/${name}`)
      } catch {
        // Ignore non-file entries for now.
      }
    }
  }

  for (const [name, content] of opfsFiles) {
    pyodide.FS.writeFile(`/workspace/${name}`, content, { encoding: 'utf8' })
  }
}

async function persistWorkspaceToOpfs() {
  if (workspaceMount) {
    await workspaceMount.syncfs()
  }
}

async function ensureLocalPackages(code) {
  if (!code) {
    return
  }

  const packagesToLoad = PACKAGE_IMPORT_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ packageName }) => packageName)

  if (packagesToLoad.length === 0) {
    return
  }

  self.postMessage({ type: 'load_progress', msg: 'Resolving local Python packages...' })
  await pyodide.loadPackage(packagesToLoad)
}

async function initPyodide() {
  try {
    const { indexURL, scriptURL, lockFileURL } = getPyodideAssetUrls()

    self.postMessage({ type: 'load_progress', msg: 'Loading Pyodide runtime from local assets...' })

    importScripts(scriptURL)

    self.postMessage({ type: 'load_progress', msg: 'Initializing offline Python interpreter...' })

    pyodide = await loadPyodide({
      indexURL,
      lockFileURL,
    })

    // Expose JS callbacks before overriding Python streams.
    pyodide.globals.set('postStdout', (s) => { stdoutBuffer += s })
    pyodide.globals.set('postStderr', (s) => { stderrBuffer += s })
    pyodide.globals.set('_wasmforgeStdin', stdinHandler)

    // Override sys.stdout and sys.stderr to capture Python output
    // and route it to our buffering system instead of the console.
    pyodide.runPython(`
import builtins
import sys

class _WasmForgeStdout:
    def write(self, s):
        if s:
            postStdout(s)
    def flush(self):
        pass

class _WasmForgeStderr:
    def write(self, s):
        if s:
            postStderr(s)
    def flush(self):
        pass

def _wasmforge_input(prompt=""):
    return _wasmforgeStdin(prompt)

sys.stdout = _WasmForgeStdout()
sys.stderr = _WasmForgeStderr()
builtins.input = _wasmforge_input
    `)

    self.postMessage({ type: 'load_progress', msg: 'Preloading numpy and pandas...' })
    await pyodide.loadPackage(['numpy', 'pandas'])

    self.postMessage({ type: 'ready' })

  } catch (err) {
    self.postMessage({ type: 'stderr', data: `[WasmForge] Failed to load Pyodide: ${err.message}\n` })
    self.postMessage({ type: 'done', error: err.message })
    initializationPromise = null
    pyodide = null
  }
}

async function runPython(code, filename = 'main.py') {
  if (initializationPromise) {
    await initializationPromise
  }

  if (!pyodide) {
    self.postMessage({ type: 'stderr', data: '[WasmForge] Runtime not ready. Please wait.\n' })
    self.postMessage({ type: 'done', error: 'Runtime not ready' })
    return
  }

  stopHeartbeat()
  stopFlushInterval()
  sendHeartbeat()
  startHeartbeat()
  startFlushInterval()

  let error = null

  try {
    await mountWorkspace()
    await syncWorkspaceFromOpfs()
    await ensureLocalPackages(code)

    const workspacePath = `/workspace/${filename}`
    pyodide.FS.writeFile(workspacePath, code, { encoding: 'utf8' })

    await pyodide.runPythonAsync(`
import os
import runpy

os.chdir("/workspace")
runpy.run_path(${JSON.stringify(workspacePath)}, run_name="__main__")
    `)
  } catch (err) {
    const errorMsg = normalizeErrorMessage(err).trim()
    if (errorMsg) {
      self.postMessage({ type: 'stderr', data: `\n${errorMsg}\n` })
    }
    error = errorMsg || 'Python execution failed'
  } finally {
    try {
      await persistWorkspaceToOpfs()
    } catch (syncErr) {
      const syncMessage = `[WasmForge] Failed to sync workspace: ${syncErr.message || syncErr}\n`
      self.postMessage({ type: 'stderr', data: `\n${syncMessage}` })
      error ||= syncMessage.trim()
    }

    stopHeartbeat()
    stopFlushInterval()
    self.postMessage({ type: 'done', error })
  }
}

self.onmessage = async (event) => {
  const {
    type,
    code,
    filename,
    stdinBuffer: incomingStdinBuffer,
    baseUrl: incomingBaseUrl,
  } = event.data

  switch (type) {
    case 'init':
      initWorker({
        stdinBuffer: incomingStdinBuffer,
        baseUrl: incomingBaseUrl,
      })
      break

    case 'run':
      await runPython(code, filename)
      break

    case 'kill':
      stopHeartbeat()
      stopFlushInterval()
      self.postMessage({ type: 'done', error: 'Execution killed by user' })
      break

    default:
      console.warn('[WasmForge Worker] Unknown message type:', type)
  }
}
