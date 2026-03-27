import initSqlJs from 'sql.js/dist/sql-wasm.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

let sqlRuntimePromise = null
let activeDatabase = null
let activeDatabaseKey = null

function postStatus(status) {
  self.postMessage({ type: 'status', status })
}

function closeActiveDatabase() {
  try {
    activeDatabase?.close()
  } catch {
    // Ignore cleanup failures while rotating databases.
  }

  activeDatabase = null
  activeDatabaseKey = null
}

async function ensureRuntime() {
  if (sqlRuntimePromise) {
    return sqlRuntimePromise
  }

  postStatus('Loading SQLite runtime...')

  sqlRuntimePromise = initSqlJs({
    locateFile: () => sqlWasmUrl,
  })
    .then((runtime) => {
      self.postMessage({ type: 'ready' })
      postStatus('SQLite ready')
      return runtime
    })
    .catch((error) => {
      sqlRuntimePromise = null
      throw error
    })

  return sqlRuntimePromise
}

function createSummaryResultSet({ databaseLabel, rowsAffected = 0 }) {
  return {
    id: 'sqlite-summary',
    kind: 'summary',
    title: 'Execution summary',
    columns: ['status', 'rows_affected', 'database'],
    rows: [['ok', rowsAffected, databaseLabel]],
    rowCount: 1,
    affectedRows: rowsAffected,
  }
}

function normalizeResultSet(result, index) {
  return {
    id: `sqlite-result-${index + 1}`,
    kind: 'table',
    title: `Result ${index + 1}`,
    columns: result.columns ?? [],
    rows: result.values ?? [],
    rowCount: result.values?.length ?? 0,
    affectedRows: null,
  }
}

async function executeQuery({ id, sql, databaseKey, databaseLabel, databaseBuffer }) {
  try {
    const SQL = await ensureRuntime()
    const startedAt = performance.now()

    if (activeDatabase && activeDatabaseKey !== databaseKey) {
      closeActiveDatabase()
    }

    if (!activeDatabase || activeDatabaseKey !== databaseKey) {
      postStatus(`Opening ${databaseLabel}...`)

      activeDatabase = databaseBuffer && databaseBuffer.byteLength > 0
        ? new SQL.Database(new Uint8Array(databaseBuffer))
        : new SQL.Database()
      activeDatabaseKey = databaseKey
    }

    const rawResults = activeDatabase.exec(sql)
    const rowsAffected = activeDatabase.getRowsModified()
    const exportedDatabase = activeDatabase.export()
    const resultSets = rawResults.length > 0
      ? rawResults.map(normalizeResultSet)
      : [createSummaryResultSet({ databaseLabel, rowsAffected })]

    self.postMessage(
      {
        type: 'result',
        id,
        payload: {
          engine: 'sqlite',
          engineLabel: 'SQLite',
          databaseLabel,
          durationMs: performance.now() - startedAt,
          resultSets,
          databaseBuffer: exportedDatabase.buffer,
        },
      },
      [exportedDatabase.buffer],
    )

    postStatus(`SQLite ready - ${databaseLabel}`)
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error?.message || String(error),
    })

    postStatus('SQLite error')
  }
}

self.onmessage = async (event) => {
  const { type, id } = event.data

  switch (type) {
    case 'execute':
      await executeQuery(event.data)
      break

    case 'dispose':
      closeActiveDatabase()
      break

    default:
      self.postMessage({
        type: 'error',
        id,
        error: `Unknown SQLite worker message type: ${type}`,
      })
  }
}

void ensureRuntime()
