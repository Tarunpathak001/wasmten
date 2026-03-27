import { lazy, Suspense, useState, useRef, useCallback, useEffect } from "react";
import Terminal from "./components/Terminal.jsx";
import FileTree from "./components/FileTree.jsx";
import { usePyodideWorker } from "./hooks/usePyodideWorker.js";
import { useIOWorker } from "./hooks/useIOWorker.js";
import { DEFAULT_PYTHON } from "./constants/defaultPython.js";

const DEFAULT_FILENAME = "main.py";
const RECOVERY_STORAGE_KEY = "wasmforge:pending-workspace-writes";
const Editor = lazy(() => import("./components/Editor.jsx"));

function getLanguage(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py":
      return "python";
    case "js":
      return "javascript";
    case "ts":
      return "typescript";
    case "sql":
      return "sql";
    case "pg":
      return "sql";
    default:
      return "plaintext";
  }
}

function createFileRecord(name, content = "") {
  return { name, content, language: getLanguage(name) };
}

function chooseActiveFile(filenames, preferredFile) {
  if (preferredFile && filenames.includes(preferredFile)) {
    return preferredFile;
  }
  if (filenames.includes(DEFAULT_FILENAME)) {
    return DEFAULT_FILENAME;
  }
  return filenames[0] ?? DEFAULT_FILENAME;
}

function sortFileRecords(files) {
  return [...files].sort((left, right) => left.name.localeCompare(right.name));
}

function readRecoveryEntries() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string"),
    );
  } catch {
    return {};
  }
}

