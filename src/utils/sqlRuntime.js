export function getFileExtension(filename) {
  return filename?.split(".").pop()?.toLowerCase() ?? "";
}

export function getRuntimeKind(filename) {
  switch (getFileExtension(filename)) {
    case "py":
      return "python";
    case "sql":
      return "sqlite";
    case "pg":
      return "pglite";
    case "js":
    case "ts":
      return "javascript";
    default:
      return "unknown";
  }
}

export function isSqlRuntime(filename) {
  const runtime = getRuntimeKind(filename);
  return runtime === "sqlite" || runtime === "pglite";
}

export function getSqlEngineLabel(engine) {
  switch (engine) {
    case "sqlite":
      return "SQLite";
    case "pglite":
      return "PostgreSQL (PGlite)";
    default:
      return "SQL";
  }
}

function getStem(filename = "") {
  return filename.replace(/\.[^.]+$/u, "") || "database";
}

export function getSqlDatabaseDescriptor(filename) {
  const stem = getStem(filename);

  switch (getRuntimeKind(filename)) {
    case "sqlite":
      return {
        engine: "sqlite",
        engineLabel: getSqlEngineLabel("sqlite"),
        databaseKey: `${stem}.sqlite`,
        databaseLabel: `${stem}.sqlite`,
      };

    case "pglite":
      return {
        engine: "pglite",
        engineLabel: getSqlEngineLabel("pglite"),
        databaseKey: `wasmforge/pglite/${encodeURIComponent(stem)}`,
        databaseLabel: `${stem}.pgdata`,
      };

    default:
      return null;
  }
}
