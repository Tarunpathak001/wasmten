import { PGlite } from '@electric-sql/pglite'
import pgliteDataUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.data?url'
import pgliteWasmUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'
import initdbWasmUrl from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'

let activeDatabase = null
let activeDatabaseKey = null
let runtimeOptionsPromise = null

function postStatus(status) {
  self.postMessage({ type: 'status', status })
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
  }))

  return runtimeOptionsPromise
}

async function closeActiveDatabase() {
  if (!activeDatabase) {
    return
  }

  try {
    await activeDatabase.close()
  } catch {
    // Ignore cleanup failures while rotating databases.
  }

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
  await database.waitReady
  activeDatabase = database
  activeDatabaseKey = databaseKey
  return database
}

async function executeQuery({ id, sql, databaseKey, databaseLabel }) {
  try {
    const startedAt = performance.now()
    const database = await ensureDatabase(databaseKey, databaseLabel)
    const rawResults = await database.exec(sql, { rowMode: 'array' })
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
        resultSets,
      },
    })

    postStatus(`PostgreSQL ready - ${databaseLabel}`)
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error?.message || String(error),
    })

    postStatus('PostgreSQL error')
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
