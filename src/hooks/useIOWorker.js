import { useCallback, useEffect, useRef, useState } from 'react'

export function useIOWorker({ onError, onWriteFlushed } = {}) {
  const workerRef = useRef(null)
  const nextRequestIdRef = useRef(0)
  const pendingRequestsRef = useRef(new Map())
  const scheduledWritesRef = useRef([])
  const createWorkerRef = useRef(null)
  const onErrorRef = useRef(onError)
  const onWriteFlushedRef = useRef(onWriteFlushed)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    onWriteFlushedRef.current = onWriteFlushed
  }, [onWriteFlushed])

  const rejectAllPending = useCallback((error) => {
    for (const { reject } of pendingRequestsRef.current.values()) {
      reject(error)
    }
    pendingRequestsRef.current.clear()
  }, [])

  const flushScheduledWrites = useCallback(() => {
    if (!workerRef.current || scheduledWritesRef.current.length === 0) {
      return
    }

    const queuedWrites = scheduledWritesRef.current.splice(0)
    for (const payload of queuedWrites) {
      workerRef.current.postMessage(payload)
    }
  }, [])

  const attachWorker = useCallback((worker) => {
    worker.onmessage = (event) => {
      const { id, result, error, type, filename } = event.data

      if (type === 'write_error') {
        const writeError = new Error(
          filename
            ? `Failed to save ${filename}: ${error}`
            : (error || 'Workspace write failed')
        )
        onErrorRef.current?.(writeError)
        return
      }

      if (type === 'write_flushed') {
        onWriteFlushedRef.current?.(filename)
        return
      }

      const pending = pendingRequestsRef.current.get(id)
      if (!pending) {
        return
      }

      pendingRequestsRef.current.delete(id)

      if (error) {
        pending.reject(new Error(error))
        return
      }

      pending.resolve(result)
    }

    worker.onerror = (event) => {
      const error = new Error(event.message || 'Workspace I/O worker crashed')
      setIsReady(false)
      rejectAllPending(error)
      onErrorRef.current?.(error)
      workerRef.current = null
      createWorkerRef.current?.()
    }
  }, [rejectAllPending])

  const createWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }

    const worker = new Worker(
      new URL('../workers/io.worker.js', import.meta.url),
      { type: 'classic' }
    )

    attachWorker(worker)
    workerRef.current = worker
    setIsReady(true)
    flushScheduledWrites()
  }, [attachWorker, flushScheduledWrites])

  createWorkerRef.current = createWorker

  useEffect(() => {
    createWorker()

    return () => {
      setIsReady(false)
      rejectAllPending(new Error('Workspace I/O worker stopped'))
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [createWorker, rejectAllPending])

  const callWorker = useCallback((payload) => {
    if (!workerRef.current) {
      return Promise.reject(new Error('Workspace I/O worker is not ready'))
    }

    const id = nextRequestIdRef.current++
    return new Promise((resolve, reject) => {
      pendingRequestsRef.current.set(id, { resolve, reject })
      workerRef.current.postMessage({ ...payload, id })
    })
  }, [])

  const scheduleWrite = useCallback((filename, content) => {
    if (!workerRef.current) {
      scheduledWritesRef.current.push({
        type: 'schedule_write',
        filename,
        content,
      })
      createWorkerRef.current?.()
      return
    }

    workerRef.current.postMessage({ type: 'schedule_write', filename, content })
  }, [])

  const listFiles = useCallback(() => callWorker({ type: 'list' }), [callWorker])
  const readFile = useCallback((filename) => callWorker({ type: 'read', filename }), [callWorker])
  const writeFile = useCallback((filename, content) => callWorker({ type: 'write', filename, content }), [callWorker])
  const fileExists = useCallback(
    (filename, scope = 'workspace') => callWorker({ type: 'exists', filename, scope }),
    [callWorker],
  )
  const readBinaryFile = useCallback(
    (filename, scope = 'sqlite') => callWorker({ type: 'read_binary', filename, scope }),
    [callWorker],
  )
  const writeBinaryFile = useCallback(
    (filename, content, scope = 'sqlite') =>
      callWorker({ type: 'write_binary', filename, content, scope }),
    [callWorker],
  )
  const flushWrite = useCallback((filename) => callWorker({ type: 'flush', filename }), [callWorker])
  const flushAllWrites = useCallback(() => callWorker({ type: 'flush_all' }), [callWorker])

  return {
    isReady,
    listFiles,
    readFile,
    writeFile,
    fileExists,
    readBinaryFile,
    writeBinaryFile,
    scheduleWrite,
    flushWrite,
    flushAllWrites,
  }
}
