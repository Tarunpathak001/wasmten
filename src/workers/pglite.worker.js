import { PGlite } from '@electric-sql/pglite'
import pgliteDataUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.data?url'
import pgliteWasmUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'
import initdbWasmUrl from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'

let activeDatabase = null
let activeDatabaseKey = null
let runtimeOptionsPromise = null
let isExecuting = false
const STORAGE_ERROR_CODES = new Set(['XX000', 'XX001', 'XX002', '58P01', '58000', '58030', 'F0000'])
const STORAGE_ERROR_PATTERNS = [
  /bad file descriptor/i,
  /checksum(?: mismatch| failed| error| invalid)/i,
  /corrupt(?:ed)? (?:database|cluster|page|file|control file)/i,
  /(?:database|cluster|control file|checkpoint).*(?:corrupt|invalid)/i,
  /could not (open|read|write|fsync)/i,
  /file handle/i,
  /invalid checkpoint/i,
  /no such file or directory/i,
  /not a database cluster/i,
  /OPFS.*(?:file|handle|directory|storage|mount)/i,
  /(?:file|handle|directory|storage|mount).*OPFS/i,
  /control file/i,
  /checkpoint record/i,
  /pg_control/i,
  /pg_wal/i,
]

function postStatus(status) {
  self.postMessage({ type: 'status', status })
}

function splitDatabaseKey(databaseKey) {
  return databaseKey.split('/').filter(Boolean)
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message || 'Unknown PostgreSQL error',
      name: error.name || 'Error',
      code: error.code,
      severity: error.severity,
      detail: error.detail,
      hint: error.hint,
      where: error.where,
      position: error.position,
      internalPosition: error.internalPosition,
      internalQuery: error.internalQuery,
      schema: error.schema,
      table: error.table,
      column: error.column,
      constraint: error.constraint,
      file: error.file,
      line: error.line,
      routine: error.routine,
      stack: error.stack,
    }
  }

  if (typeof error === 'string') {
    return {
      message: error,
      name: 'Error',
    }
  }

  if (error && typeof error === 'object') {
    return {
      message: error.message || JSON.stringify(error),
      name: error.name || 'Error',
      code: error.code,
      severity: error.severity,
      detail: error.detail,
      hint: error.hint,
      where: error.where,
      position: error.position,
      internalPosition: error.internalPosition,
      internalQuery: error.internalQuery,
      schema: error.schema,
      table: error.table,
      column: error.column,
      constraint: error.constraint,
      file: error.file,
      line: error.line,
      routine: error.routine,
    }
  }

  return {
    message: 'Unknown PostgreSQL error',
    name: 'Error',
  }
}

function formatErrorMessage(errorInfo) {
  const lines = [errorInfo.message || 'Unknown PostgreSQL error']

  if (errorInfo.code) {
    lines.push(`SQLSTATE: ${errorInfo.code}`)
  }

  if (errorInfo.detail) {
    lines.push(`Detail: ${errorInfo.detail}`)
  }

  if (errorInfo.hint) {
    lines.push(`Hint: ${errorInfo.hint}`)
  }

  if (errorInfo.where) {
    lines.push(`Where: ${errorInfo.where}`)
  }

  const sourceBits = [errorInfo.file, errorInfo.line, errorInfo.routine].filter(Boolean)
  if (sourceBits.length > 0) {
    lines.push(`Source: ${sourceBits.join(':')}`)
  }

  return lines.join('\n')
}

function isRecoverablePersistedStateError(errorInfo, phase) {
  if (errorInfo.code && STORAGE_ERROR_CODES.has(errorInfo.code)) {
    return true
  }

  const searchableText = [
    errorInfo.message,
    errorInfo.detail,
    errorInfo.hint,
    errorInfo.where,
    errorInfo.file,
    errorInfo.routine,
  ]
    .filter(Boolean)
    .join('\n')

  return STORAGE_ERROR_PATTERNS.some((pattern) => pattern.test(searchableText))
}

