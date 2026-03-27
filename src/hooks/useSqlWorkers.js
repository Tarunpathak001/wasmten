import { useCallback, useEffect, useRef, useState } from 'react'

function createPendingMap() {
  return {
    sqlite: new Map(),
    pglite: new Map(),
  }
}

function createStatusState() {
  return {
    sqlite: 'Loading SQLite runtime...',
    pglite: 'Loading PostgreSQL runtime...',
  }
}

function createReadyState() {
  return {
    sqlite: false,
    pglite: false,
  }
}

export function useSqlWorkers({ onError } = {}) {
  const workerRefs = useRef({
    sqlite: null,
    pglite: null,
  })
  const pendingRequestsRef = useRef(createPendingMap())
  const nextRequestIdRef = useRef(0)
  const onErrorRef = useRef(onError)
  const [readyState, setReadyState] = useState(createReadyState)
  const [statusState, setStatusState] = useState(createStatusState)
  const [isRunning, setIsRunning] = useState(false)
  const [runningEngine, setRunningEngine] = useState(null)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const rejectPendingForEngine = useCallback((engine, error) => {
    const pendingForEngine = pendingRequestsRef.current[engine]
    for (const { reject } of pendingForEngine.values()) {
      reject(error)
    }
    pendingForEngine.clear()
  }, [])

  const updateStatus = useCallback((engine, nextStatus) => {
    setStatusState((prev) => ({
      ...prev,
      [engine]: nextStatus,
    }))
  }, [])

  const updateReady = useCallback((engine, nextReady) => {
    setReadyState((prev) => ({
      ...prev,
      [engine]: nextReady,
    }))
  }, [])

  useEffect(() => {
    function attachWorker(engine, worker) {
      worker.onmessage = (event) => {
        const { type, id, error, status, payload } = event.data

        switch (type) {
          case 'ready':
            updateReady(engine, true)
            return

          case 'status':
            updateStatus(engine, status)
            return

          case 'result': {
            const pending = pendingRequestsRef.current[engine].get(id)
            if (!pending) {
              return
            }

            pendingRequestsRef.current[engine].delete(id)
            pending.resolve(payload)
            return
          }

          case 'error': {
            const pending = pendingRequestsRef.current[engine].get(id)
            if (pending) {
              pendingRequestsRef.current[engine].delete(id)
              pending.reject(new Error(error || `${engine} query failed`))
              return
            }

            onErrorRef.current?.(new Error(error || `${engine} worker failed`), engine)
            return
          }

          default:
            return
        }
      }

      worker.onerror = (event) => {
        const error = new Error(event.message || `${engine} worker crashed`)
        updateReady(engine, false)
        updateStatus(engine, `${engine === 'sqlite' ? 'SQLite' : 'PostgreSQL'} worker crashed`)
        rejectPendingForEngine(engine, error)
        onErrorRef.current?.(error, engine)
      }
    }

    const sqliteWorker = new Worker(
      new URL('../workers/sqlite.worker.js', import.meta.url),
      { type: 'module' },
    )
    const pgliteWorker = new Worker(
      new URL('../workers/pglite.worker.js', import.meta.url),
      { type: 'module' },
    )

    workerRefs.current.sqlite = sqliteWorker
    workerRefs.current.pglite = pgliteWorker
    attachWorker('sqlite', sqliteWorker)
    attachWorker('pglite', pgliteWorker)

    return () => {
      Object.entries(workerRefs.current).forEach(([engine, worker]) => {
        if (!worker) {
          return
        }

        rejectPendingForEngine(engine, new Error(`${engine} worker stopped`))

        try {
          worker.postMessage({ type: 'dispose' })
        } catch {
          // Ignore shutdown races during unmount.
        }

        worker.terminate()
      })

      workerRefs.current = {
        sqlite: null,
        pglite: null,
      }
    }
  }, [rejectPendingForEngine, updateReady, updateStatus])

  const callWorker = useCallback((engine, payload, transfer = []) => {
    const worker = workerRefs.current[engine]
    if (!worker) {
      return Promise.reject(new Error(`${engine} worker is not ready`))
    }

    const id = nextRequestIdRef.current++

    return new Promise((resolve, reject) => {
      pendingRequestsRef.current[engine].set(id, { resolve, reject })
      worker.postMessage({ id, ...payload }, transfer)
    })
  }, [])

  const runEngineQuery = useCallback(async (engine, payload, transfer = []) => {
    if (isRunning) {
      throw new Error('Another SQL query is already running')
    }

    setIsRunning(true)
    setRunningEngine(engine)

    try {
      return await callWorker(engine, { type: 'execute', ...payload }, transfer)
    } finally {
      setIsRunning(false)
      setRunningEngine(null)
    }
  }, [callWorker, isRunning])

  const runSqliteQuery = useCallback((payload) => {
    const transfer = payload.databaseBuffer ? [payload.databaseBuffer] : []
    return runEngineQuery('sqlite', payload, transfer)
  }, [runEngineQuery])

  const runPgliteQuery = useCallback((payload) => {
    return runEngineQuery('pglite', payload)
  }, [runEngineQuery])

  return {
    sqliteReady: readyState.sqlite,
    pgliteReady: readyState.pglite,
    sqliteStatus: statusState.sqlite,
    pgliteStatus: statusState.pglite,
    isRunning,
    runningEngine,
    runSqliteQuery,
    runPgliteQuery,
  }
}
