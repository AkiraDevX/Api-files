const express = require('express')
const chalk = require('chalk')
const fs = require('fs')
const cors = require('cors')
const path = require('path')
const os = require('os')

const app = express()
const PORT = process.env.PORT || 3000

const uploadDir = path.join(process.cwd(), "files")
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)

app.use("/files", express.static(uploadDir))
app.enable("trust proxy")
app.set("json spaces", 2)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cors())

app.use('/', express.static(path.join(__dirname, 'public')))
app.use('/src', express.static(path.join(__dirname, 'src')))

// ── settings.json ──
const settingsPath = path.join(__dirname, './src/settings.json')
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))

const apiStartTime = Date.now()

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400); seconds %= 86400
  const h = Math.floor(seconds / 3600); seconds %= 3600
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${d}D, ${h}H, ${m}M, ${s}S`
}

// ── inyectar creator en todas las respuestas json ──
app.use((req, res, next) => {
  const originalJson = res.json
  res.json = function (data) {
    if (data && typeof data === 'object') {
      return originalJson.call(this, {
        status: data.status,
        creator: settings.apiSettings?.creator || "xd",
        ...data
      })
    }
    return originalJson.call(this, data)
  }
  next()
})

// ── cargar rutas dinámicas ──
let totalRoutes = 0
const apiFolder = path.join(__dirname, './src/api')

if (fs.existsSync(apiFolder)) {
  fs.readdirSync(apiFolder).forEach(folder => {
    const folderPath = path.join(apiFolder, folder)
    if (fs.statSync(folderPath).isDirectory()) {
      fs.readdirSync(folderPath).forEach(file => {
        if (path.extname(file) === '.js') {
          require(path.join(folderPath, file))(app)
          totalRoutes++
        }
      })
    }
  })
}

// ── status endpoint ──
app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - apiStartTime) / 1000)

  res.json({
    creator: settings.apiSettings?.creator || "xd",
    version: settings.version || "1.0.0",
    uptime: formatUptime(uptimeSeconds),
    routes_loaded: totalRoutes,
    date: new Date().toISOString(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch()
    }
  })
})

app.listen(PORT, () => {
  console.log(chalk.green(`✅ Server running on port ${PORT}`))
})

module.exports = app