async function getDatabaseParentDirectory(databaseKey) {
  const pathParts = splitDatabaseKey(databaseKey)
  if (pathParts.length === 0) {
    return { parentHandle: await navigator.storage.getDirectory(), entryName: '' }
  }

  const entryName = pathParts[pathParts.length - 1]
  let parentHandle = await navigator.storage.getDirectory()

  for (const segment of pathParts.slice(0, -1)) {
    parentHandle = await parentHandle.getDirectoryHandle(segment)
  }

  return { parentHandle, entryName }
}

async function databaseStorageExists(databaseKey) {
  try {
    const { parentHandle, entryName } = await getDatabaseParentDirectory(databaseKey)
    if (!entryName) {
      return false
    }

    await parentHandle.getDirectoryHandle(entryName)
    return true
  } catch {
    return false
  }
}

async function deleteDatabaseStorage(databaseKey) {
  const { parentHandle, entryName } = await getDatabaseParentDirectory(databaseKey)
  if (!entryName) {
    return false
  }

  try {
    await parentHandle.removeEntry(entryName, { recursive: true })
    return true
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return false
    }

    throw error
  }
}

async function compileWasmModule(url, label) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load ${label}: ${response.status}`)
  }

  try {
    return await WebAssembly.compileStreaming(Promise.resolve(response.clone()))
  } catch {
    return WebAssembly.compile(await response.arrayBuffer())
  }
}

async function loadRuntimeOptions() {
  if (runtimeOptionsPromise) {
    return runtimeOptionsPromise
  }

  runtimeOptionsPromise = Promise.all([
    fetch(pgliteDataUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load PGlite fs bundle: ${response.status}`)
      }
      return response.blob()
    }),
    compileWasmModule(pgliteWasmUrl, 'PGlite runtime wasm'),
    compileWasmModule(initdbWasmUrl, 'PGlite initdb wasm'),
  ]).then(([fsBundle, pgliteWasmModule, initdbWasmModule]) => ({
    fsBundle,
    pgliteWasmModule,
    initdbWasmModule,
  })).catch((error) => {
    runtimeOptionsPromise = null
    throw error
  })

  return runtimeOptionsPromise
}

async function closeDatabaseInstance(database) {
  if (!database) {
    return
  }

  try {
    await database.close()
  } catch {
    // Ignore cleanup failures while rotating databases.
  }
}

async function closeActiveDatabase() {
  if (!activeDatabase) {
    return
  }

  await closeDatabaseInstance(activeDatabase)
  activeDatabase = null
  activeDatabaseKey = null
}

function createSummaryResultSet({ statementIndex, databaseLabel, affectedRows = 0 }) {
  return {
    id: `pglite-summary-${statementIndex + 1}`,
    kind: 'summary',
    title: `Statement ${statementIndex + 1}`,
    columns: ['status', 'rows_affected', 'database'],
    rows: [['ok', affectedRows, databaseLabel]],
    rowCount: 1,
    affectedRows,
  }
}

function normalizeResultSet(result, index, databaseLabel) {
  const columns = result.fields?.map((field) => field.name) ?? []
  const rows = Array.isArray(result.rows) ? result.rows : []

  if (columns.length === 0) {
    return createSummaryResultSet({
      statementIndex: index,
      databaseLabel,
      affectedRows: result.affectedRows ?? 0,
    })
  }

  return {
    id: `pglite-result-${index + 1}`,
    kind: 'table',
    title: `Result ${index + 1}`,
    columns,
    rows,
    rowCount: rows.length,
    affectedRows: result.affectedRows ?? null,
  }
}

async function ensureDatabase(databaseKey, databaseLabel) {
  if (activeDatabase && activeDatabaseKey === databaseKey) {
    return activeDatabase
  }

  await closeActiveDatabase()
  postStatus(`Opening ${databaseLabel}...`)

  const runtimeOptions = await loadRuntimeOptions()
  const database = new PGlite(`opfs-ahp://${databaseKey}`, runtimeOptions)
  try {
    await database.waitReady
  } catch (error) {
    await closeDatabaseInstance(database)
    throw error
  }

  activeDatabase = database
  activeDatabaseKey = databaseKey
  return database
}

