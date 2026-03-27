import initSqlJs from 'sql.js/dist/sql-wasm.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

let sqlRuntimePromise = null
let activeDatabase = null
let activeDatabaseKey = null
let isExecuting = false

const DATABASE_STATE_PATTERNS = [
  /database disk image is malformed/i,
  /file is not a database/i,
  /malformed/i,
  /not a database/i,
  /unsupported file format/i,
]

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

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message || 'Unknown SQLite error',
      name: error.name || 'Error',
      stack: error.stack,
    }
  }

  return {
    message: typeof error === 'string' ? error : String(error),
    name: 'Error',
  }
}

function formatErrorMessage(errorInfo) {
  return errorInfo.message || 'Unknown SQLite error'
}

function isDatabaseStateError(errorInfo) {
  return DATABASE_STATE_PATTERNS.some((pattern) => pattern.test(errorInfo.message || ''))
}

function createSummaryStatementResultSet({ statementIndex, databaseLabel, rowsAffected = 0, statementSql = '' }) {
  return {
    id: `sqlite-summary-${statementIndex + 1}`,
    kind: 'summary',
    title: `Statement ${statementIndex + 1}`,
    columns: ['status', 'rows_affected', 'database', 'statement'],
    rows: [['ok', rowsAffected, databaseLabel, statementSql]],
    rowCount: 1,
    affectedRows: rowsAffected,
  }
}

function isMutatingStatement(statementSql) {
  return /^(insert|update|delete|replace)\b/i.test(statementSql.trim())
}

function executeStatements(database, sql, databaseLabel) {
  const resultSets = []
  let statementIndex = 0

  for (const statement of database.iterateStatements(sql)) {
    const statementSql = statement.getSQL()?.trim() || `Statement ${statementIndex + 1}`
    const columns = statement.getColumnNames()
    const rows = []

    while (statement.step()) {
      if (columns.length > 0) {
        rows.push(statement.get(null, { useBigInt: false }))
      }
    }

    const rowsAffected = database.getRowsModified()

    if (columns.length > 0) {
      resultSets.push({
        id: `sqlite-result-${statementIndex + 1}`,
        kind: 'table',
        title: `Statement ${statementIndex + 1}`,
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: isMutatingStatement(statementSql) ? rowsAffected : null,
      })
    } else {
      resultSets.push(
        createSummaryStatementResultSet({
          statementIndex,
          databaseLabel,
          rowsAffected,
          statementSql,
        }),
      )
    }

    statementIndex += 1
  }

  if (statementIndex === 0) {
    resultSets.push(
      createSummaryStatementResultSet({
        statementIndex: 0,
        databaseLabel,
        rowsAffected: 0,
        statementSql: '(no statements executed)',
      }),
    )
  }

  return resultSets
}

function postExecutionError({ id, errorInfo, phase, kind, databaseKey, databaseLabel }) {
  self.postMessage({
    type: 'error',
    id,
    error: formatErrorMessage(errorInfo),
    details: {
      engine: 'sqlite',
      kind,
      phase,
      databaseKey,
      databaseLabel,
    },
  })
}

async function executeQuery({ id, sql, databaseKey, databaseLabel, databaseBuffer }) {
  if (isExecuting) {
    self.postMessage({
      type: 'error',
      id,
      error: 'Another SQLite query is already running',
      details: {
        engine: 'sqlite',
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
    const SQL = await ensureRuntime()
    const startedAt = performance.now()
    const openedFromSnapshot = Boolean(databaseBuffer && databaseBuffer.byteLength > 0)

    if (activeDatabase && activeDatabaseKey !== databaseKey) {
      closeActiveDatabase()
    }

    if (!activeDatabase || activeDatabaseKey !== databaseKey) {
      postStatus(`Opening ${databaseLabel}...`)

      try {
        activeDatabase = databaseBuffer && databaseBuffer.byteLength > 0
          ? new SQL.Database(new Uint8Array(databaseBuffer))
          : new SQL.Database()
      } catch (error) {
        closeActiveDatabase()
        const errorInfo = serializeError(error)
        postExecutionError({
          id,
          errorInfo,
          phase: 'open',
          kind: openedFromSnapshot && isDatabaseStateError(errorInfo) ? 'database_state' : 'runtime',
          databaseKey,
          databaseLabel,
        })
        postStatus('SQLite error')
        return
      }

      activeDatabaseKey = databaseKey
    }

    let resultSets
    try {
      resultSets = executeStatements(activeDatabase, sql, databaseLabel)
    } catch (error) {
      const errorInfo = serializeError(error)
      closeActiveDatabase()
      postExecutionError({
        id,
        errorInfo,
        phase: 'query',
        kind: isDatabaseStateError(errorInfo) ? 'database_state' : 'query',
        databaseKey,
        databaseLabel,
      })
      postStatus('SQLite error')
      return
    }

    const exportedDatabase = activeDatabase.export()

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
    closeActiveDatabase()
    const errorInfo = serializeError(error)
    postExecutionError({
      id,
      errorInfo,
      phase: 'query',
      kind: 'runtime',
      databaseKey,
      databaseLabel,
    })
    postStatus('SQLite error')
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
