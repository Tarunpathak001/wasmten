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

function createWorkerError(message, details = null) {
  const error = new Error(message)
  if (details) {
    error.details = details
  }
  return error
}

export function useSqlWorkers({ onError } = {}) {
  const workerRefs = useRef({
    sqlite: null,
    pglite: null,
  })
  const pendingRequestsRef = useRef(createPendingMap())
  const nextRequestIdRef = useRef(0)
  const activeExecutionEngineRef = useRef(null)
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

  const attachWorker = useCallback((engine, worker) => {
    worker.onmessage = (event) => {
      const { type, id, error, status, payload, details } = event.data

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
          const workerError = new Error(error || `${engine} query failed`)
          if (details) {
            workerError.details = details
          }

          const pending = pendingRequestsRef.current[engine].get(id)
          if (pending) {
            pendingRequestsRef.current[engine].delete(id)
            pending.reject(workerError)
            return
          }

          onErrorRef.current?.(workerError, engine)
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
  }, [rejectPendingForEngine, updateReady, updateStatus])

  const createWorker = useCallback((engine) => {
    const worker = engine === 'sqlite'
      ? new Worker(new URL('../workers/sqlite.worker.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('../workers/pglite.worker.js', import.meta.url), { type: 'module' })

    workerRefs.current[engine] = worker
    attachWorker(engine, worker)
    return worker
  }, [attachWorker])

  const restartWorker = useCallback((engine, options = {}) => {
    const worker = workerRefs.current[engine]
    const {
      rejectionError = createWorkerError(`${engine} worker restarted`),
      nextStatus = engine === 'sqlite'
        ? 'Loading SQLite runtime...'
        : 'Loading PostgreSQL runtime...',
    } = options

    if (worker) {
      rejectPendingForEngine(engine, rejectionError)

      try {
        worker.postMessage({ type: 'dispose' })
      } catch {
        // Ignore shutdown races during restart.
      }

      worker.terminate()
    }

    updateReady(engine, false)
    updateStatus(engine, nextStatus)
    return createWorker(engine)
  }, [createWorker, rejectPendingForEngine, updateReady, updateStatus])

  useEffect(() => {
    createWorker('sqlite')
    createWorker('pglite')

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
  }, [createWorker, rejectPendingForEngine])

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
    if (activeExecutionEngineRef.current) {
      throw new Error('Another SQL query is already running')
    }

    activeExecutionEngineRef.current = engine
    setIsRunning(true)
    setRunningEngine(engine)

    try {
      return await callWorker(engine, { type: 'execute', ...payload }, transfer)
    } finally {
      if (activeExecutionEngineRef.current === engine) {
        activeExecutionEngineRef.current = null
      }
      setIsRunning(false)
      setRunningEngine(null)
    }
  }, [callWorker])

  const runSqliteQuery = useCallback((payload) => {
    const transfer = payload.databaseBuffer ? [payload.databaseBuffer] : []
    return runEngineQuery('sqlite', payload, transfer)
  }, [runEngineQuery])

  const runPgliteQuery = useCallback((payload) => {
    return runEngineQuery('pglite', payload).catch(async (error) => {
      if (!error.details?.requiresWorkerReset || payload.resetDatabaseFirst) {
        throw error
      }

      restartWorker('pglite', {
        rejectionError: createWorkerError('PostgreSQL worker restarted for storage recovery', {
          kind: 'worker_restart',
        }),
      })
      return runEngineQuery('pglite', {
        ...payload,
        resetDatabaseFirst: true,
      })
    })
  }, [restartWorker, runEngineQuery])

  const killSqlWorker = useCallback((engine) => {
    restartWorker(engine, {
      rejectionError: createWorkerError('Killed by user', { kind: 'killed' }),
      nextStatus: engine === 'sqlite'
        ? 'SQLite runtime reset'
        : 'PostgreSQL runtime reset',
    })
  }, [restartWorker])

  return {
    sqliteReady: readyState.sqlite,
    pgliteReady: readyState.pglite,
    sqliteStatus: statusState.sqlite,
    pgliteStatus: statusState.pglite,
    isRunning,
    runningEngine,
    runSqliteQuery,
    runPgliteQuery,
    killSqlWorker,
  }
}