async function recoverDatabaseFromPersistedState({
  databaseKey,
  databaseLabel,
  errorInfo,
  phase,
}) {
  const hasPersistedState = await databaseStorageExists(databaseKey)
  if (!hasPersistedState || !isRecoverablePersistedStateError(errorInfo, phase)) {
    return null
  }

  postStatus(`Resetting ${databaseLabel} persisted state...`)
  await closeActiveDatabase()

  try {
    await deleteDatabaseStorage(databaseKey)
  } catch (error) {
    const recoveryError = new Error(
      `Persisted PostgreSQL storage for ${databaseLabel} requires a clean worker restart before it can be reset.`,
    )
    recoveryError.requiresWorkerReset = true
    recoveryError.detail = error?.message || String(error)
    throw recoveryError
  }

  return {
    recoveryMessage: `Recovered ${databaseLabel} by resetting incompatible persisted PostgreSQL state in OPFS and retrying the query. The old stored database contents could not be opened safely and were discarded.`,
  }
}

function createExecutionFailureMessage({ errorInfo, recoveryMessage, retryErrorInfo }) {
  const messageParts = [formatErrorMessage(errorInfo)]

  if (recoveryMessage) {
    messageParts.push(
      'Automatic recovery was attempted by clearing the persisted PostgreSQL store, but the retry still failed.',
    )
  }

  if (retryErrorInfo) {
    messageParts.push(`Retry failure:\n${formatErrorMessage(retryErrorInfo)}`)
  }

  return messageParts.join('\n\n')
}

function postExecutionError({
  id,
  errorInfo,
  phase,
  recoveryMessage = '',
  retryErrorInfo = null,
  kind = 'query',
  requiresWorkerReset = false,
  databaseKey = '',
  databaseLabel = '',
}) {
  self.postMessage({
    type: 'error',
    id,
    error: createExecutionFailureMessage({
      errorInfo,
      recoveryMessage,
      retryErrorInfo,
    }),
    details: {
      engine: 'pglite',
      kind,
      phase,
      recoveryAttempted: Boolean(recoveryMessage),
      recoveryMessage,
      requiresWorkerReset,
      databaseKey,
      databaseLabel,
      code: errorInfo.code,
      severity: errorInfo.severity,
    },
  })
}

function getFailureKind({ phase, errorInfo, hasPersistedState }) {
  if (hasPersistedState && isRecoverablePersistedStateError(errorInfo, phase)) {
    return 'database_state'
  }

  return phase === 'open' ? 'runtime' : 'query'
}

