function FileTree({ files, activeFile, onFileSelect, onNewFile }) {
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
          onClick={onNewFile}
          title="New File"
          style={{
            background: 'none',
            border: 'none',
            color: '#8b949e',
            cursor: 'pointer',
            fontSize: '16px',
            padding: '2px 4px',
            lineHeight: 1,
            borderRadius: '4px',
          }}
          onMouseEnter={e => e.target.style.color = '#c9d1d9'}
          onMouseLeave={e => e.target.style.color = '#8b949e'}
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
              onClick={() => onFileSelect(file.name)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function FileItem({ file, isActive, onClick }) {
  const icon = getFileIcon(file.name)

  return (
    <div
      onClick={onClick}
      style={{
        padding: '4px 12px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '13px',
        color: isActive ? '#c9d1d9' : '#8b949e',
        background: isActive ? '#1f2937' : 'transparent',
        borderLeft: isActive ? '2px solid #58a6ff' : '2px solid transparent',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => {
        if (!isActive) e.currentTarget.style.background = '#1c2128'
      }}
      onMouseLeave={e => {
        if (!isActive) e.currentTarget.style.background = 'transparent'
      }}
    >
      <span style={{ fontSize: '14px' }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.name}
      </span>
    </div>
  )
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'py':   return '🐍'
    case 'js':   return '📜'
    case 'ts':   return '📘'
    case 'sql':  return '🗃️'
    case 'pg':   return '🐘'
    case 'json': return '📋'
    case 'md':   return '📝'
    default:     return '📄'
  }
}

export default FileTree
