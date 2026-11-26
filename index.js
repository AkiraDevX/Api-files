const express = require('express')
const chalk = require('chalk')
const fs = require('fs')
const cors = require('cors')
const path = require('path')
const os = require('os')

const app = express()
const PORT = process.env.PORT || 3000

const uploadDir = path.join(process.cwd(), "files")
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

// ── Limpieza automática de /files ──
function clearFilesDir() {
  try {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
      return
    }
    const items = fs.readdirSync(uploadDir)
    let deleted = 0
    for (const item of items) {
      const itemPath = path.join(uploadDir, item)
      try {
        fs.rmSync(itemPath, { recursive: true, force: true })
        deleted++
      } catch (err) {
        console.error(chalk.red(`⚠️  Error eliminando ${itemPath}: ${err.message}`))
      }
    }
    console.log(chalk.yellow(`🧹 /files limpiado (${deleted} elemento(s) eliminado(s)) - ${new Date().toISOString()}`))
  } catch (err) {
    console.error(chalk.red(`❌ Error al limpiar /files: ${err.message}`))
  }
}

// Limpiar al arrancar (opcional) y luego cada 2 minutos
clearFilesDir()
setInterval(clearFilesDir, 2 * 60 * 1000) // 2 minutos

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

function formatBytes(bytes) {
  return {
    bytes,
    kb: (bytes / 1024).toFixed(2),
    mb: (bytes / 1024 / 1024).toFixed(2),
    gb: (bytes / 1024 / 1024 / 1024).toFixed(2)
  }
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
  const startTime = process.hrtime.bigint()
  const uptimeSeconds = Math.floor((Date.now() - apiStartTime) / 1000)

  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const cpus = os.cpus()
  const loadAvg = os.loadavg()

  // Calcular uso de CPU (aproximado)
  let totalIdle = 0, totalTick = 0
  cpus.forEach(cpu => {
    for (const type in cpu.times) totalTick += cpu.times[type]
    totalIdle += cpu.times.idle
  })
  const cpuUsage = (100 - (100 * totalIdle / totalTick)).toFixed(2)

  const pingNs = process.hrtime.bigint() - startTime
  const pingMs = Number(pingNs) / 1e6

  const processRam = formatBytes(mem.rss)
  const heapUsed = formatBytes(mem.heapUsed)
  const heapTotal = formatBytes(mem.heapTotal)

  res.json({
    creator: settings.apiSettings?.creator || "xd",
    version: settings.version || "1.0.0",
    uptime: formatUptime(uptimeSeconds),
    uptime_seconds: uptimeSeconds,
    routes_loaded: totalRoutes,
    date: new Date().toISOString(),
    ping: `${pingMs.toFixed(2)}ms`,

    memory: {
      process: {
        rss: `${processRam.mb} MB`,
        heapUsed: `${heapUsed.mb} MB`,
        heapTotal: `${heapTotal.mb} MB`,
        external: `${formatBytes(mem.external).mb} MB`,
        arrayBuffers: `${formatBytes(mem.arrayBuffers || 0).mb} MB`
      },
      system: {
        total: `${formatBytes(totalMem).gb} GB`,
        used: `${formatBytes(usedMem).gb} GB`,
        free: `${formatBytes(freeMem).gb} GB`,
        usage_percent: `${((usedMem / totalMem) * 100).toFixed(2)}%`
      }
    },

    cpu: {
      model: cpus[0]?.model || 'unknown',
      cores: cpus.length,
      speed_mhz: cpus[0]?.speed || 0,
      usage_percent: `${cpuUsage}%`,
      load_average: {
        '1m': loadAvg[0].toFixed(2),
        '5m': loadAvg[1].toFixed(2),
        '15m': loadAvg[2].toFixed(2)
      }
    },

    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      type: os.type(),
      node_version: process.version,
      pid: process.pid,
      cwd: process.cwd(),
      files_dir: uploadDir
    }
  })
})

app.listen(PORT, () => {
  console.log(chalk.green(`✅ Server running on port ${PORT}`))
  console.log(chalk.cyan(`🧹 Auto-limpieza de /files activa (cada 2 minutos)`))
})

module.exports = app