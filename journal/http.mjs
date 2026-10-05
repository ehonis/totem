// journal/http.mjs — the authenticated `/api/journal*` adapter.
//
// Mounted in bridge.mjs beside the todo and goal handlers, behind the same bearer
// check. Every route is a thin parse into a service call; every domain error comes
// back as `{ error: { code, message } }` with the status the service chose.
//
// The one route that is not JSON is the upload. A recording is posted as its own
// bytes (`Content-Type: audio/mp4`, `audio/webm`, …) with the facts about it in the
// query string, rather than as multipart or base64 JSON: the phone already has a
// Blob, `fetch(blob)` streams it, and there is nothing to decode on either side.
import { JournalError } from './service.mjs'

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' }
const AUDIO_TYPES = /^(audio\/|video\/(mp4|webm)|application\/octet-stream)/i

function send(res, status, body) {
  res.writeHead(status, JSON_TYPE)
  res.end(JSON.stringify(body))
}

const bad = (code, message, status = 400) => new JournalError(code, message, status)

async function readRaw(req, maxBytes, tooLarge) {
  const advertised = Number(req.headers['content-length'])
  if (Number.isFinite(advertised) && advertised > maxBytes) throw tooLarge(advertised)
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) throw tooLarge(bytes)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, maxBytes) {
  const raw = await readRaw(req, maxBytes, () => bad('BODY_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413))
  if (!raw.length) return {}
  try { return JSON.parse(raw.toString('utf8')) }
  catch { throw bad('INVALID_JSON', 'Request body must be valid JSON.') }
}

export function createJournalHttpHandler({ service, maxAudioBytes = 100 * 1024 * 1024, maxJsonBytes = 1_000_000 } = {}) {
  if (!service) throw new TypeError('createJournalHttpHandler requires service')

  return async function journalHttpHandler(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path !== '/api/journal' && !path.startsWith('/api/journal/')) return false

    try {
      if (req.method === 'GET' && path === '/api/journal') {
        const [entries, status] = await Promise.all([service.list(), service.status()])
        send(res, 200, { entries, ...status })
        return true
      }
      if (req.method === 'GET' && path === '/api/journal/status') {
        send(res, 200, await service.status())
        return true
      }
      if (req.method === 'GET' && path === '/api/journal/settings') {
        send(res, 200, { settings: await service.getSettings() })
        return true
      }
      if (req.method === 'PATCH' && path === '/api/journal/settings') {
        send(res, 200, { settings: await service.setSettings(await readJson(req, maxJsonBytes)) })
        return true
      }

      if (req.method === 'POST' && path === '/api/journal/entries') {
        const type = String(req.headers['content-type'] || '')
        if (AUDIO_TYPES.test(type)) {
          const buffer = await readRaw(req, maxAudioBytes, (n) => bad('AUDIO_TOO_LARGE', `That recording is ${Math.round(n / 1e6)} MB; the limit is ${Math.round(maxAudioBytes / 1e6)} MB.`, 413))
          const entry = await service.createFromAudio({
            buffer,
            mime: url.searchParams.get('mime') || type,
            recordedAt: url.searchParams.get('recordedAt') || undefined,
            durationSec: url.searchParams.get('duration') || undefined,
          })
          send(res, 201, { ok: true, entry: await service.get(entry.id) })
          return true
        }
        const body = await readJson(req, maxJsonBytes)
        const entry = await service.createFromText({ text: body.text, recordedAt: body.recordedAt })
        send(res, 201, { ok: true, entry: await service.get(entry.id) })
        return true
      }

      // The recording itself, for playback and "save a copy". Served with its own
      // content type and a filename, and never cached: it can be deleted out from
      // under a stale tab at any moment.
      const audio = /^\/api\/journal\/entries\/([A-Za-z0-9_-]{1,64})\/audio$/.exec(path)
      if (audio && (req.method === 'GET' || req.method === 'DELETE')) {
        const id = audio[1]
        if (req.method === 'DELETE') {
          await service.deleteAudio(id)
          send(res, 200, { ok: true, entry: await service.get(id) })
          return true
        }
        const { buffer, mime, filename } = await service.readAudio(id)
        res.writeHead(200, {
          'content-type': mime,
          'content-length': buffer.length,
          'cache-control': 'no-store',
          'content-disposition': `inline; filename="${filename.replace(/["\\]/g, '')}"`,
        })
        res.end(buffer)
        return true
      }

      const one = /^\/api\/journal\/entries\/([A-Za-z0-9_-]{1,64})(?:\/(skip|ingest|retry|keep-audio|unkeep-audio))?$/.exec(path)
      if (one) {
        const [, id, action] = one
        if (!action) {
          if (req.method === 'GET') { send(res, 200, { entry: await service.get(id) }); return true }
          if (req.method === 'PATCH') {
            const body = await readJson(req, maxJsonBytes)
            await service.update(id, body)
            send(res, 200, { ok: true, entry: await service.get(id) })
            return true
          }
          if (req.method === 'DELETE') { send(res, 200, await service.remove(id)); return true }
        } else if (req.method === 'POST') {
          if (action === 'skip') await service.skipIngest(id)
          else if (action === 'ingest') await service.ingestNow(id)
          else if (action === 'retry') await service.retryTranscription(id)
          else if (action === 'keep-audio') await service.setAudioPinned(id, true)
          else if (action === 'unkeep-audio') await service.setAudioPinned(id, false)
          send(res, 200, { ok: true, entry: await service.get(id) })
          return true
        }
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `No journal route for ${req.method} ${path}.` } })
      return true
    } catch (error) {
      if (error instanceof JournalError) {
        send(res, error.status || 400, { error: { code: error.code, message: error.message } })
        return true
      }
      send(res, 500, { error: { code: 'JOURNAL_ERROR', message: error?.message || String(error) } })
      return true
    }
  }
}
