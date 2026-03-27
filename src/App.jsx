import { lazy, Suspense, useState, useRef, useCallback, useEffect } from "react";
import Terminal from "./components/Terminal.jsx";
import FileTree from "./components/FileTree.jsx";
import SqlResultsPanel from "./components/SqlResultsPanel.jsx";
import { usePyodideWorker } from "./hooks/usePyodideWorker.js";
import { useIOWorker } from "./hooks/useIOWorker.js";
import { useJsWorker } from "./hooks/useJsWorker.js";
import { useSqlWorkers } from "./hooks/useSqlWorkers.js";
import { DEFAULT_PYTHON } from "./constants/defaultPython.js";
import {
  getFileExtension,
  getRuntimeKind,
  getSqlDatabaseDescriptor,
} from "./utils/sqlRuntime.js";

const DEFAULT_FILENAME = "main.py";
const RECOVERY_STORAGE_KEY = "wasmforge:pending-workspace-writes";
const Editor = lazy(() => import("./components/Editor.jsx"));

function getLanguage(filename) {
  const ext = getFileExtension(filename);
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

function normalizeWorkspaceFilename(name) {
  const normalized = String(name ?? "").replace(/^\/?workspace\//u, "").trim();

  if (!normalized) {
    throw new Error("File name is required.");
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("Nested folders are not supported yet. Use a single file name.");
  }

  return normalized;
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

function createEmptySqlExecution() {
  return {
    engine: null,
    engineLabel: "",
    filename: "",
    databaseLabel: "",
    resultSets: [],
    error: "",
    errorMeta: null,
    durationMs: null,
    executedAt: null,
    recoveryMessage: "",
    restoredFromOpfs: false,
    storageRecovered: false,
  };
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
  const [sqlExecution, setSqlExecution] = useState(createEmptySqlExecution);
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
    fileExists,
    readBinaryFile,
    writeBinaryFile,
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

  const {
    sqliteReady,
    pgliteReady,
    sqliteStatus,
    pgliteStatus,
    isRunning: isSqlRunning,
    runningEngine,
    runSqliteQuery,
    runPgliteQuery,
    killSqlWorker,
  } = useSqlWorkers({
    onError: (error, engine) => {
      reportWorkspaceError(
        `[WasmForge] ${engine === "sqlite" ? "SQLite" : "PostgreSQL"} worker failed: ${error.message || error}`,
      );
    },
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

  const handleJavascriptDone = useCallback((error) => {
    if (!error) {
      terminalRef.current?.writeln("\x1b[90m\n[Process completed]\x1b[0m");
    }
  }, []);

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
          return submitted;
        },
      });
    },

    onDone: handlePythonDone,
  });

  useEffect(() => {
    submitStdinRef.current = submitStdin;
  }, [submitStdin]);

  const {
    runCode: runJsCode,
    killWorker: killJsWorker,
    isReady: isJsReady,
    isRunning: isJsRunning,
    status: jsStatus,
  } = useJsWorker({
    onStdout: writeStdout,
    onStderr: writeStderr,
    onReady: () => {
      terminalRef.current?.writeln(
        "\x1b[32m✓ JS/TS runtime ready (sandboxed worker + TypeScript transpile)\x1b[0m",
      );
      terminalRef.current?.writeln("");
    },
    onDone: handleJavascriptDone,
  });

  const executeSqliteFile = useCallback(
    async ({ filename, code }) => {
      const database = getSqlDatabaseDescriptor(filename);
      if (!database) {
        throw new Error("No SQLite database descriptor available");
      }

      setSqlExecution({
        ...createEmptySqlExecution(),
        engine: "sqlite",
        engineLabel: "SQLite",
        filename,
        databaseLabel: database.databaseLabel,
        executedAt: Date.now(),
      });

      const snapshotExists = await fileExists(database.databaseKey, "sqlite");
      const databaseBuffer = snapshotExists
        ? await readBinaryFile(database.databaseKey, "sqlite")
        : null;
      const hadSnapshotBytes = Boolean(
        databaseBuffer && databaseBuffer.byteLength > 0,
      );

      const persistExecutionResult = async ({
        executionResult,
        restoredFromOpfs,
        recoveryMessage = "",
        storageRecovered = false,
      }) => {
        const { databaseBuffer: exportedDatabase, ...uiResult } = executionResult;

        if (exportedDatabase) {
          try {
            await writeBinaryFile(
              database.databaseKey,
              exportedDatabase,
              "sqlite",
            );
          } catch (error) {
            killSqlWorker("sqlite");
            const persistenceError = new Error(
              `SQLite executed successfully, but persisting ${database.databaseLabel} back to OPFS failed. The in-memory database was reset so the next run reloads the last durable snapshot.`,
            );
            persistenceError.details = {
              engine: "sqlite",
              kind: "persistence",
              phase: "persist",
              databaseKey: database.databaseKey,
              databaseLabel: database.databaseLabel,
              cause: error.message || String(error),
            };
            throw persistenceError;
          }
        }

        setSqlExecution({
          ...uiResult,
          filename,
          databaseLabel: database.databaseLabel,
          executedAt: Date.now(),
          restoredFromOpfs,
          recoveryMessage,
          storageRecovered,
        });

        if (recoveryMessage) {
          terminalRef.current?.writeln(
            `\x1b[33m[WasmForge] ${recoveryMessage}\x1b[0m`,
          );
        }
      };

      try {
        const result = await runSqliteQuery({
          sql: code,
          databaseKey: database.databaseKey,
          databaseLabel: database.databaseLabel,
          databaseBuffer,
        });

        await persistExecutionResult({
          executionResult: result,
          restoredFromOpfs: snapshotExists,
        });
      } catch (error) {
        const canRecoverSnapshot =
          error?.details?.kind === "database_state" &&
          hadSnapshotBytes;

        if (!canRecoverSnapshot) {
          throw error;
        }

        const recoveryMessage = `Recovered ${database.databaseLabel} by resetting an incompatible SQLite snapshot in OPFS and retrying the query. The old stored database contents could not be opened safely and were discarded.`;

        try {
          await writeBinaryFile(
            database.databaseKey,
            new ArrayBuffer(0),
            "sqlite",
          );
        } catch (recoveryError) {
          const resetError = new Error(
            `Failed to reset the corrupted SQLite snapshot for ${database.databaseLabel}: ${recoveryError.message || recoveryError}`,
          );
          resetError.details = {
            engine: "sqlite",
            kind: "database_state",
            phase: "recover",
            databaseKey: database.databaseKey,
            databaseLabel: database.databaseLabel,
          };
          throw resetError;
        }

        const recoveredResult = await runSqliteQuery({
          sql: code,
          databaseKey: database.databaseKey,
          databaseLabel: database.databaseLabel,
          databaseBuffer: new ArrayBuffer(0),
        });

        await persistExecutionResult({
          executionResult: recoveredResult,
          restoredFromOpfs: false,
          recoveryMessage,
          storageRecovered: true,
        });
      }
    },
    [
      fileExists,
      killSqlWorker,
      readBinaryFile,
      runSqliteQuery,
      writeBinaryFile,
    ],
  );

  const executePgliteFile = useCallback(
    async ({ filename, code }) => {
      const database = getSqlDatabaseDescriptor(filename);
      if (!database) {
        throw new Error("No PostgreSQL database descriptor available");
      }

      setSqlExecution({
        ...createEmptySqlExecution(),
        engine: "pglite",
        engineLabel: "PostgreSQL (PGlite)",
        filename,
        databaseLabel: database.databaseLabel,
        executedAt: Date.now(),
      });

      const result = await runPgliteQuery({
        sql: code,
        databaseKey: database.databaseKey,
        databaseLabel: database.databaseLabel,
      });

      setSqlExecution({
        ...result,
        filename,
        databaseLabel: database.databaseLabel,
        executedAt: Date.now(),
      });

      if (result.recoveryMessage) {
        terminalRef.current?.writeln(
          `\x1b[33m[WasmForge] ${result.recoveryMessage}\x1b[0m`,
        );
      }
    },
    [runPgliteQuery],
  );

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

    if (getRuntimeKind(activeFileRef.current) === "javascript") {
      killJsWorker();
      return;
    }

    if (getRuntimeKind(activeFileRef.current) === "sqlite") {
      killSqlWorker("sqlite");
      return;
    }

    if (getRuntimeKind(activeFileRef.current) === "pglite") {
      killSqlWorker("pglite");
      return;
    }

    killWorker();
  }, [killJsWorker, killSqlWorker, killWorker]);

  const handleRun = useCallback(async () => {
    terminalRef.current?.cancelInput({ newline: false });
    const syncedSnapshot = syncActiveEditorDraft();
    const file = files.find((entry) => entry.name === activeFile);
    if (!file) {
      return;
    }

    const runtime = getRuntimeKind(activeFile);
    const codeToRun =
      syncedSnapshot?.filename === activeFile
        ? syncedSnapshot.content
        : file.content;

    terminalRef.current?.writeln(`\x1b[90m$ Running ${activeFile}...\x1b[0m\n`);

    switch (runtime) {
      case "python":
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
          code: codeToRun,
        });
        setStatus("Running...");
        break;

      case "javascript":
        if (!isJsReady) {
          terminalRef.current?.writeln(
            "\x1b[33m[WasmForge] JS/TS runtime still loading. Please wait...\x1b[0m",
          );
          return;
        }

        try {
          await flushAllWrites();
        } catch (error) {
          terminalRef.current?.writeln(
            `\x1b[33m[WasmForge] Workspace autosave is behind (${error.message || error}). Running the in-memory JS/TS snapshot anyway.\x1b[0m`,
          );
        }

        runJsCode({
          filename: activeFile,
          code: codeToRun,
        });
        break;

      case "sqlite":
        if (!sqliteReady) {
          setSqlExecution({
            ...createEmptySqlExecution(),
            engine: "sqlite",
            engineLabel: "SQLite",
            filename: activeFile,
            error: "SQLite runtime is still loading. Please wait a moment and try again.",
            executedAt: Date.now(),
          });
          break;
        }

        if (!codeToRun.trim()) {
          setSqlExecution({
            ...createEmptySqlExecution(),
            engine: "sqlite",
            engineLabel: "SQLite",
            filename: activeFile,
            error: "SQL file is empty. Add CREATE/INSERT/SELECT statements and run again.",
            executedAt: Date.now(),
          });
          break;
        }

        try {
          await executeSqliteFile({
            filename: activeFile,
            code: codeToRun,
          });
        } catch (error) {
          const database = getSqlDatabaseDescriptor(activeFile);
          setSqlExecution({
            ...createEmptySqlExecution(),
            engine: "sqlite",
            engineLabel: "SQLite",
            filename: activeFile,
            databaseLabel: database?.databaseLabel ?? "",
            error:
              error?.details?.kind === "killed"
                ? "Execution killed by user."
                : error.message || String(error),
            errorMeta: error.details || null,
            recoveryMessage: error?.details?.recoveryMessage || "",
            executedAt: Date.now(),
          });
        }
        break;

      case "pglite":
        if (!pgliteReady) {
          setSqlExecution({
            ...createEmptySqlExecution(),
            engine: "pglite",
            engineLabel: "PostgreSQL (PGlite)",
            filename: activeFile,
            error: "PostgreSQL runtime is still loading. Please wait a moment and try again.",
            executedAt: Date.now(),
          });
          break;
        }

        if (!codeToRun.trim()) {
          setSqlExecution({
            ...createEmptySqlExecution(),
            engine: "pglite",
            engineLabel: "PostgreSQL (PGlite)",
            filename: activeFile,
            error: "SQL file is empty. Add PostgreSQL statements and run again.",
            executedAt: Date.now(),
          });
          break;
        }

        try {
          await executePgliteFile({
            filename: activeFile,
            code: codeToRun,
          });
        } catch (error) {
          const database = getSqlDatabaseDescriptor(activeFile);
          setSqlExecution({
            ...createEmptySqlExecution(),
            engine: "pglite",
            engineLabel: "PostgreSQL (PGlite)",
            filename: activeFile,
            databaseLabel: database?.databaseLabel ?? "",
            error:
              error?.details?.kind === "killed"
                ? "Execution killed by user."
                : error.message || String(error),
            errorMeta: error.details || null,
            recoveryMessage: error?.details?.recoveryMessage || "",
            executedAt: Date.now(),
          });
        }
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
    isJsReady,
    sqliteReady,
    pgliteReady,
    flushAllWrites,
    runCode,
    runJsCode,
    reportWorkspaceError,
    syncActiveEditorDraft,
    executeSqliteFile,
    executePgliteFile,
  ]);

  const handleFileSelect = useCallback(
    async (name) => {
      if ((isRunning || isJsRunning) && name !== activeFileRef.current) {
        terminalRef.current?.writeln(
          "\x1b[33m[WasmForge] Finish or kill the active Python/JS program before switching files.\x1b[0m",
        );
        return;
      }

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
      isJsRunning,
      isRunning,
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
    if (isRunning || isJsRunning) {
      terminalRef.current?.writeln(
        "\x1b[33m[WasmForge] Finish or kill the active Python/JS program before creating files.\x1b[0m",
      );
      return;
    }

    const name = prompt("File name (e.g. script.py, query.sql):");
    if (!name || !name.trim()) {
      return;
    }

    let trimmed;
    try {
      trimmed = normalizeWorkspaceFilename(name);
    } catch (error) {
      alert(error.message || String(error));
      return;
    }

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

    try {
      await writeFile(trimmed, "");
      setFiles((prev) =>
        sortFileRecords([...prev, createFileRecord(trimmed, "")]),
      );
      setActiveFile(trimmed);
    } catch (error) {
      reportWorkspaceError(
        `[WasmForge] Failed to create ${trimmed}: ${error.message || error}`,
      );
    }
  }, [
    files,
    flushAllWrites,
    isJsRunning,
    isRunning,
    writeFile,
    reportWorkspaceError,
    syncActiveEditorDraft,
  ]);

  const activeFileData = files.find((file) => file.name === activeFile);
  const activeRuntime = getRuntimeKind(activeFile);
  const showResultsPanel =
    activeRuntime === "sqlite" || activeRuntime === "pglite";
  const activeSqlResult =
    sqlExecution.filename === activeFile ? sqlExecution : null;
  const activeRuntimeReady =
    activeRuntime === "python"
      ? isReady
      : activeRuntime === "javascript"
        ? isJsReady
      : activeRuntime === "sqlite"
        ? sqliteReady
        : activeRuntime === "pglite"
          ? pgliteReady
          : false;
  const activeRuntimeRunning =
    activeRuntime === "python"
      ? isRunning
      : activeRuntime === "javascript"
        ? isJsRunning
      : isSqlRunning && runningEngine === activeRuntime;
  const isAnyRuntimeBusy = isRunning || isJsRunning || isSqlRunning;
  const activeStatusMessage =
    activeRuntime === "sqlite"
      ? sqliteStatus
      : activeRuntime === "pglite"
        ? pgliteStatus
        : activeRuntime === "javascript"
          ? jsStatus
          : activeRuntime === "unknown"
            ? "Unsupported file type"
        : status;
  const activeHasError =
    activeRuntime === "python"
      ? status === "Error"
      : activeRuntime === "javascript"
        ? jsStatus === "Execution failed" || jsStatus === "JS/TS runtime crashed"
      : Boolean(activeSqlResult?.error);
  const canKillActiveRuntime =
    activeRuntime === "python" ||
    activeRuntime === "javascript" ||
    activeRuntime === "sqlite" ||
    activeRuntime === "pglite";
  const terminalRuntimeLabel =
    activeRuntime === "javascript" ? "JS/TS" : "Python";
  const terminalRuntimeAccent =
    activeRuntime === "javascript"
      ? {
          color: "#d29922",
          background: "#362708",
          border: "1px solid #6b4f18",
        }
      : {
          color: "#3fb950",
          background: "#0d2b1a",
          border: "1px solid #1e4a2a",
        };
  const statusColor =
    activeHasError
      ? "#ff7b72"
      : activeRuntime === "python" && isAwaitingInput
        ? "#58a6ff"
        : activeRuntimeRunning
          ? "#f0883e"
          : activeRuntimeReady
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

        <span style={{ fontSize: "12px", color: statusColor }}>
          ● {activeStatusMessage}
        </span>

        {canKillActiveRuntime && activeRuntimeRunning ? (
          <button onClick={handleKill} style={btnStyle("#c0392b", "#e74c3c")}>
            ■ Kill
          </button>
        ) : (
          <button
            onClick={handleRun}
            disabled={
              isAnyRuntimeBusy ||
              activeRuntime === "unknown" ||
              !activeRuntimeReady
            }
            style={btnStyle(
              activeRuntimeReady ? "#238636" : "#1c2128",
              activeRuntimeReady ? "#2ea043" : "#30363d",
            )}
          >
            {activeRuntimeRunning
              ? "Running..."
              : isAnyRuntimeBusy
                ? "Runtime busy"
                : "▶️ Run"}
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
            disabled={isRunning || isJsRunning}
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
              readOnly={isRunning || isJsRunning}
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
              {showResultsPanel ? "Results" : "Terminal"}
            </span>
            <span
              style={{
                fontSize: "10px",
                color: showResultsPanel
                  ? activeRuntime === "sqlite"
                    ? "#58a6ff"
                    : "#56d364"
                  : terminalRuntimeAccent.color,
                background: showResultsPanel
                  ? activeRuntime === "sqlite"
                    ? "#0d2538"
                    : "#0f2e1f"
                  : terminalRuntimeAccent.background,
                padding: "1px 6px",
                borderRadius: "10px",
                border: showResultsPanel
                  ? activeRuntime === "sqlite"
                    ? "1px solid #1f6feb"
                    : "1px solid #238636"
                  : terminalRuntimeAccent.border,
              }}
            >
              {showResultsPanel
                ? activeRuntime === "sqlite"
                  ? "SQLite"
                  : "PGlite"
                : terminalRuntimeLabel}
            </span>
          </div>
          <div style={{ height: "calc(100% - 28px)", position: "relative" }}>
            <div
              style={{
                display: showResultsPanel ? "none" : "block",
                height: "100%",
              }}
            >
              <Terminal ref={terminalRef} />
            </div>
            <div
              style={{
                display: showResultsPanel ? "block" : "none",
                height: "100%",
              }}
            >
              <SqlResultsPanel
                activeFile={activeFile}
                engine={activeRuntime}
                result={activeSqlResult}
                isReady={activeRuntimeReady}
                isRunning={activeRuntimeRunning}
                status={activeStatusMessage}
              />
            </div>
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
