/*
### POST - Subir múltiples:
```bash
curl -X POST http://localhost:3000/api/files \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://example.com/file1.mp3",
      "https://example.com/file2.mp3",
      {
        "url": "https://example.com/file3.mp3",
        "filename": "custom.mp3"
      }
    ]
  }'
*/
const axios = require("axios")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

module.exports = function (app) {
  const cache = new Map()
  const CACHE_TTL = 1000 * 60 * 2

  // ENDPOINT GET - Subir archivo por URL con filename
  app.get("/api/files", async (req, res) => {
    try {
      const { url, filename } = req.query

      if (!url) {
        return res.status(400).json({
          status: false,
          error: "🍡 url es requerida"
        })
      }

      // Validar que sea URL válida
      try {
        new URL(url)
      } catch {
        return res.status(400).json({
          status: false,
          error: "url inválida"
        })
      }

      const dir = path.join(process.cwd(), "files")
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // Descargar archivo
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      })

      // Generar ID único
      const id = crypto.randomBytes(5).toString("hex")

      // Obtener extensión
      let ext = ".bin"
      if (filename) {
        const match = filename.match(/\.[^.]+$/)
        ext = match ? match[0] : ".bin"
      } else {
        const contentType = response.headers["content-type"]
        const extMap = {
          "audio/mpeg": ".mp3",
          "audio/wav": ".wav",
          "audio/ogg": ".ogg",
          "video/mp4": ".mp4",
          "video/webm": ".webm",
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/gif": ".gif",
          "application/pdf": ".pdf",
          "application/zip": ".zip"
        }
        ext = extMap[contentType] || ".bin"
      }

      const filenameSave = `${id}${ext}`
      const filePath = path.join(dir, filenameSave)

      // Guardar archivo
      fs.writeFileSync(filePath, response.data)

      const stats = fs.statSync(filePath)

      res.json({
        status: true,
        data: {
          url: url,
          id: id,
          filename: filenameSave,
          size: stats.size,
          created: new Date().toISOString(),
          dl: `${req.protocol}://${req.get("host")}/files/${id}`
        }
      })

    } catch (err) {
      console.error("Error GET /api/files:", err.message)
      res.status(500).json({
        status: false,
        error: err.message
      })
    }
  })

  // ENDPOINT POST - Subir múltiples URLs
  app.post("/api/files", async (req, res) => {
    try {
      const { urls } = req.body

      if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({
          status: false,
          error: "urls debe ser un array"
        })
      }

      if (urls.length === 0) {
        return res.status(400).json({
          status: false,
          error: "urls no puede estar vacío"
        })
      }

      if (urls.length > 20) {
        return res.status(400).json({
          status: false,
          error: "máximo 10 URLs por solicitud"
        })
      }

      const dir = path.join(process.cwd(), "files")
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const results = []
      const errors = []

      // Descargar en paralelo
      const downloads = urls.map(async (item) => {
        try {
          const urlToDownload = typeof item === "string" ? item : item.url
          const customFilename = typeof item === "object" ? item.filename : null

          // Validar URL
          try {
            new URL(urlToDownload)
          } catch {
            throw new Error("URL inválida")
          }

          const response = await axios.get(urlToDownload, {
            responseType: "arraybuffer",
            timeout: 60000,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          })

          const id = crypto.randomBytes(5).toString("hex")

          // Obtener extensión
          let ext = ".bin"
          if (customFilename) {
            const match = customFilename.match(/\.[^.]+$/)
            ext = match ? match[0] : ".bin"
          } else {
            const contentType = response.headers["content-type"]
            const extMap = {
              "audio/mpeg": ".mp3",
              "audio/wav": ".wav",
              "audio/ogg": ".ogg",
              "video/mp4": ".mp4",
              "video/webm": ".webm",
              "image/jpeg": ".jpg",
              "image/png": ".png",
              "image/gif": ".gif",
              "application/pdf": ".pdf",
              "application/zip": ".zip"
            }
            ext = extMap[contentType] || ".bin"
          }

          const filenameSave = `${id}${ext}`
          const filePath = path.join(dir, filenameSave)

          fs.writeFileSync(filePath, response.data)
          const stats = fs.statSync(filePath)

          results.push({
            url: urlToDownload,
            id: id,
            filename: filenameSave,
            size: stats.size,
            created: new Date().toISOString(),
            dl: `${req.protocol}://${req.get("host")}/files/${id}`
          })

        } catch (err) {
          errors.push({
            url: typeof item === "string" ? item : item.url,
            error: err.message
          })
        }
      })

      await Promise.all(downloads)

      res.json({
        status: true,
        summary: {
          total: urls.length,
          successful: results.length,
          failed: errors.length
        },
        data: results,
        errors: errors.length > 0 ? errors : null
      })

    } catch (err) {
      console.error("Error POST /api/files:", err.message)
      res.status(500).json({
        status: false,
        error: err.message
      })
    }
  })

  // ENDPOINT GET - Listar archivos
  app.get("/api/files/list", (req, res) => {
    try {
      const dir = path.join(process.cwd(), "files")

      if (!fs.existsSync(dir)) {
        return res.json({
          status: true,
          total: 0,
          files: []
        })
      }

      const files = fs.readdirSync(dir).map(file => {
        const filePath = path.join(dir, file)
        const stats = fs.statSync(filePath)
        const id = file.split(".")[0]

        return {
          filename: file,
          id: id,
          size: stats.size,
          created: stats.birthtime.toISOString(),
          dl: `${req.protocol}://${req.get("host")}/files/${id}`
        }
      })

      res.json({
        status: true,
        total: files.length,
        files: files
      })

    } catch (err) {
      res.status(500).json({
        status: false,
        error: err.message
      })
    }
  })

  // ENDPOINT DELETE - Eliminar archivo
  app.delete("/api/files/:id", (req, res) => {
    try {
      const dir = path.join(process.cwd(), "files")
      const file = fs.readdirSync(dir).find(f => f.startsWith(req.params.id))

      if (!file) {
        return res.status(404).json({
          status: false,
          error: "🍡 file not found"
        })
      }

      fs.unlinkSync(path.join(dir, file))

      res.json({
        status: true,
        message: "archivo eliminado",
        id: req.params.id,
        filename: file
      })

    } catch (err) {
      res.status(500).json({
        status: false,
        error: err.message
      })
    }
  })

  // ENDPOINT GET - Descargar archivo
  app.get("/files/:id", (req, res) => {
    try {
      const dir = path.join(process.cwd(), "files")
      const file = fs.readdirSync(dir).find(f => f.startsWith(req.params.id))

      if (!file) {
        return res.status(404).json({
          status: false,
          error: "🌷 file not found"
        })
      }

      res.sendFile(path.join(dir, file))

    } catch (err) {
      res.status(500).json({
        status: false,
        error: err.message
      })
    }
  })
}
