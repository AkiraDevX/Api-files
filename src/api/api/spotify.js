const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

module.exports = function (app) {

  const FILES_DIR = path.join(__dirname, 'files')
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true })

  async function uploadFromUrl(fileUrl, expireMinutes = 60) {
    const res = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 60000 })

    const contentType = res.headers['content-type'] || ''
    const extMap = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
      'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a', 'application/pdf': '.pdf'
    }
    const ext = extMap[contentType.split(';')[0].trim()]
      || path.extname(fileUrl.split('?')[0]) || '.bin'

    const token  = crypto.randomBytes(16).toString('hex')
    const sig    = crypto.randomBytes(24).toString('base64url')
    const sec    = crypto.randomBytes(24).toString('base64url')
    const iv     = crypto.randomBytes(12).toString('base64url')
    const exp    = Date.now() + expireMinutes * 60 * 1000

    const filename = `${token}${ext}`
    const filePath = path.join(FILES_DIR, filename)
    const buffer   = Buffer.from(res.data)

    fs.writeFileSync(filePath, buffer)

    // Auto-eliminar al expirar
    setTimeout(() => {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }, expireMinutes * 60 * 1000)

    const sizeMb = (buffer.length / 1024 / 1024).toFixed(2)

    return { token, sig, sec, iv, exp, filename, ext, sizeMb }
  }

  // ─── Servir archivo ───────────────────────────────────────
  app.get('/files/d/:token', (req, res) => {
    const { token } = req.params
    const { exp } = req.query

    // Verificar expiración si viene el param
    if (exp && Date.now() > parseInt(exp)) {
      return res.status(410).json({ status: false, message: 'Link expirado' })
    }

    const file = fs.readdirSync(FILES_DIR).find(f => f.startsWith(token))
    if (!file) {
      return res.status(404).json({ status: false, message: 'Archivo no encontrado o expirado' })
    }

    const filePath = path.join(FILES_DIR, file)
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`)
    res.sendFile(filePath)
  })

  // ─── Upload desde URL ─────────────────────────────────────
  app.get('/upload/files', async (req, res) => {
    try {
      const { url, expire = 60 } = req.query
      if (!url) return res.json({ status: false, message: 'Falta parametro ?url=' })

      const result = await uploadFromUrl(url, parseInt(expire))
  
      const dlUrl = `${req.protocol}://${req.get('host')}/files/d/${result.token}?exp=${result.exp}&sig=${result.sig}&sec=${result.sec}&iv=${result.iv}`

      res.json({
        status: true,
        data: {
          dl: dlUrl,
          size_mb: parseFloat(result.sizeMb) + " MB",
          token: result.token,
          expire_at: new Date(result.exp).toISOString(),
          expire_minutes: parseInt(expire)
        }
      })

    } catch (err) {
      res.json({ status: false, message: err.message })
    }
  })

}