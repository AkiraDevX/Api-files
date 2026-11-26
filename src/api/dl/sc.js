module.exports = function (app) {
  const fs = require('fs')
  const path = require('path')
  const crypto = require('crypto')
  const { execFile } = require('child_process')
  const { promisify } = require('util')

  const execFileAsync = promisify(execFile)
  const FILES = path.join(__dirname, 'files')
  const TMP = path.join(FILES, 'tmp')

  fs.mkdirSync(FILES, { recursive: true })
  fs.mkdirSync(TMP, { recursive: true })

  const MAX_SIZE = 100 * 1024 * 1024

  async function downloadFile(url, dest) {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60000)
    })

    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)

    const type = response.headers.get('content-type') || ''

    if (!type.startsWith('audio/') && !type.includes('octet-stream'))
      throw new Error('Formato de entrada no compatible')

    const buffer = Buffer.from(await response.arrayBuffer())

    if (buffer.length > MAX_SIZE)
      throw new Error('Archivo demasiado grande')

    fs.writeFileSync(dest, buffer)
  }

  async function convert(input, output) {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      output
    ], { timeout: 180000 })
  }

  app.get('/convert/soundcloud', async (req, res) => {
    const id = crypto.randomBytes(12).toString('hex')
    const input = path.join(TMP, `${id}.input`)
    const output = path.join(FILES, `${id}.mp3`)

    try {
      const url = req.query.url

      if (!url)
        return res.status(400).json({
          status: false,
          error: 'URL requerida'
        })

      let parsed

      try {
        parsed = new URL(url)
      } catch {
        return res.status(400).json({
          status: false,
          error: 'URL inválida'
        })
      }

      if (parsed.protocol !== 'https:')
        return res.status(400).json({
          status: false,
          error: 'Solo HTTPS'
        })

      if (!['soundcloud.com', 'www.soundcloud.com'].includes(parsed.hostname))
        return res.status(403).json({
          status: false,
          error: 'Dominio no permitido'
        })

      return res.status(403).json({
        status: false,
        error: 'Utiliza una fuente de audio descargable y autorizada para convertir.'
      })
    } catch (e) {
      return res.status(500).json({
        status: false,
        error: e.message
      })
    } finally {
      try {
        if (fs.existsSync(input))
          fs.unlinkSync(input)
      } catch {}
    }
  })

  app.get('/file/sc/:filename', (req, res) => {
    const filename = path.basename(req.params.filename)
    const file = path.join(FILES, filename)

    if (!fs.existsSync(file))
      return res.status(404).json({
        status: false,
        error: 'Archivo no encontrado'
      })

    res.sendFile(file)
  })
}