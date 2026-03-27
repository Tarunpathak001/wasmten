# WasmForge

**Your entire dev environment. One browser tab. Zero servers.**

WasmForge is a fully in-browser IDE where the editor, terminal, filesystem, and Python runtime all execute locally in the browser through WebAssembly.

## Current Capabilities

- Monaco editor with multi-file workspace support
- Xterm.js terminal with live Python stdout and stderr
- Python execution through Pyodide in a dedicated Web Worker
- Persistent browser workspace storage through OPFS
- Offline-friendly local Pyodide assets and PWA caching
- Interactive `input()` support in the terminal through `SharedArrayBuffer` and `Atomics`
- Local package loading for `numpy` and `pandas`

## Local Setup

```bash
npm install
npm run dev
```

Open the app and verify cross-origin isolation in the browser console:

```js
window.crossOriginIsolated
```

This must return `true` for interactive `input()` support to work.

## Quick Python Check

Try this in `main.py`:

```python
name = input("Enter your name: ")
age = input("Enter your age: ")
print(f"Hello, {name}")
print(f"Age: {age}")
```

Expected behavior:

- The terminal prints each prompt in order
- The worker waits without freezing the UI
- Pressing `Enter` resumes Python execution
- Multiple sequential `input()` calls continue to work

## Deploying To Vercel

This repo already includes the required headers in [vercel.json](./vercel.json).

1. Push the repository to GitHub.
2. Import the repository into [Vercel](https://vercel.com/).
3. Use these project settings:
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Deploy the project.

After deployment, open the live URL and run this in the browser console:

```js
window.crossOriginIsolated
```

It must return `true`. If it returns `false`, `SharedArrayBuffer` is disabled and terminal `input()` will not work on that deployment.

## Notes

- Local dev headers are configured in [vite.config.js](./vite.config.js).
- Production headers are configured in [vercel.json](./vercel.json).
- If a custom proxy or CDN strips `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`, interactive stdin will fail even if localhost works.

## Watch The Code 2026 | PS #10: WebIDE

Team Codeinit
