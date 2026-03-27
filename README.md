# WasmForge

**A browser IDE that runs code, saves files, and works offline.**

Built by **Team Codeinit** for **Watch The Code 2026**.

WasmForge is our take on a zero-backend WebIDE. The idea is simple: open one browser tab and get an editor, terminal, file system, Python runtime, JavaScript/TypeScript runtime, and SQL playground without needing a server.

## Why We Built This

Most online IDEs still depend on a backend for code execution, storage, or environment setup. We wanted to push more of that experience into the browser itself using WebAssembly, Web Workers, and modern browser storage APIs.

That means:

- code runs locally in the browser
- files stay in the browser with persistent storage
- the UI stays responsive even when runtimes are busy
- the app can keep working after assets are cached once

## What You Can Do

- Write and switch between multiple files in Monaco Editor
- Run Python in a dedicated Pyodide worker
- Use `input()` in Python through the terminal
- Run `.js` and `.ts` files in a sandboxed worker
- Execute `.sql` files with SQLite
- Execute `.pg` files with PGlite
- Keep files saved across refreshes using OPFS
- Use the app offline after the first cache warm-up

## Supported Files

| File type | Runtime | Output |
| --- | --- | --- |
| `.py` | Pyodide | Terminal |
| `.js` | JS Worker | Terminal |
| `.ts` | TS -> JS Worker | Terminal |
| `.sql` | SQLite Worker | Results panel |
| `.pg` | PGlite Worker | Results panel |

## What Makes It Interesting

### Python in the browser

Python runs inside a Worker using Pyodide, so the main UI does not freeze while code is running.

### Interactive terminal input

`input()` works through `SharedArrayBuffer` and `Atomics`, which lets Python pause for terminal input and continue after the user responds.

### Real browser persistence

Files are written to the Origin Private File System, so they survive refreshes and browser restarts.

### SQL engines in-browser

SQLite and PostgreSQL-style queries run in their own workers and render into a sortable results table.

### Offline-ready

The app is set up as a PWA and caches the heavy runtime assets locally, including Pyodide files and database assets.

## Stack

- React
- Vite
- Monaco Editor
- Xterm.js
- Pyodide
- sql.js
- PGlite
- sucrase
- vite-plugin-pwa
- OPFS
- Web Workers

## Project Structure

- `src/App.jsx` - main app orchestration
- `src/workers/pyodide.worker.js` - Python execution
- `src/workers/js.worker.js` - JavaScript and TypeScript execution
- `src/workers/io.worker.js` - persistent file I/O through OPFS
- `src/workers/sqlite.worker.js` - SQLite runtime
- `src/workers/pglite.worker.js` - PostgreSQL-style runtime
- `src/components/` - editor, terminal, file tree, and SQL results UI

## Run It Locally

```bash
npm install
npm run dev
```

To create a production build:

```bash
npm run build
```

To preview the production build:

```bash
npm run preview
```

## Quick Things To Try

### Python

```python
name = input("Enter your name: ")
print("Hello, " + name)
```

### TypeScript

```ts
const nums: number[] = [1, 2, 3]
console.log(nums.reduce((sum, value) => sum + value, 0))
```

### SQLite

```sql
create table if not exists users (id integer primary key, name text);
insert into users (name) values ('Ada'), ('Linus');
select * from users order by id;
```

### PostgreSQL

```sql
select 1 as one;
```

## Deployment Note

For terminal input to work, the app needs cross-origin isolation.

After deployment, check:

```js
window.crossOriginIsolated
```

It should return `true`.

This repo already includes the required headers in `vercel.json`.

## Best Demo Flow

If you are demoing this project:

1. Open the app once while online
2. Let the runtimes finish loading
3. Refresh once so the service worker is active
4. Then test the offline flow

## Current Limits

- The workspace explorer is still flat-file only
- JS/TS worker currently does not support ESM imports or TSX
- Best experience is on Chromium-based browsers

## Final Note

This project was built as a hackathon-style exploration of how far a WebIDE can go with just browser technologies. The goal was not just to run code in the browser, but to make it feel like a small local development environment living inside one tab.
