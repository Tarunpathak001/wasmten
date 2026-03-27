import { useEffect, useState } from 'react'
import { getSqlEngineLabel } from '../utils/sqlRuntime.js'

function formatCellValue(value) {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  return String(value)
}

function compareValues(left, right) {
  if (left === right) {
    return 0
  }

  if (left === null || left === undefined) {
    return 1
  }

  if (right === null || right === undefined) {
    return -1
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }

  return formatCellValue(left).localeCompare(formatCellValue(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function sortRows(rows, sortConfig) {
  if (!sortConfig) {
    return rows
  }

  const { columnIndex, direction } = sortConfig
  const directionMultiplier = direction === 'desc' ? -1 : 1

  return [...rows].sort((left, right) => {
    const result = compareValues(left[columnIndex], right[columnIndex])
    return result * directionMultiplier
  })
}

function ResultTable({ resultSet, sortConfig, onSort }) {
  const sortedRows = sortRows(resultSet.rows, sortConfig)

  return (
    <div
      style={{
        border: '1px solid #30363d',
        borderRadius: '12px',
        overflow: 'hidden',
        background: '#0d1117',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '12px 14px',
          borderBottom: '1px solid #21262d',
          background: 'linear-gradient(180deg, #161b22 0%, #11161d 100%)',
        }}
      >
        <div>
          <div style={{ color: '#f0f6fc', fontWeight: 700, fontSize: '13px' }}>
            {resultSet.title}
          </div>
          <div style={{ color: '#8b949e', fontSize: '12px', marginTop: '2px' }}>
            {resultSet.rowCount} row{resultSet.rowCount === 1 ? '' : 's'}
            {typeof resultSet.affectedRows === 'number'
              ? ` • ${resultSet.affectedRows} affected`
              : ''}
          </div>
        </div>
        <span
          style={{
            color: resultSet.kind === 'summary' ? '#d29922' : '#58a6ff',
            background: resultSet.kind === 'summary' ? '#362708' : '#0d2538',
            border: `1px solid ${resultSet.kind === 'summary' ? '#6b4f18' : '#1f6feb'}`,
            borderRadius: '999px',
            padding: '3px 8px',
            fontSize: '11px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {resultSet.kind}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '12px',
            color: '#c9d1d9',
          }}
        >
          <thead>
            <tr>
              {resultSet.columns.map((column, columnIndex) => {
                const isActive = sortConfig?.columnIndex === columnIndex
                const direction = isActive ? (sortConfig.direction === 'asc' ? '↑' : '↓') : '↕'

                return (
                  <th
                    key={`${resultSet.id}-${columnIndex}`}
                    onClick={() => onSort(resultSet.id, columnIndex)}
                    style={{
                      position: 'sticky',
                      top: 0,
                      background: '#0f1722',
                      color: isActive ? '#f0f6fc' : '#8b949e',
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderBottom: '1px solid #21262d',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      fontWeight: 700,
                    }}
                  >
                    <span>{column}</span>
                    <span style={{ marginLeft: '8px', color: isActive ? '#58a6ff' : '#6e7681' }}>
                      {direction}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {sortedRows.map((row, rowIndex) => (
              <tr
                key={`${resultSet.id}-row-${rowIndex}`}
                style={{
                  background: rowIndex % 2 === 0 ? '#0d1117' : '#11161d',
                }}
              >
                {resultSet.columns.map((_, columnIndex) => (
                  <td
                    key={`${resultSet.id}-${rowIndex}-${columnIndex}`}
                    style={{
                      padding: '10px 12px',
                      borderBottom: '1px solid #161b22',
                      verticalAlign: 'top',
                      fontFamily:
                        '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
                      color: '#c9d1d9',
                      minWidth: '120px',
                    }}
                  >
                    {formatCellValue(row[columnIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SqlResultsPanel({
  activeFile,
  engine,
  result,
  isReady,
  isRunning,
  status,
}) {
  const [sortState, setSortState] = useState({})
  const engineLabel = result?.engineLabel || getSqlEngineLabel(engine)

  useEffect(() => {
    setSortState({})
  }, [result?.executedAt, result?.filename])

  const handleSort = (resultId, columnIndex) => {
    setSortState((prev) => {
      const current = prev[resultId]
      const nextDirection =
        current?.columnIndex === columnIndex && current.direction === 'asc'
          ? 'desc'
          : 'asc'

      return {
        ...prev,
        [resultId]: {
          columnIndex,
          direction: nextDirection,
        },
      }
    })
  }

  const placeholderMessage = engine === 'sqlite'
    ? `Run ${activeFile || 'a .sql file'} to execute it against SQLite. The database snapshot persists to OPFS as a hidden .sqlite file.`
    : `Run ${activeFile || 'a .pg file'} to execute it against PostgreSQL (PGlite). The database persists natively in OPFS.`

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background:
          'radial-gradient(circle at top left, rgba(31, 111, 235, 0.18), transparent 28%), #0d1117',
        padding: '18px',
        color: '#c9d1d9',
      }}
    >
      <div
        style={{
          border: '1px solid #30363d',
          borderRadius: '16px',
          padding: '16px',
          background: 'linear-gradient(180deg, rgba(22, 27, 34, 0.98), rgba(13, 17, 23, 0.98))',
          boxShadow: '0 18px 48px rgba(1, 4, 9, 0.35)',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ color: '#f0f6fc', fontSize: '16px', fontWeight: 800 }}>
              SQL Worker Results
            </div>
            <div style={{ color: '#8b949e', fontSize: '12px', marginTop: '4px' }}>
              {status}
            </div>
          </div>

          <span
            style={{
              color: engine === 'sqlite' ? '#58a6ff' : '#56d364',
              background: engine === 'sqlite' ? '#0d2538' : '#0f2e1f',
              border: `1px solid ${engine === 'sqlite' ? '#1f6feb' : '#238636'}`,
              borderRadius: '999px',
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 800,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {engineLabel}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '10px',
            marginTop: '16px',
          }}
        >
          <InfoTile label="Engine" value={engineLabel} tone={engine === 'sqlite' ? '#58a6ff' : '#56d364'} />
          <InfoTile label="File" value={activeFile || 'No SQL file selected'} tone="#d29922" />
          <InfoTile
            label="Persistence"
            value={engine === 'sqlite' ? 'OPFS via I/O Worker' : 'OPFS native via PGlite'}
            tone="#f0883e"
          />
          <InfoTile
            label="Database"
            value={result?.databaseLabel || 'Ready to create on first run'}
            tone="#bc8cff"
          />
        </div>
      </div>

      {!isReady ? (
        <StateCard title="Loading runtime" body={status} tone="#58a6ff" />
      ) : null}

      {isRunning ? (
        <StateCard title="Executing query" body={`${engineLabel} is running your SQL in a dedicated worker...`} tone="#f0883e" />
      ) : null}

      {result?.error ? (
        <StateCard title="Query failed" body={result.error} tone="#ff7b72" />
      ) : null}

      {!result && !isRunning ? (
        <StateCard title="No results yet" body={placeholderMessage} tone="#8b949e" />
      ) : null}

      {result?.durationMs ? (
        <div style={{ color: '#8b949e', fontSize: '12px', marginBottom: '12px' }}>
          Last run finished in {result.durationMs.toFixed(1)}ms.
        </div>
      ) : null}

      {result && engine === 'sqlite' ? (
        <div style={{ color: '#8b949e', fontSize: '12px', marginBottom: '12px' }}>
          {result.restoredFromOpfs
            ? `Restored ${result.databaseLabel} from OPFS before executing this query.`
            : `Created or updated ${result.databaseLabel} and persisted it back to OPFS after execution.`}
        </div>
      ) : null}

      {result && engine === 'pglite' ? (
        <div style={{ color: '#8b949e', fontSize: '12px', marginBottom: '12px' }}>
          {result.databaseLabel} is running on PostgreSQL (PGlite) with native OPFS-backed storage.
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: '14px' }}>
        {result?.resultSets?.map((resultSet) => (
          <ResultTable
            key={resultSet.id}
            resultSet={resultSet}
            sortConfig={sortState[resultSet.id]}
            onSort={handleSort}
          />
        ))}
      </div>
    </div>
  )
}

function InfoTile({ label, value, tone }) {
  return (
    <div
      style={{
        border: '1px solid #21262d',
        borderRadius: '12px',
        padding: '12px',
        background: '#11161d',
      }}
    >
      <div
        style={{
          color: tone,
          fontSize: '11px',
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: '6px',
        }}
      >
        {label}
      </div>
      <div style={{ color: '#f0f6fc', fontSize: '13px', fontWeight: 600 }}>
        {value}
      </div>
    </div>
  )
}

function StateCard({ title, body, tone }) {
  return (
    <div
      style={{
        border: `1px solid ${tone}44`,
        borderLeft: `4px solid ${tone}`,
        borderRadius: '12px',
        padding: '14px 16px',
        background: '#11161d',
        marginBottom: '14px',
      }}
    >
      <div style={{ color: '#f0f6fc', fontSize: '13px', fontWeight: 700 }}>
        {title}
      </div>
      <div style={{ color: '#8b949e', fontSize: '12px', marginTop: '5px', lineHeight: 1.5 }}>
        {body}
      </div>
    </div>
  )
}
