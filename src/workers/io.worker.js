const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const WRITE_DEBOUNCE_MS = 300
const stagedWrites = new Map()

async function getScopedDirectory(scope = 'workspace') {
  const root = await navigator.storage.getDirectory()

  switch (scope) {
    case 'workspace':
      return root.getDirectoryHandle('workspace', { create: true })

    case 'sqlite': {
      const databasesDirectory = await root.getDirectoryHandle('databases', { create: true })
      return databasesDirectory.getDirectoryHandle('sqlite', { create: true })
    }

    default:
      throw new Error(`Unsupported OPFS scope: ${scope}`)
  }
}

function normalizeFilename(filename) {
  const normalized = String(filename || '').replace(/^\/?workspace\//u, '').trim()
  if (!normalized) {
    throw new Error('Filename is required')
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('Nested paths are not supported in the workspace explorer yet')
  }
  return normalized
}

async function getScopedFileHandle(filename, { scope = 'workspace', create = false } = {}) {
  const directory = await getScopedDirectory(scope)
  return directory.getFileHandle(normalizeFilename(filename), { create })
}

async function writeFile(filename, content, scope = 'workspace') {
  const fileHandle = await getScopedFileHandle(filename, { scope, create: true })
  const access = await fileHandle.createSyncAccessHandle()

  try {
    const encoded = textEncoder.encode(content)
    access.truncate(0)
    access.write(encoded, { at: 0 })
    access.flush()
  } finally {
    access.close()
  }

  return { ok: true }
}

async function writeBinaryFile(filename, content, scope = 'sqlite') {
  const fileHandle = await getScopedFileHandle(filename, { scope, create: true })
  const access = await fileHandle.createSyncAccessHandle()

  try {
    const bytes = content instanceof Uint8Array
      ? content
      : new Uint8Array(content ?? new ArrayBuffer(0))
    access.truncate(0)
    access.write(bytes, { at: 0 })
    access.flush()
  } finally {
    access.close()
  }

  return { ok: true, size: content?.byteLength ?? 0 }
}

async function readFile(filename, scope = 'workspace') {
  const normalizedFilename = normalizeFilename(filename)
  const stagedWrite = scope === 'workspace'
    ? stagedWrites.get(normalizedFilename)
    : null
  if (stagedWrite && scope === 'workspace') {
    return stagedWrite.content
  }

  const fileHandle = await getScopedFileHandle(normalizedFilename, { scope })
  const access = await fileHandle.createSyncAccessHandle()

  try {
    const size = access.getSize()
    const buffer = new Uint8Array(size)
    access.read(buffer, { at: 0 })
    return textDecoder.decode(buffer)
  } finally {
    access.close()
  }
}

async function readBinaryFile(filename, scope = 'sqlite') {
  const fileHandle = await getScopedFileHandle(filename, { scope })
  const access = await fileHandle.createSyncAccessHandle()

  try {
    const size = access.getSize()
    const buffer = new Uint8Array(size)
    access.read(buffer, { at: 0 })
    return buffer.buffer
  } finally {
    access.close()
  }
}

async function listFiles() {
  const workspace = await getScopedDirectory('workspace')
  const filenames = new Set(stagedWrites.keys())

  for await (const [name, handle] of workspace.entries()) {
    if (handle.kind === 'file') {
      filenames.add(name)
    }
  }

  return Array.from(filenames).sort((left, right) => left.localeCompare(right))
}

async function fileExists(filename, scope = 'workspace') {
  try {
    await getScopedFileHandle(filename, { scope })
    return true
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return false
    }

    throw error
  }
}

async function flushStagedWrite(filename) {
  const normalizedFilename = normalizeFilename(filename)
  const pending = stagedWrites.get(normalizedFilename)
  if (!pending) {
    return { ok: true, flushed: false }
  }

  clearTimeout(pending.timer)
  stagedWrites.delete(normalizedFilename)
  await writeFile(normalizedFilename, pending.content)
  postWriteFlushed(normalizedFilename)
  return { ok: true, flushed: true }
}

async function flushAllStagedWrites() {
  const filenames = Array.from(stagedWrites.keys())
  for (const filename of filenames) {
    await flushStagedWrite(filename)
  }

  return { ok: true, count: filenames.length }
}

function postWriteError(filename, error) {
  self.postMessage({
    type: 'write_error',
    filename,
    error: error?.message || String(error),
  })
}

function postWriteFlushed(filename) {
  self.postMessage({
    type: 'write_flushed',
    filename,
  })
}

function scheduleWrite(filename, content) {
  const normalizedFilename = normalizeFilename(filename)
  const existing = stagedWrites.get(normalizedFilename)
  if (existing) {
    clearTimeout(existing.timer)
  }

  const timer = setTimeout(async () => {
    const pending = stagedWrites.get(normalizedFilename)
    if (!pending || pending.timer !== timer) {
      return
    }

    stagedWrites.delete(normalizedFilename)

    try {
      await writeFile(normalizedFilename, pending.content)
      postWriteFlushed(normalizedFilename)
    } catch (error) {
      postWriteError(normalizedFilename, error)
    }
  }, WRITE_DEBOUNCE_MS)

  stagedWrites.set(normalizedFilename, {
    content: content ?? '',
    timer,
  })

  return { ok: true, queued: true }
}

self.onmessage = async (event) => {
  const { id, type, filename, content, scope } = event.data

  try {
    let result = null

    switch (type) {
      case 'write':
        result = await writeFile(filename, content ?? '', scope ?? 'workspace')
        break

      case 'schedule_write':
        result = scheduleWrite(filename, content ?? '')
        break

      case 'read':
        result = await readFile(filename, scope ?? 'workspace')
        break

      case 'write_binary':
        result = await writeBinaryFile(filename, content ?? new ArrayBuffer(0), scope ?? 'sqlite')
        break

      case 'read_binary':
        result = await readBinaryFile(filename, scope ?? 'sqlite')
        break

      case 'exists':
        result = await fileExists(filename, scope ?? 'workspace')
        break

      case 'list':
        result = await listFiles()
        break

      case 'flush':
        result = await flushStagedWrite(filename)
        break

      case 'flush_all':
        result = await flushAllStagedWrites()
        break

      default:
        throw new Error(`Unknown I/O worker message type: ${type}`)
    }

    self.postMessage({ id, result })
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) })
  }
}
