const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { PassThrough } = require('stream')
const { pipeline } = require('stream/promises')

module.exports = function (app) {

  const FILES_DIR = path.join(__dirname, 'files')
  const MAX_SIZE = 800 * 1024 * 1024
  const DEFAULT_EXPIRE = 60
  const links = new Map()

  if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true })
  }

  const MIME_EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'application/zip': '.zip'
  }

  function getName(url, mime) {
    let name
    try {
      name = decodeURIComponent(path.basename(new URL(url).pathname))
    } catch {
      name = 'download'
    }
    if (!name || name === '/') name = 'download'
    name = name.replace(/[^\w.\-() ]/g, '_').slice(0, 150)
    if (!path.extname(name)) {
      name += MIME_EXT[mime] || '.bin'
    }
    return name
  }

  // 🔗 Link de descarga con ?token=
  function getPublicUrl(req, id) {
    return `${req.protocol}://${req.get('host')}/download/stream?token=${id}`
  }

  // ℹ️ Link de info con ?token=
  function getInfoUrl(req, id) {
    return `${req.protocol}://${req.get('host')}/download/info?token=${id}`
  }

  function removeLink(id) {
    const item = links.get(id)
    if (!item) return

    clearTimeout(item.timer)

    if (item.active) {
      for (const stream of item.active) {
        stream.destroy()
      }
    }

    if (item.cachePath && fs.existsSync(item.cachePath)) {
      try { fs.unlinkSync(item.cachePath) } catch {}
    }

    links.delete(id)
  }

  // 🗑️ Borra el archivo de caché por token (aunque el link ya no exista)
  function deleteCacheFile(id) {
    const cachePath = path.join(FILES_DIR, `${id}.cache`)
    if (fs.existsSync(cachePath)) {
      try {
        fs.unlinkSync(cachePath)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  function validateUrl(value) {
    const url = new URL(value)

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Protocolo no permitido')
    }
    if (url.username || url.password) {
      throw new Error('Credenciales no permitidas')
    }

    const host = url.hostname.toLowerCase()

    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === 'metadata.google.internal' ||
      host.endsWith('.local') ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error('Dirección privada no permitida')
    }

    return url
  }

  // ============================================================
  // 🎫 Crear enlace
  // ============================================================
  app.get('/file', (req, res) => {
    try {
      const {
        url,
        expire = DEFAULT_EXPIRE,
        cache = 'false',
        direct = 'false'
      } = req.query

      if (!url) {
        return res.status(400).json({
          status: false,
          message: 'Falta el parámetro ?url='
        })
      }

      validateUrl(url)

      const minutes = Number(expire)

      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
        return res.status(400).json({
          status: false,
          message: 'Expire debe estar entre 1 y 10080 minutos'
        })
      }

      const isDirect = direct === 'true'
      const isCache = !isDirect && cache === 'true'

      const id = crypto.randomBytes(16).toString('hex')
      const now = Date.now()
      const exp = now + minutes * 60000

      const item = {
        id,
        url,
        status: 'waiting',
        createdAt: now,
        expiresAt: exp,
        expireMinutes: minutes,
        cache: isCache,
        direct: isDirect,
        cachePath: null,
        filename: null,
        mime: null,
        size: null,
        active: new Set(),
        timer: null
      }

      item.timer = setTimeout(() => removeLink(id), minutes * 60000)
      links.set(id, item)

      const dl = getPublicUrl(req, id)

      res.json({
        status: true,
        data: {
          token: id,
          dl,
          info: getInfoUrl(req, id),
          mode: isDirect ? 'direct-redirect' : 'live-tunnel',
          status: 'waiting',
          cache: isCache,
          direct: isDirect,
          created_at: new Date(now).toISOString(),
          expire_at: new Date(exp).toISOString(),
          expire_minutes: minutes
        }
      })

    } catch (err) {
      res.status(400).json({
        status: false,
        message: err.message
      })
    }
  })

  // ============================================================
  // ℹ️ Info del enlace
  // ============================================================
  app.get('/download/info', (req, res) => {
    const item = links.get(req.query.token)

    if (!item || Date.now() > item.expiresAt) {
      return res.status(404).json({
        status: false,
        message: '🧋 Link inexistente o expirado'
      })
    }

    res.json({
      status: true,
      data: {
        token: item.id,
        status: item.status,
        filename: item.filename,
        mime: item.mime,
        size: item.size,
        size_mb: item.size ? (item.size / 1048576).toFixed(2) : null,
        mode: item.direct ? 'direct-redirect' : 'live-tunnel',
        cache: item.cache,
        direct: item.direct,
        expire_at: new Date(item.expiresAt).toISOString()
      }
    })
  })

  // ============================================================
  // 📥 Stream / Redirect
  // ============================================================
  app.get('/download/stream', async (req, res) => {
    const id = req.query.token

    if (!id) {
      return res.status(400).json({
        status: false,
        message: 'Falta el parámetro ?token='
      })
    }

    const item = links.get(id)

    if (!item || Date.now() > item.expiresAt) {
      return res.status(410).json({
        status: false,
        message: '🍂 Link expirado o inexistente'
      })
    }

    // 🎯 Modo direct: redirige a la URL original
    if (item.direct) {
      item.status = 'redirect'
      return res.redirect(302, item.url)
    }

    // ⬇️ Modo normal: streaming / cache desde caché
    if (item.cachePath && fs.existsSync(item.cachePath)) {
      const stat = fs.statSync(item.cachePath)

      res.setHeader('Content-Type', item.mime || 'application/octet-stream')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.filename || 'download')}`
      )

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
      const headers = {
        'user-agent': 'Mozilla/5.0',
        accept: '*/*'
      }

      if (req.headers.range) {
        headers.range = req.headers.range
      }

      const controller = new AbortController()

      const response = await axios.get(item.url, {
        responseType: 'stream',
        headers,
        timeout: 120000,
        signal: controller.signal,
        maxRedirects: 5,
        maxContentLength: MAX_SIZE,
        validateStatus: status => status === 200 || status === 206
      })

      source = response.data

      const mime = (response.headers['content-type'] || 'application/octet-stream')
        .split(';')[0].trim().toLowerCase()

      const length = Number(response.headers['content-length'] || 0)

      if (length > MAX_SIZE) {
        source.destroy()
        throw new Error('Archivo supera el límite de 800 MB')
      }

      item.mime = mime
      item.filename = getName(item.url, mime)
      item.size = length || null
      item.status = 'streaming'

      res.setHeader('Content-Type', mime)
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.filename)}`
      )
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Accept-Ranges', 'bytes')

      if (response.status === 206) {
        res.status(206)
        if (response.headers['content-range']) {
          res.setHeader('Content-Range', response.headers['content-range'])
        }
      }

      if (length) {
        res.setHeader('Content-Length', length)
      }

      if (item.cache && response.status === 200 && !req.headers.range) {
        const cachePath = path.join(FILES_DIR, `${item.id}.cache`)
        const output = fs.createWriteStream(cachePath)
        const tee = new PassThrough()
        let total = 0

        const cachePromise = pipeline(
          tee,
          new PassThrough({
            transform(chunk, encoding, callback) {
              total += chunk.length
              if (total > MAX_SIZE) {
                return callback(new Error('Límite de almacenamiento excedido'))
              }
              callback(null, chunk)
            }
          }),
          output
        )

        source.on('data', chunk => {
          if (!res.destroyed) {
            tee.write(chunk)
          }
        })

        source.on('end', () => tee.end())
        source.on('error', err => tee.destroy(err))

        source.pipe(res, { end: false })

        const finish = async () => {
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
            if (fs.existsSync(cachePath)) {
              try { fs.unlinkSync(cachePath) } catch {}
            }
          }
        }

        res.on('close', () => {
          if (!source.destroyed) source.destroy()
        })

        source.on('end', finish)
        return
      }

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
        res.status(502).json({
          status: false,
          message: 'No se pudo iniciar el streaming',
          error: err.message
        })
      } else if (!res.destroyed) {
        res.destroy(err)
      }
    }
  })

  // ============================================================
  // 🗑️ Eliminar link + archivo de caché por token
  // ============================================================
  app.delete('/download/stream', (req, res) => {
    const id = req.query.token || (req.body && req.body.token)

    if (!id) {
      return res.status(400).json({
        status: false,
        message: 'Falta el parámetro ?token='
      })
    }

    const item = links.get(id)

    if (item) {
      removeLink(id)
      return res.json({
        status: true,
        message: 'Link y archivo eliminados correctamente',
        data: { token: id }
      })
    }

    const deleted = deleteCacheFile(id)

    if (deleted) {
      return res.json({
        status: true,
        message: 'Archivo de caché eliminado correctamente',
        data: { token: id }
      })
    }

    return res.status(404).json({
      status: false,
      message: 'Link o archivo no encontrado',
      data: { token: id }
    })
  })

  // ============================================================
  // 🔁 Retro-compatibilidad con /f/:id (opcional)
  // ============================================================
  app.get('/f/:id', (req, res) => {
    res.redirect(301, `/download/stream?token=${req.params.id}`)
  })

  app.get('/f/:id/info', (req, res) => {
    res.redirect(301, `/download/info?token=${req.params.id}`)
  })

  app.delete('/f/:id', (req, res) => {
    res.redirect(307, `/download/stream?token=${req.params.id}`)
  })

}