function persistRecoveryEntries(entries) {
  if (typeof window === "undefined") {
    return;
  }

  if (Object.keys(entries).length === 0) {
    window.localStorage.removeItem(RECOVERY_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(entries));
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(DEFAULT_FILENAME);
  const [status, setStatus] = useState("Restoring workspace...");
  const terminalRef = useRef(null);
  const submitStdinRef = useRef(() => false);
  const editorRef = useRef(null);
  const editorSubscriptionRef = useRef(null);
  const activeFileRef = useRef(DEFAULT_FILENAME);
  const recoveryWritesRef = useRef(readRecoveryEntries());

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);

  const writeStdout = useCallback((data) => {
    terminalRef.current?.write(data);
  }, []);

  const writeStderr = useCallback((data) => {
    terminalRef.current?.write(`\x1b[31m${data}\x1b[0m`);
  }, []);

  const reportWorkspaceError = useCallback(
    (message) => {
      console.error(message);
      writeStderr(`${message}\n`);
    },
    [writeStderr],
  );

  const stageRecoveryWrite = useCallback((filename, content) => {
    recoveryWritesRef.current = {
      ...recoveryWritesRef.current,
      [filename]: content,
    };
    persistRecoveryEntries(recoveryWritesRef.current);
  }, []);

  const clearRecoveryWrite = useCallback((filename) => {
    if (!Object.prototype.hasOwnProperty.call(recoveryWritesRef.current, filename)) {
      return;
    }

    const nextRecoveryWrites = { ...recoveryWritesRef.current };
    delete nextRecoveryWrites[filename];
    recoveryWritesRef.current = nextRecoveryWrites;
    persistRecoveryEntries(nextRecoveryWrites);
  }, []);

  const getEditorFilename = useCallback((editor) => {
    const modelPath = editor?.getModel?.()?.uri?.path;
    if (typeof modelPath === "string" && modelPath.length > 1) {
      return modelPath.replace(/^\/+/u, "");
    }

    return activeFileRef.current;
  }, []);

  const getActiveEditorSnapshot = useCallback(() => {
    const filename = activeFileRef.current;
    if (!filename) {
      return null;
    }

    const liveEditorValue = editorRef.current?.getValue();
    const fallbackFile = files.find((file) => file.name === filename);
    return {
      filename,
      content: liveEditorValue ?? fallbackFile?.content ?? "",
    };
  }, [files]);

  const {
    isReady: isIOWorkerReady,
    listFiles,
    readFile,
    writeFile,
    scheduleWrite,
    flushAllWrites,
  } = useIOWorker({
    onError: (error) => {
      reportWorkspaceError(
        `[WasmForge] Workspace I/O failed: ${error.message || error}`,
      );
    },
    onWriteFlushed: clearRecoveryWrite,
  });

  const upsertFileContent = useCallback((filename, content) => {
    setFiles((prev) => {
      let found = false;
      const next = prev.map((file) => {
        if (file.name !== filename) {
          return file;
        }
        found = true;
        return { ...file, content, language: getLanguage(filename) };
      });

      return found
        ? next
        : sortFileRecords([...next, createFileRecord(filename, content)]);
    });
  }, []);

  const replaceFileList = useCallback((filenames) => {
    setFiles((prev) => {
      const previousFiles = new Map(prev.map((file) => [file.name, file]));
      return filenames
        .map((filename) => {
          const existing = previousFiles.get(filename);
          return createFileRecord(filename, existing?.content ?? "");
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    });
  }, []);

  const recoverPendingWrites = useCallback(async () => {
    const entries = Object.entries(recoveryWritesRef.current);
    for (const [filename, content] of entries) {
      await writeFile(filename, content);
      clearRecoveryWrite(filename);
    }
  }, [clearRecoveryWrite, writeFile]);

  const refreshWorkspaceFiles = useCallback(
    async (preferredFile = activeFileRef.current, options = {}) => {
      const { createDefaultIfEmpty = false } = options;
      const filenames = await listFiles();

      if (filenames.length === 0) {
        if (createDefaultIfEmpty) {
          await writeFile(DEFAULT_FILENAME, DEFAULT_PYTHON);
          setFiles([createFileRecord(DEFAULT_FILENAME, DEFAULT_PYTHON)]);
          setActiveFile(DEFAULT_FILENAME);
        } else {
          setFiles([]);
          setActiveFile(DEFAULT_FILENAME);
        }
        return;
      }

      replaceFileList(filenames);

      const nextActiveFile = chooseActiveFile(filenames, preferredFile);
      setActiveFile(nextActiveFile);
      const content = await readFile(nextActiveFile);
      upsertFileContent(nextActiveFile, content);
    },
    [listFiles, readFile, replaceFileList, upsertFileContent, writeFile],
  );

  const handlePythonDone = useCallback(
    (error) => {
      terminalRef.current?.cancelInput({ newline: false });
      refreshWorkspaceFiles(activeFileRef.current).catch((refreshError) => {
        reportWorkspaceError(
          `[WasmForge] Failed to refresh workspace: ${refreshError.message || refreshError}`,
        );
      });

      if (error && error !== "Killed by user" && !error.startsWith("Timeout")) {
        setStatus("Error");
        return;
      }

      setStatus("Python ready");
      if (!error) {
        terminalRef.current?.writeln("\x1b[90m\n[Process completed]\x1b[0m");
      }
    },
    [refreshWorkspaceFiles, reportWorkspaceError],
  );

  const syncActiveEditorDraft = useCallback(
    ({ scheduleWorkerWrite = true, updateState = true } = {}) => {
      const snapshot = getActiveEditorSnapshot();
      if (!snapshot) {
        return null;
      }

      const { filename, content } = snapshot;
      if (updateState) {
        upsertFileContent(filename, content);
      }
      stageRecoveryWrite(filename, content);

      if (scheduleWorkerWrite) {
        scheduleWrite(filename, content);
      }

      return snapshot;
    },
    [getActiveEditorSnapshot, scheduleWrite, stageRecoveryWrite, upsertFileContent],
  );

  const handleEditorMount = useCallback(
    (editor) => {
      editorRef.current = editor;

      if (editorSubscriptionRef.current) {
        editorSubscriptionRef.current.dispose();
      }

      editorSubscriptionRef.current = editor.onDidChangeModelContent(() => {
        const filename = getEditorFilename(editor);
        if (!filename) {
          return;
        }

        stageRecoveryWrite(filename, editor.getValue());
      });
    },
    [getEditorFilename, stageRecoveryWrite],
  );

  const {
    runCode,
    submitStdin,
    killWorker,
    isReady,
    isRunning,
    isAwaitingInput,
  } = usePyodideWorker({
    onStdout: writeStdout,
    onStderr: writeStderr,

    onReady: ({ stdinSupported } = {}) => {
      setStatus("Python ready");
      terminalRef.current?.writeln(
        "\x1b[32m✓ Python runtime ready (Pyodide core + OPFS persistence)\x1b[0m",
      );
      terminalRef.current?.writeln(
        "\x1b[90mFiles auto-save to persistent browser storage every 300ms.\x1b[0m",
      );
      terminalRef.current?.writeln(
        "\x1b[90mNumPy and pandas resolve from local cached assets after the first load.\x1b[0m",
      );
      terminalRef.current?.writeln(
        stdinSupported
          ? "\x1b[90mInteractive stdin enabled: Python input() now blocks safely through SharedArrayBuffer + Atomics.\x1b[0m"
          : "\x1b[33mInteractive stdin disabled: window.crossOriginIsolated is false, so SharedArrayBuffer is unavailable. Verify COOP/COEP headers on the live URL.\x1b[0m",
      );
      terminalRef.current?.writeln("");
    },

    onProgress: (msg) => {
      setStatus(msg);
      terminalRef.current?.writeln(`\x1b[90m${msg}\x1b[0m`);
    },

    onStdinRequest: (prompt) => {
      setStatus("Waiting for input...");
      terminalRef.current?.requestInput({
        prompt,
        onSubmit: (value) => {
          const submitted = submitStdinRef.current?.(value);
          if (submitted) {
            setStatus("Running...");
          }
        },
      });
    },

    onDone: handlePythonDone,
  });

  useEffect(() => {
    submitStdinRef.current = submitStdin;
  }, [submitStdin]);

  useEffect(() => {
    if (!isIOWorkerReady) {
      return;
    }

    recoverPendingWrites()
      .then(() =>
        refreshWorkspaceFiles(DEFAULT_FILENAME, {
          createDefaultIfEmpty: true,
        }),
      )
      .catch((error) => {
        reportWorkspaceError(
          `[WasmForge] Failed to restore workspace: ${error.message || error}`,
        );
        setFiles([createFileRecord(DEFAULT_FILENAME, DEFAULT_PYTHON)]);
        setActiveFile(DEFAULT_FILENAME);
      });
  }, [
    isIOWorkerReady,
    recoverPendingWrites,
    refreshWorkspaceFiles,
    reportWorkspaceError,
  ]);

  useEffect(() => {
    const flushPendingWorkspaceWrites = () => {
      syncActiveEditorDraft({
        scheduleWorkerWrite: false,
        updateState: false,
      });
      void flushAllWrites().catch(() => {
        // Best-effort during teardown/navigation.
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPendingWorkspaceWrites();
      }
    };

    window.addEventListener("pagehide", flushPendingWorkspaceWrites);
    window.addEventListener("beforeunload", flushPendingWorkspaceWrites);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushPendingWorkspaceWrites);
      window.removeEventListener("beforeunload", flushPendingWorkspaceWrites);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushAllWrites, syncActiveEditorDraft]);

  useEffect(() => {
    return () => {
      editorSubscriptionRef.current?.dispose();
      editorSubscriptionRef.current = null;
    };
  }, []);

  const handleKill = useCallback(() => {
    terminalRef.current?.cancelInput({ reason: "^C" });
    killWorker();
  }, [killWorker]);

  const handleRun = useCallback(async () => {
    terminalRef.current?.cancelInput({ newline: false });
    const syncedSnapshot = syncActiveEditorDraft();
    const file = files.find((entry) => entry.name === activeFile);
    if (!file) {
      return;
    }

    const ext = activeFile.split(".").pop()?.toLowerCase();
    terminalRef.current?.writeln(`\x1b[90m$ Running ${activeFile}...\x1b[0m\n`);

    switch (ext) {
      case "py":
        if (!isReady) {
          terminalRef.current?.writeln(
            "\x1b[33m[WasmForge] Python runtime still loading. Please wait...\x1b[0m",
          );
          return;
        }

        try {
          await flushAllWrites();
        } catch (error) {
          reportWorkspaceError(
            `[WasmForge] Failed to persist files before execution: ${error.message || error}`,
          );
          return;
        }

        runCode({
          filename: activeFile,
          code: syncedSnapshot?.filename === activeFile
            ? syncedSnapshot.content
            : file.content,
        });
        setStatus("Running...");
        break;

      case "js":
      case "ts":
        terminalRef.current?.writeln(
          "\x1b[33m[WasmForge] JS/TS Worker coming in Phase 6.\x1b[0m\n",
        );
        break;

      case "sql":
      case "pg":
        terminalRef.current?.writeln(
          "\x1b[33m[WasmForge] SQL Workers coming in Phase 5.\x1b[0m\n",
        );
        break;

      default:
        terminalRef.current?.writeln(
          "\x1b[31m[WasmForge] Unknown file type.\x1b[0m\n",
        );
    }
  }, [
    files,
    activeFile,
    isReady,
    flushAllWrites,
    runCode,
    reportWorkspaceError,
    syncActiveEditorDraft,
  ]);

  const handleFileSelect = useCallback(
    async (name) => {
      try {
        syncActiveEditorDraft();
        await flushAllWrites();
        const content = await readFile(name);
        setActiveFile(name);
        upsertFileContent(name, content);
      } catch (error) {
        reportWorkspaceError(
          `[WasmForge] Failed to load ${name}: ${error.message || error}`,
        );
      }
    },
    [
      flushAllWrites,
      readFile,
      upsertFileContent,
      reportWorkspaceError,
      syncActiveEditorDraft,
    ],
  );

  const handleCodeChange = useCallback(
    (newContent) => {
      if (!activeFile) {
        return;
      }

      upsertFileContent(activeFile, newContent);
      stageRecoveryWrite(activeFile, newContent);
      scheduleWrite(activeFile, newContent);
    },
    [activeFile, upsertFileContent, stageRecoveryWrite, scheduleWrite],
  );

  const handleNewFile = useCallback(async () => {
    const name = prompt("File name (e.g. script.py, query.sql):");
    if (!name || !name.trim()) {
      return;
    }

    const trimmed = name.trim();
    if (files.some((file) => file.name === trimmed)) {
      alert("File already exists.");
      return;
    }

    try {
      syncActiveEditorDraft();
      await flushAllWrites();
    } catch (error) {
      reportWorkspaceError(
        `[WasmForge] Failed to save current files before creating ${trimmed}: ${error.message || error}`,
      );
      return;
    }

    setFiles((prev) =>
      sortFileRecords([...prev, createFileRecord(trimmed, "")]),
    );
    setActiveFile(trimmed);

    try {
      await writeFile(trimmed, "");
    } catch (error) {
      reportWorkspaceError(
        `[WasmForge] Failed to create ${trimmed}: ${error.message || error}`,
      );
    }
  }, [files, flushAllWrites, writeFile, reportWorkspaceError, syncActiveEditorDraft]);

  const activeFileData = files.find((file) => file.name === activeFile);

  const statusColor =
    status === "Error"
      ? "#ff7b72"
      : isAwaitingInput
        ? "#58a6ff"
      : isRunning
        ? "#f0883e"
        : isReady
          ? "#3fb950"
          : "#8b949e";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0d1117",
      }}
    >
      <div
        style={{
          height: "40px",
          background: "#161b22",
          borderBottom: "1px solid #30363d",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: "12px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontWeight: 700,
            color: "#58a6ff",
            fontSize: "14px",
            letterSpacing: "0.05em",
          }}
        >
          ⚡ WasmForge
        </span>
        <span style={{ color: "#30363d" }}>|</span>
        <span style={{ color: "#8b949e", fontSize: "12px" }}>{activeFile}</span>

        <div style={{ flex: 1 }} />

        <span style={{ fontSize: "12px", color: statusColor }}>● {status}</span>

        {isRunning ? (
          <button onClick={handleKill} style={btnStyle("#c0392b", "#e74c3c")}>
            ■ Kill
          </button>
        ) : (
          <button
            onClick={handleRun}
            style={btnStyle(
              isReady ? "#238636" : "#1c2128",
              isReady ? "#2ea043" : "#30363d",
            )}
          >
            ▶️ Run
          </button>
        )}

        <button
          onClick={() => terminalRef.current?.clear()}
          style={btnStyle("#1c2128", "#30363d")}
        >
          Clear
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ width: "200px", flexShrink: 0 }}>
          <FileTree
            files={files}
            activeFile={activeFile}
            onFileSelect={handleFileSelect}
            onNewFile={handleNewFile}
          />
        </div>

        <div
          style={{
            flex: 1,
            overflow: "hidden",
            borderLeft: "1px solid #30363d",
            borderRight: "1px solid #30363d",
          }}
        >
          <Suspense
            fallback={
              <div
                style={{
                  height: "100%",
                  display: "grid",
                  placeItems: "center",
                  color: "#8b949e",
                  fontSize: "13px",
                  background: "#0d1117",
                }}
              >
                Loading editor...
              </div>
            }
          >
            <Editor
              code={activeFileData?.content ?? ""}
              filename={activeFile || DEFAULT_FILENAME}
              onChange={handleCodeChange}
              onMount={handleEditorMount}
              language={getLanguage(activeFile || DEFAULT_FILENAME)}
            />
          </Suspense>
        </div>

        <div style={{ width: "45%", flexShrink: 0, overflow: "hidden" }}>
          <div
            style={{
              height: "28px",
              background: "#161b22",
              borderBottom: "1px solid #30363d",
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              gap: "8px",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: "#8b949e",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Terminal
            </span>
            <span
              style={{
                fontSize: "10px",
                color: "#3fb950",
                background: "#0d2b1a",
                padding: "1px 6px",
                borderRadius: "10px",
                border: "1px solid #1e4a2a",
              }}
            >
              Python
            </span>
          </div>
          <div style={{ height: "calc(100% - 28px)" }}>
            <Terminal ref={terminalRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

function btnStyle(bg, hover) {
  return {
    background: bg,
    border: `1px solid ${hover}`,
    color: "#c9d1d9",
    padding: "4px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
    transition: "background 0.15s",
  };
}
