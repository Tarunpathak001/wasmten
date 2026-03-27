import { useCallback, useEffect, useRef, useState } from 'react'

export function useIOWorker({ onError, onWriteFlushed } = {}) {
  const workerRef = useRef(null)
  const nextRequestIdRef = useRef(0)
  const pendingRequestsRef = useRef(new Map())
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

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/io.worker.js', import.meta.url),
      { type: 'classic' }
    )

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
    }

    workerRef.current = worker
    setIsReady(true)

    return () => {
      setIsReady(false)
      rejectAllPending(new Error('Workspace I/O worker stopped'))
      worker.terminate()
      workerRef.current = null
    }
  }, [rejectAllPending])

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
      onErrorRef.current?.(new Error('Workspace I/O worker is not ready'))
      return
    }

    workerRef.current.postMessage({ type: 'schedule_write', filename, content })
  }, [])

  const listFiles = useCallback(() => callWorker({ type: 'list' }), [callWorker])
  const readFile = useCallback((filename) => callWorker({ type: 'read', filename }), [callWorker])
  const writeFile = useCallback((filename, content) => callWorker({ type: 'write', filename, content }), [callWorker])
  const flushWrite = useCallback((filename) => callWorker({ type: 'flush', filename }), [callWorker])
  const flushAllWrites = useCallback(() => callWorker({ type: 'flush_all' }), [callWorker])

  return {
    isReady,
    listFiles,
    readFile,
    writeFile,
    scheduleWrite,
    flushWrite,
    flushAllWrites,
  }
}
