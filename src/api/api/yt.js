const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { PassThrough } = require('stream')
const { pipeline } = require('stream/promises')

module.exports = function (app) {
  const FILES_DIR = path.join(__dirname, 'files')
  const MAX_SIZE = 800 * 1024 * 1024
  const SECRET = process.env.FILE_SECRET || 'shadow_dlapi_v4_secure_2024_xK9mP2nQ8vR'
  const API_VERSION = 4

  const links = new Map()

  if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true })
  }

  // ─── Categorías y expiración por formato ───
  const CATEGORIES = {
    tracks: ['mp3', 'm4a', 'ogg', 'wav', 'opus', 'flac', 'aac'],
    videos: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'flv', '3gp'],
    images: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif'],
    files:  ['apk', 'zip', 'rar', '7z', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'epub', 'iso']
  }

  const EXPIRE_MIN = {
    mp3: 30, m4a: 30, ogg: 30, wav: 30, opus: 30, flac: 30, aac: 30,
    mp4: 60, webm: 60, mkv: 60, mov: 60, avi: 60, flv: 60, '3gp': 60,
    jpg: 15, jpeg: 15, png: 15, webp: 15, gif: 15, bmp: 15, svg: 15, avif: 15,
    apk: 30, zip: 30, rar: 30, '7z': 30, pdf: 30, doc: 30, docx: 30, xls: 30, xlsx: 30, txt: 30, epub: 30, iso: 30,
    _default: 60
  }

  const EXT_MIME = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
    opus: 'audio/opus', flac: 'audio/flac', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    mov: 'video/quicktime', avi: 'video/x-msvideo', flv: 'video/x-flv', '3gp': 'video/3gpp',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
    apk: 'application/vnd.android.package-archive', zip: 'application/zip',
    rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
    pdf: 'application/pdf',
    _default: 'application/octet-stream'
  }

  const MIME_EXT = {
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/aac': 'aac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
    'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/vnd.android.package-archive': 'apk',
    'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z'
  }

  function formatToCategory(format) {
    for (const [cat, list] of Object.entries(CATEGORIES)) {
      if (list.includes(format)) return cat
    }
    return 'files'
  }

  function detectFormatFromUrl(url) {
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase().replace('.', '')
      if (ext && Object.keys(EXPIRE_MIN).includes(ext)) return ext
    } catch {}
    return null
  }

  function detectFormatFromMime(mime) {
    if (!mime) return null
    const clean = mime.split(';')[0].trim().toLowerCase()
    return MIME_EXT[clean] || null
  }

  function getExpireMinutes(format, customExpire) {
    if (customExpire) return customExpire
    return EXPIRE_MIN[format] || EXPIRE_MIN._default
  }

  // ─── Firma HMAC ───
  function sign(id, expires, format) {
    return crypto.createHmac('sha256', SECRET)
      .update(`${id}:${expires}:${format}`)
      .digest('hex')
  }

  function verifySignature(id, expires, format, signature) {
    if (!signature || !expires) return false
    if (Math.floor(Date.now() / 1000) > Number(expires)) return false
    const expected = sign(id, expires, format)
    if (expected.length !== signature.length) return false
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch { return false }
  }

  // ─── Constructor del link bonito ───
  function makePublicLink(req, item) {
    const proto = req.protocol
    const host = req.get('host')
    const category = formatToCategory(item.format)
    const nameB64 = Buffer.from(item.filename || `file.${item.format}`).toString('base64url')
    const sig = sign(item.id, item.expiresAtUnix, item.format)

    return `${proto}://${host}/download/${category}/${item.id}?api=${API_VERSION}&expires=${item.expiresAtUnix}&format=${item.format}&name=${nameB64}&signature=${sig}`
  }

  // ─── Nombre del archivo ───
  function getName(url, format) {
    let name
    try {
      name = decodeURIComponent(path.basename(new URL(url).pathname))
    } catch {
      name = 'download'
    }
    if (!name || name === '/') name = 'download'
    name = name.replace(/[^\w.\-() ]/g, '_').slice(0, 150)
    if (!path.extname(name) && format) name += '.' + format
    return name
  }

  function removeLink(id) {
    const item = links.get(id)
    if (!item) return
    clearTimeout(item.timer)
    if (item.active) {
      for (const stream of item.active) stream.destroy()
    }
    if (item.cachePath && fs.existsSync(item.cachePath)) {
      try { fs.unlinkSync(item.cachePath) } catch {}
    }
    links.delete(id)
  }

  function validateUrl(value) {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocolo no permitido')
    if (url.username || url.password) throw new Error('Credenciales no permitidas')
    const host = url.hostname.toLowerCase()
    if (
      host === 'localhost' || host.endsWith('.localhost') ||
      host === 'metadata.google.internal' || host.endsWith('.local') ||
      host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) throw new Error('Dirección privada no permitida')
    return url
  }

  // ═══════════════════════════════════════════════════
  //  CREAR LINK
  // ═══════════════════════════════════════════════════
  app.get('/file/yt', async (req, res) => {
    try {
      const { url, expire, cache = 'false', format: forcedFormat } = req.query

      if (!url) {
        return res.status(400).json({ status: false, message: 'Falta el parámetro ?url=' })
      }

      validateUrl(url)

      // Detectar formato (url → HEAD → fallback)
      let format = forcedFormat || detectFormatFromUrl(url)
      let filename = getName(url, format)

      if (!format) {
        try {
          const head = await axios.head(url, {
            headers: { 'user-agent': 'Mozilla/5.0' },
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: () => true
          })
          const mime = head.headers['content-type'] || ''
          format = detectFormatFromMime(mime) || 'bin'
          filename = getName(url, format)
        } catch {
          format = 'bin'
        }
      }

      // Expiración según formato (o custom)
      const minutes = getExpireMinutes(format, expire ? Number(expire) : null)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
        return res.status(400).json({ status: false, message: 'Expire debe estar entre 1 y 10080 minutos' })
      }

      const id = crypto.randomBytes(16).toString('hex')
      const deleteToken = crypto.randomBytes(16).toString('hex')
      const now = Date.now()
      const exp = now + minutes * 60000
      const expiresAtUnix = Math.floor(exp / 1000)

      const item = {
        id,
        deleteToken,
        url,
        format,
        filename,
        status: 'waiting',
        createdAt: now,
        expiresAt: exp,
        expiresAtUnix,
        expireMinutes: minutes,
        cache: cache === 'true',
        cachePath: null,
        mime: EXT_MIME[format] || EXT_MIME._default,
        size: null,
        active: new Set(),
        timer: null
      }

      item.timer = setTimeout(() => removeLink(id), minutes * 60000)
      links.set(id, item)

      const publicLink = makePublicLink(req, item)

      res.json({
        status: true,
        data: {
          id,
          url: publicLink,
          dl: publicLink,
          info: `${req.protocol}://${req.get('host')}/f/${id}/info`,
          delete: `${req.protocol}://${req.get('host')}/delete/${id}?token=${deleteToken}`,
          deleteToken,
          format,
          category: formatToCategory(format),
          filename,
          mode: 'live-tunnel',
          status: 'waiting',
          cache: item.cache,
          created_at: new Date(now).toISOString(),
          expire_at: new Date(exp).toISOString(),
          expire_minutes: minutes
        }
      })

    } catch (err) {
      res.status(400).json({ status: false, message: err.message })
    }
  })

  // ═══════════════════════════════════════════════════
  //  INFO
  // ═══════════════════════════════════════════════════
  app.get('/f/:id/info', (req, res) => {
    const item = links.get(req.params.id)
    if (!item || Date.now() > item.expiresAt) {
      return res.status(404).json({ status: false, message: '🧋 Link inexistente o expirado' })
    }
    res.json({
      status: true,
      data: {
        id: item.id,
        status: item.status,
        format: item.format,
        category: formatToCategory(item.format),
        filename: item.filename,
        mime: item.mime,
        size: item.size,
        size_mb: item.size ? (item.size / 1048576).toFixed(2) : null,
        mode: 'live-tunnel',
        cache: item.cache,
        expire_at: new Date(item.expiresAt).toISOString()
      }
    })
  })

  // ═══════════════════════════════════════════════════
  //  STREAM INTERNO (compartido entre /f y /download)
  // ═══════════════════════════════════════════════════
  async function streamItem(req, res, item) {
    // Cache hit
    if (item.cachePath && fs.existsSync(item.cachePath)) {
      const stat = fs.statSync(item.cachePath)
      res.setHeader('Content-Type', item.mime || 'application/octet-stream')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.filename || 'download')}`)

      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
        if (!match) return res.status(416).end()
        let start = match[1] ? Number(match[1]) : 0
        let end = match[2] ? Number(match[2]) : stat.size - 1
        if (!match[1] && match[2]) {
          start = Math.max(0, stat.size - Number(match[2]))
          end = stat.size - 1
        }
        if (start > end || start >= stat.size || end >= stat.size) {
          res.setHeader('Content-Range', `bytes */${stat.size}`)
          return res.status(416).end()
        }
        res.status(206)
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
        res.setHeader('Content-Length', end - start + 1)
        return fs.createReadStream(item.cachePath, { start, end }).pipe(res)
      }
      return fs.createReadStream(item.cachePath).pipe(res)
    }

    let source
    try {
      const headers = { 'user-agent': 'Mozilla/5.0', accept: '*/*' }
      if (req.headers.range) headers.range = req.headers.range

      const controller = new AbortController()
      const response = await axios.get(item.url, {
        responseType: 'stream',
        headers,
        timeout: 120000,
        signal: controller.signal,
        maxRedirects: 5,
        maxContentLength: MAX_SIZE,
        validateStatus: s => s === 200 || s === 206
      })

      source = response.data
      const mime = (response.headers['content-type'] || 'application/octet-stream')
        .split(';')[0].trim().toLowerCase()
      const length = Number(response.headers['content-length'] || 0)

      if (length > MAX_SIZE) {
        source.destroy()
        throw new Error('Archivo supera el límite de 800 MB')
      }

      item.mime = item.mime || mime
      item.size = length || item.size || null
      item.status = 'streaming'

      res.setHeader('Content-Type', item.mime)
      res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.filename)}`)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Accept-Ranges', 'bytes')

      if (response.status === 206) {
        res.status(206)
        if (response.headers['content-range']) {
          res.setHeader('Content-Range', response.headers['content-range'])
        }
      }
      if (length) res.setHeader('Content-Length', length)

      // Cache on-the-fly
      if (item.cache && response.status === 200 && !req.headers.range) {
        const cachePath = path.join(FILES_DIR, `${item.id}.cache`)
        const output = fs.createWriteStream(cachePath)
        const tee = new PassThrough()
        let total = 0

        const cachePromise = pipeline(
          tee,
          new PassThrough({
            transform(chunk, enc, cb) {
              total += chunk.length
              if (total > MAX_SIZE) return cb(new Error('Límite excedido'))
              cb(null, chunk)
            }
          }),
          output
        )

        source.on('data', chunk => { if (!res.destroyed) tee.write(chunk) })
        source.on('end', () => tee.end())
        source.on('error', err => tee.destroy(err))
        source.pipe(res, { end: false })

        source.on('end', async () => {
          try {
            await cachePromise
            if (Date.now() < item.expiresAt && links.has(item.id)) {
              item.cachePath = cachePath
              item.status = 'ready'
              item.size = total
            } else if (fs.existsSync(cachePath)) {
              fs.unlinkSync(cachePath)
            }
          } catch {
            if (fs.existsSync(cachePath)) { try { fs.unlinkSync(cachePath) } catch {} }
          }
        })

        res.on('close', () => { if (!source.destroyed) source.destroy() })
        return
      }

      // Stream directo
      const pass = new PassThrough()
      item.active.add(pass)

      res.on('close', () => {
        item.active.delete(pass)
        if (!pass.destroyed) pass.destroy()
        if (!source.destroyed) source.destroy()
      })
      source.on('end', () => {
        item.active.delete(pass)
        if (item.status === 'streaming') item.status = 'waiting'
      })

      await pipeline(source, pass, res)

    } catch (err) {
      if (source && !source.destroyed) source.destroy()
      item.status = 'error'
      if (!res.headersSent) {
        res.status(502).json({ status: false, message: 'No se pudo iniciar el streaming', error: err.message })
      } else if (!res.destroyed) {
        res.destroy(err)
      }
    }
  }

  // ═══════════════════════════════════════════════════
  //  DESCARGAS: /f/:id (compat) y /download/:category/:id (firmado)
  // ═══════════════════════════════════════════════════
  app.get('/f/:id', async (req, res) => {
    const item = links.get(req.params.id)
    if (!item || Date.now() > item.expiresAt) {
      return res.status(410).json({ status: false, message: '🍂 Link expirado o inexistente' })
    }
    return streamItem(req, res, item)
  })

  app.get('/download/:category/:id', async (req, res) => {
    const item = links.get(req.params.id)
    if (!item || Date.now() > item.expiresAt) {
      return res.status(410).json({ status: false, message: '🍂 Link expirado o inexistente' })
    }

    const { expires, format, signature } = req.query
    if (!verifySignature(item.id, expires, format, signature)) {
      return res.status(403).json({ status: false, message: '🔒 Firma inválida o expirada' })
    }
    if (req.params.category !== formatToCategory(item.format)) {
      return res.status(400).json({ status: false, message: 'Categoría no coincide con el formato' })
    }
    return streamItem(req, res, item)
  })

  // ═══════════════════════════════════════════════════
  //  ELIMINAR
  // ═══════════════════════════════════════════════════
  function handleDelete(req, res) {
    const { id } = req.params
    const { token } = req.query
    const item = links.get(id)

    if (!item) {
      return res.status(404).json({ status: false, message: 'Link no encontrado o ya eliminado' })
    }
    if (item.deleteToken && token !== item.deleteToken) {
      return res.status(403).json({ status: false, message: 'Token de eliminación inválido' })
    }
    removeLink(id)
    res.json({ status: true, message: '🗑️ Eliminado correctamente', id })
  }

  app.delete('/delete/:id', handleDelete)
  app.get('/delete/:id', handleDelete)
  app.delete('/f/:id', handleDelete) // compatibilidad
}