async function executeQuery({ id, sql, databaseKey, databaseLabel, resetDatabaseFirst = false }) {
  if (isExecuting) {
    self.postMessage({
      type: 'error',
      id,
      error: 'Another PostgreSQL query is already running',
      details: {
        engine: 'pglite',
        kind: 'busy',
        phase: 'query',
        databaseKey,
        databaseLabel,
      },
    })
    return
  }

  isExecuting = true
  try {
    const startedAt = performance.now()
    let hadPersistedState = await databaseStorageExists(databaseKey)
    let database = null
    let rawResults
    let recoveryDetails = null

    if (resetDatabaseFirst && hadPersistedState) {
      try {
        postStatus(`Resetting ${databaseLabel} persisted state...`)
        await closeActiveDatabase()
        await deleteDatabaseStorage(databaseKey)
        hadPersistedState = false
        recoveryDetails = {
          recoveryMessage: `Recovered ${databaseLabel} by resetting incompatible persisted PostgreSQL state in OPFS and retrying the query. The old stored database contents could not be opened safely and were discarded.`,
        }
      } catch (error) {
        const errorInfo = serializeError(error)
        postExecutionError({
          id,
          errorInfo,
          phase: 'open',
          kind: 'database_state',
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }
    }

    try {
      database = await ensureDatabase(databaseKey, databaseLabel)
    } catch (error) {
      const errorInfo = serializeError(error)

      try {
        recoveryDetails = await recoverDatabaseFromPersistedState({
          databaseKey,
          databaseLabel,
          errorInfo,
          phase: 'open',
        })
      } catch (recoveryError) {
        const retryErrorInfo = serializeError(recoveryError)
        postExecutionError({
          id,
          errorInfo,
          phase: 'open',
          retryErrorInfo,
          kind: 'database_state',
          requiresWorkerReset: Boolean(recoveryError?.requiresWorkerReset),
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }

      if (!recoveryDetails) {
        postExecutionError({
          id,
          errorInfo,
          phase: 'open',
          kind: getFailureKind({
            phase: 'open',
            errorInfo,
            hasPersistedState: hadPersistedState,
          }),
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }

      try {
        postStatus(`Rebuilding ${databaseLabel}...`)
        database = await ensureDatabase(databaseKey, databaseLabel)
      } catch (retryError) {
        const retryErrorInfo = serializeError(retryError)
        postExecutionError({
          id,
          errorInfo,
          phase: 'open',
          recoveryMessage: recoveryDetails.recoveryMessage,
          retryErrorInfo,
          kind: 'database_state',
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }
    }

    try {
      rawResults = await database.exec(sql, { rowMode: 'array' })
    } catch (error) {
      const errorInfo = serializeError(error)

      try {
        recoveryDetails = await recoverDatabaseFromPersistedState({
          databaseKey,
          databaseLabel,
          errorInfo,
          phase: 'query',
        })
      } catch (recoveryError) {
        const retryErrorInfo = serializeError(recoveryError)
        postExecutionError({
          id,
          errorInfo,
          phase: 'query',
          retryErrorInfo,
          kind: 'database_state',
          requiresWorkerReset: Boolean(recoveryError?.requiresWorkerReset),
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }

      if (!recoveryDetails) {
        postExecutionError({
          id,
          errorInfo,
          phase: 'query',
          kind: getFailureKind({
            phase: 'query',
            errorInfo,
            hasPersistedState: hadPersistedState,
          }),
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }

      try {
        postStatus(`Rebuilding ${databaseLabel}...`)
        database = await ensureDatabase(databaseKey, databaseLabel)
        rawResults = await database.exec(sql, { rowMode: 'array' })
      } catch (retryError) {
        const retryErrorInfo = serializeError(retryError)
        postExecutionError({
          id,
          errorInfo,
          phase: 'query',
          recoveryMessage: recoveryDetails.recoveryMessage,
          retryErrorInfo,
          kind: 'database_state',
          databaseKey,
          databaseLabel,
        })
        postStatus('PostgreSQL error')
        return
      }
    }

    try {
      const resultSets = rawResults.length > 0
        ? rawResults.map((result, index) => normalizeResultSet(result, index, databaseLabel))
        : [createSummaryResultSet({ statementIndex: 0, databaseLabel, affectedRows: 0 })]

      self.postMessage({
        type: 'result',
        id,
        payload: {
          engine: 'pglite',
          engineLabel: 'PostgreSQL (PGlite)',
          databaseLabel,
          durationMs: performance.now() - startedAt,
          recoveryMessage: recoveryDetails?.recoveryMessage || '',
          restoredFromOpfs: hadPersistedState && !recoveryDetails,
          storageRecovered: Boolean(recoveryDetails),
          resultSets,
        },
      })

      postStatus(
        recoveryDetails
          ? `PostgreSQL ready - ${databaseLabel} (storage recovered)`
          : `PostgreSQL ready - ${databaseLabel}`,
      )
    } catch (error) {
      const errorInfo = serializeError(error)
      postExecutionError({
        id,
        errorInfo,
        phase: 'query',
        kind: 'query',
        databaseKey,
        databaseLabel,
      })

      postStatus('PostgreSQL error')
    }
  } finally {
    isExecuting = false
  }
}

self.onmessage = async (event) => {
  const { type, id } = event.data

  switch (type) {
    case 'execute':
      await executeQuery(event.data)
      break

    case 'dispose':
      await closeActiveDatabase()
      break

    default:
      self.postMessage({
        type: 'error',
        id,
        error: `Unknown PGlite worker message type: ${type}`,
      })
  }
}

self.postMessage({ type: 'ready' })
postStatus('PostgreSQL worker ready')
