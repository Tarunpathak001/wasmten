import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

function isPrintableCharacter(char) {
  const code = char.codePointAt(0)
  return typeof code === 'number' && code >= 32 && code !== 127
}

function sanitizeInputChunk(chunk) {
  return Array.from(chunk ?? '')
    .filter((char) => isPrintableCharacter(char))
    .join('')
}

function createEmptyInputState() {
  return {
    active: false,
    prompt: '',
    buffer: '',
    onSubmit: null,
  }
}

const Terminal = forwardRef(function Terminal({ onResize }, ref) {
  const containerRef = useRef(null)
  const xtermRef = useRef(null)
  const fitAddonRef = useRef(null)
  const inputStateRef = useRef(createEmptyInputState())

  useImperativeHandle(ref, () => ({
    write: (data) => {
      xtermRef.current?.write(data)
    },
    writeln: (data) => {
      xtermRef.current?.writeln(data)
    },
    clear: () => {
      const xterm = xtermRef.current
      if (!xterm) {
        return
      }

      xterm.clear()

      const state = inputStateRef.current
      if (state.active) {
        xterm.write(`${state.prompt}${state.buffer}`)
      }
    },
    focus: () => {
      xtermRef.current?.focus()
    },
    requestInput: ({ prompt = '', onSubmit } = {}) => {
      const xterm = xtermRef.current
      if (!xterm) {
        return false
      }

      const state = inputStateRef.current
      if (state.active) {
        xterm.write('\r\n')
      }

      inputStateRef.current = {
        active: true,
        prompt: String(prompt ?? ''),
        buffer: '',
        onSubmit: typeof onSubmit === 'function' ? onSubmit : null,
      }

      xterm.write(inputStateRef.current.prompt)
      xterm.focus()
      return true
    },
    cancelInput: ({ reason = '', newline = true } = {}) => {
      const xterm = xtermRef.current
      const state = inputStateRef.current
      if (!xterm || !state.active) {
        return false
      }

      if (reason) {
        xterm.write(reason)
      }
      if (newline) {
        xterm.write('\r\n')
      }

      inputStateRef.current = createEmptyInputState()
      return true
    },
  }))

  useEffect(() => {
    if (!containerRef.current) {
      return undefined
    }

    const xterm = new XTerm({
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      allowTransparency: false,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(containerRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    xterm.writeln('\x1b[1;34m========================================\x1b[0m')
    xterm.writeln('\x1b[1;34m|  \x1b[1;37mWasmForge\x1b[0m\x1b[1;34m - Zero Backend IDE      |\x1b[0m')
    xterm.writeln('\x1b[1;34m========================================\x1b[0m')
    xterm.writeln('\x1b[90mInitializing browser runtimes (Pyodide + JS/TS worker)...\x1b[0m')
    xterm.writeln('')

    const dataListener = xterm.onData((data) => {
      const state = inputStateRef.current
      if (!state.active) {
        return
      }

      if (data === '\r') {
        const submittedValue = state.buffer
        const submit = state.onSubmit
        xterm.write('\r\n')
        let accepted = true

        try {
          accepted = submit ? submit(submittedValue) !== false : true
        } catch (error) {
          accepted = false
          xterm.writeln(`[WasmForge] ${error?.message || error}`)
        }

        if (accepted) {
          inputStateRef.current = createEmptyInputState()
        } else {
          xterm.write(`${state.prompt}${state.buffer}`)
        }
        return
      }

      if (data === '\u007f') {
        if (state.buffer.length === 0) {
          return
        }

        state.buffer = state.buffer.slice(0, -1)
        xterm.write('\b \b')
        return
      }

      const printableChunk = sanitizeInputChunk(data)
      if (!printableChunk) {
        return
      }

      state.buffer += printableChunk
      xterm.write(printableChunk)
    })

    const handleResize = () => {
      fitAddon.fit()
      onResize?.({ cols: xterm.cols, rows: xterm.rows })
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      dataListener.dispose()
      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      inputStateRef.current = createEmptyInputState()
    }
  }, [onResize])

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0d1117',
        padding: '4px',
      }}
      ref={containerRef}
    />
  )
})

export default Terminal
