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

  const clean = name => path.basename(name)

  async function convertToMp3(input, output) {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      output
    ])
  }

  app.get('/dl/soundcloud', async (req, res) => {
    try {
      const input = req.query.url

      if (!input)
        return res.status(400).json({ status: false, error: 'URL requerida' })

      let parsed
      try {
        parsed = new URL(input)
      } catch {
        return res.status(400).json({ status: false, error: 'URL inválida' })
      }

      if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(parsed.hostname))
        return res.status(400).json({ status: false, error: 'URL no válida' })

      return res.status(403).json({
        status: false,
        error: 'La descarga y conversión debe utilizar una fuente oficialmente descargable o autorizada.'
      })
    } catch (e) {
      res.status(500).json({ status: false, error: e.message })
    }
  })

  app.get('/file/sc/:filename', (req, res) => {
    const filename = clean(req.params.filename)
    const file = path.join(FILES, filename)

    if (!fs.existsSync(file))
      return res.status(404).json({ status: false, error: 'Archivo no encontrado' })

    res.sendFile(file)
  })
}