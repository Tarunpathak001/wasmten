import { useRef, useEffect, useCallback, useState } from 'react'

const HEARTBEAT_TIMEOUT_MS = 4500 // Leave a little headroom under the 5s Phase 1 limit
const STDIN_BUFFER_BYTES = 4096
const STDIN_SIGNAL_INDEX = 0
const STDIN_LENGTH_INDEX = 1
const STDIN_HEADER_INTS = 2
const STDIN_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * STDIN_HEADER_INTS
const STDIN_MAX_BYTES = STDIN_BUFFER_BYTES - STDIN_HEADER_BYTES
const textEncoder = new TextEncoder()
const BASE_URL = import.meta.env.BASE_URL || '/'

function canUseSharedStdin() {
  return (
    typeof window !== 'undefined' &&
    window.crossOriginIsolated === true &&
    typeof SharedArrayBuffer === 'function'
  )
}

export function usePyodideWorker({
  onStdout,
  onStderr,
  onReady,
  onDone,
  onProgress,
  onStdinRequest,
}) {
  const workerRef = useRef(null)
  const watchdogRef = useRef(null)
  const spawnWorkerRef = useRef(null)
  const awaitingInputRef = useRef(false)
  const stdinBufferRef = useRef(null)
  const stdinSignalViewRef = useRef(null)
  const stdinBytesViewRef = useRef(null)
  const onStdoutRef = useRef(onStdout)
  const onStderrRef = useRef(onStderr)
  const onReadyRef = useRef(onReady)
  const onDoneRef = useRef(onDone)
  const onProgressRef = useRef(onProgress)
  const onStdinRequestRef = useRef(onStdinRequest)
  const [isReady, setIsReady] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [isAwaitingInput, setIsAwaitingInput] = useState(false)
  const [stdinSupported] = useState(() => canUseSharedStdin())

  useEffect(() => {
    onStdoutRef.current = onStdout
  }, [onStdout])

  useEffect(() => {
    onStderrRef.current = onStderr
  }, [onStderr])

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    onProgressRef.current = onProgress
  }, [onProgress])

  useEffect(() => {
    onStdinRequestRef.current = onStdinRequest
  }, [onStdinRequest])

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const clearStdinSignal = useCallback(() => {
    const signalView = stdinSignalViewRef.current
    if (!signalView) {
      return
    }

    Atomics.store(signalView, STDIN_SIGNAL_INDEX, 0)
    Atomics.store(signalView, STDIN_LENGTH_INDEX, 0)
  }, [])

  const createStdinChannel = useCallback(() => {
    if (!stdinSupported) {
      stdinBufferRef.current = null
      stdinSignalViewRef.current = null
      stdinBytesViewRef.current = null
      return null
    }

    const stdinBuffer = new SharedArrayBuffer(STDIN_BUFFER_BYTES)
    stdinBufferRef.current = stdinBuffer
    stdinSignalViewRef.current = new Int32Array(stdinBuffer, 0, STDIN_HEADER_INTS)
    stdinBytesViewRef.current = new Uint8Array(stdinBuffer, STDIN_HEADER_BYTES)
    clearStdinSignal()
    return stdinBuffer
  }, [clearStdinSignal, stdinSupported])

  const resetWatchdog = useCallback(() => {
    clearWatchdog()

    watchdogRef.current = setTimeout(() => {
      onStderrRef.current?.('\n[WasmForge] Execution timeout - infinite loop detected.\n')
      onStderrRef.current?.('[WasmForge] Terminating worker. Spawning fresh environment...\n\n')

      awaitingInputRef.current = false
      setIsAwaitingInput(false)

      if (workerRef.current) {
        workerRef.current.terminate()
      }

      setIsReady(false)
      setIsRunning(false)
      onDoneRef.current?.('Timeout: infinite loop killed')

      // Respawn clean worker automatically.
      spawnWorkerRef.current?.()
    }, HEARTBEAT_TIMEOUT_MS)
  }, [clearWatchdog])

  const spawnWorker = useCallback(() => {
    clearWatchdog()
    awaitingInputRef.current = false
    setIsAwaitingInput(false)

    if (workerRef.current) {
      workerRef.current.terminate()
    }

    setIsReady(false)
    setIsRunning(false)

    const worker = new Worker(
      new URL('../workers/pyodide.worker.js', import.meta.url),
      { type: 'classic' }
    )

    worker.onmessage = (event) => {
      const { type, data, msg, error, prompt } = event.data

      switch (type) {
        case 'ready':
          setIsReady(true)
          onReadyRef.current?.({
            stdinSupported,
            crossOriginIsolated:
              typeof window !== 'undefined' &&
              window.crossOriginIsolated === true,
          })
          break

        case 'stdout':
          onStdoutRef.current?.(data)
          break

        case 'stderr':
          onStderrRef.current?.(data)
          break

        case 'load_progress':
          onProgressRef.current?.(msg)
          break

        case 'heartbeat':
          if (!awaitingInputRef.current) {
            resetWatchdog()
          }
          break

        case 'stdin_request':
          awaitingInputRef.current = true
          setIsAwaitingInput(true)
          clearWatchdog()
          onStdinRequestRef.current?.(prompt ?? '')
          break

        case 'done':
          clearWatchdog()
          awaitingInputRef.current = false
          setIsAwaitingInput(false)
          setIsRunning(false)
          onDoneRef.current?.(error)
          break

        default:
          break
      }
    }

    worker.onerror = (err) => {
      console.error('[WasmForge] Worker error:', err)
      onStderrRef.current?.(`[WasmForge] Worker crashed: ${err.message}\n`)
      clearWatchdog()
      awaitingInputRef.current = false
      setIsAwaitingInput(false)
      setIsReady(false)
      setIsRunning(false)
      spawnWorkerRef.current?.()
    }

    workerRef.current = worker
    worker.postMessage({
      type: 'init',
      baseUrl: BASE_URL,
      stdinBuffer: createStdinChannel(),
    })
  }, [clearWatchdog, createStdinChannel, resetWatchdog, stdinSupported])

  spawnWorkerRef.current = spawnWorker

  const runCode = useCallback((payload) => {
    if (!workerRef.current || !isReady) {
      onStderrRef.current?.('[WasmForge] Runtime not ready yet. Please wait...\n')
      return
    }

    if (isRunning) {
      onStderrRef.current?.('[WasmForge] Already running. Kill the current execution first.\n')
      return
    }

    const execution = typeof payload === 'string'
      ? { code: payload, filename: 'main.py' }
      : payload

    clearStdinSignal()
    awaitingInputRef.current = false
    setIsAwaitingInput(false)
    setIsRunning(true)
    resetWatchdog()
    workerRef.current.postMessage({
      type: 'run',
      code: execution.code,
      filename: execution.filename,
    })
  }, [clearStdinSignal, isReady, isRunning, resetWatchdog])

  const submitStdin = useCallback((input) => {
    if (!awaitingInputRef.current) {
      onStderrRef.current?.('[WasmForge] No active input prompt.\n')
      return false
    }

    const signalView = stdinSignalViewRef.current
    const bytesView = stdinBytesViewRef.current
    if (!signalView || !bytesView) {
      onStderrRef.current?.(
        '[WasmForge] Shared stdin is unavailable. Verify window.crossOriginIsolated === true.\n'
      )
      return false
    }

    const encoded = textEncoder.encode(String(input ?? ''))
    if (encoded.byteLength > STDIN_MAX_BYTES) {
      onStderrRef.current?.(
        `[WasmForge] Input is too large (${encoded.byteLength} bytes). Max is ${STDIN_MAX_BYTES} bytes.\n`
      )
      return false
    }

    bytesView.set(encoded)
    Atomics.store(signalView, STDIN_LENGTH_INDEX, encoded.byteLength)
    Atomics.store(signalView, STDIN_SIGNAL_INDEX, 1)
    Atomics.notify(signalView, STDIN_SIGNAL_INDEX, 1)

    awaitingInputRef.current = false
    setIsAwaitingInput(false)
    resetWatchdog()
    return true
  }, [resetWatchdog])

  const killWorker = useCallback(() => {
    clearWatchdog()
    awaitingInputRef.current = false
    setIsAwaitingInput(false)

    if (workerRef.current) {
      workerRef.current.terminate()
    }

    onStderrRef.current?.('\n[WasmForge] Execution killed by user.\n')
    setIsReady(false)
    setIsRunning(false)
    onDoneRef.current?.('Killed by user')
    spawnWorkerRef.current?.()
  }, [clearWatchdog])

  useEffect(() => {
    spawnWorker()

    return () => {
      clearWatchdog()
      if (workerRef.current) {
        workerRef.current.terminate()
      }
    }
  }, [clearWatchdog, spawnWorker])

  return {
    runCode,
    submitStdin,
    killWorker,
    isReady,
    isRunning,
    isAwaitingInput,
    stdinSupported,
  }
}
