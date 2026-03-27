function FileTree({ files, activeFile, onFileSelect, onNewFile, disabled = false }) {
  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: '#161b22',
      borderRight: '1px solid #30363d',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid #30363d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: '11px',
          fontWeight: 700,
          color: '#8b949e',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>
          Explorer
        </span>
        <button
          onClick={disabled ? undefined : onNewFile}
          title={disabled ? 'Finish or kill the active terminal run before creating files' : 'New File'}
          disabled={disabled}
          style={{
            background: 'none',
            border: 'none',
            color: disabled ? '#484f58' : '#8b949e',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: '16px',
            padding: '2px 4px',
            lineHeight: 1,
            borderRadius: '4px',
            opacity: disabled ? 0.7 : 1,
          }}
          onMouseEnter={(event) => {
            if (!disabled) {
              event.target.style.color = '#c9d1d9'
            }
          }}
          onMouseLeave={(event) => {
            event.target.style.color = disabled ? '#484f58' : '#8b949e'
          }}
        >
          +
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {files.length === 0 ? (
          <div style={{
            padding: '16px 12px',
            color: '#484f58',
            fontSize: '12px',
            textAlign: 'center',
          }}>
            No files yet.<br />Click + to create one.
          </div>
        ) : (
          files.map((file) => (
            <FileItem
              key={file.name}
              file={file}
              isActive={file.name === activeFile}
              disabled={disabled}
              onClick={() => onFileSelect(file.name)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function FileItem({ file, isActive, onClick, disabled = false }) {
  const badge = getFileBadge(file.name)

  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        padding: '4px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '13px',
        color: disabled ? '#6e7681' : isActive ? '#c9d1d9' : '#8b949e',
        background: isActive ? '#1f2937' : 'transparent',
        borderLeft: isActive ? '2px solid #58a6ff' : '2px solid transparent',
        transition: 'background 0.1s',
        opacity: disabled ? 0.75 : 1,
      }}
      onMouseEnter={(event) => {
        if (!isActive && !disabled) {
          event.currentTarget.style.background = '#1c2128'
        }
      }}
      onMouseLeave={(event) => {
        if (!isActive) {
          event.currentTarget.style.background = 'transparent'
        }
      }}
    >
      <span
        style={{
          minWidth: '30px',
          fontSize: '10px',
          fontWeight: 700,
          color: disabled ? '#6e7681' : '#58a6ff',
          background: '#0f1722',
          border: '1px solid #30363d',
          borderRadius: '999px',
          padding: '2px 6px',
          textAlign: 'center',
        }}
      >
        {badge}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.name}
      </span>
    </div>
  )
}

function getFileBadge(filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'py':
      return 'PY'
    case 'js':
      return 'JS'
    case 'ts':
      return 'TS'
    case 'sql':
      return 'SQL'
    case 'pg':
      return 'PG'
    case 'json':
      return 'JSON'
    case 'md':
      return 'MD'
    default:
      return 'FILE'
  }
}

export default FileTree
