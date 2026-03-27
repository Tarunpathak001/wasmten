import '../monacoSetup.js'
import { useCallback, useEffect, useRef } from 'react'
import MonacoEditor from '@monaco-editor/react'
import { DEFAULT_PYTHON } from '../constants/defaultPython.js'

const RECOVERY_STORAGE_KEY = 'wasmforge:pending-workspace-writes'

function persistDraft(filename, content) {
  if (typeof window === 'undefined' || !filename) {
    return
  }

  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY)
    const drafts = raw ? JSON.parse(raw) : {}
    const nextDrafts = drafts && typeof drafts === 'object' && !Array.isArray(drafts)
      ? drafts
      : {}

    nextDrafts[filename] = content
    window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(nextDrafts))
  } catch {
    // Recovery storage is best-effort only.
  }
}

function Editor({ code, filename, onChange, onMount, language = 'python' }) {
  const editorRef = useRef(null)
  const modelChangeDisposableRef = useRef(null)
  const filenameRef = useRef(filename)

  useEffect(() => {
    filenameRef.current = filename
  }, [filename])

  useEffect(() => {
    return () => {
      modelChangeDisposableRef.current?.dispose()
      modelChangeDisposableRef.current = null
    }
  }, [])

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    modelChangeDisposableRef.current?.dispose()
    modelChangeDisposableRef.current = editor.onDidChangeModelContent(() => {
      persistDraft(filenameRef.current, editor.getValue())
    })

    onMount?.(editor, monaco)
  }, [onMount])

  return (
    <MonacoEditor
      height="100%"
      language={language}
      path={filename}
      value={code}
      onChange={(val) => {
        const nextValue = val ?? ''
        persistDraft(filenameRef.current, nextValue)
        onChange?.(nextValue)
      }}
      onMount={handleMount}
      theme="vs-dark"
      options={{
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
        fontLigatures: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        renderLineHighlight: 'all',
        cursorBlinking: 'smooth',
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        automaticLayout: true,
        tabSize: 4,
        insertSpaces: true,
        wordWrap: 'on',
        suggest: { showKeywords: true },
        quickSuggestions: true,
      }}
    />
  )
}

export { DEFAULT_PYTHON }
export default Editor
