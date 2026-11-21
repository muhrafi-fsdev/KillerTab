import {
  canSleep, coversSite, DEFAULTS, dueTime, isProtected, isRunning, MANUAL_BATCH,
  normalizeSettings, PAUSE_MINUTES, tabSite
} from "./engine.js"
import { readAdblock } from "./ads.js"

const el = id => document.getElementById(id)
const engine = document.querySelector(".engine")
const toggle = el("engine-switch")
const adToggle = el("adblock-switch")
const adStatus = el("adblock-status")
const liveMetrics = el("live-metrics")
const choices = el("delay-picks")
const dialog = el("detail")
const content = el("detail-content")
const extensionPermission = { permissions: ["management"] }
const percent = new Intl.NumberFormat("id-ID", { style: "percent" })
const decimal = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 })
const clock = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })

let settings = DEFAULTS
let records = {}
let batchAfter = 0
let tabs = []
let extensions = null
let previousCpu = null
let busy = false
let loaded = false
let snapshotVersion = 0
let updateTimer
let countdownTimer
let nextDue = Infinity
let metricsTimer
let metricsGeneration = 0
let adState
let adBusy = false
let adVersion = 0

function error(message = "") {
  el("error").textContent = message
  el("error").hidden = !message
}

function syncControls() {
  toggle.checked = settings.enabled
  choices.querySelector(`[value="${settings.delay}"]`).checked = true
  toggle.disabled = choices.disabled = busy || !loaded
  liveMetrics.checked = settings.liveMetrics
  liveMetrics.disabled = !loaded
  el("measure").hidden = !loaded || settings.liveMetrics
  const running = isRunning(settings)
  engine.dataset.enabled = running
  let status = "Nonaktif · tab tetap berjalan"
  if (running) status = "Aktif · tab latar akan tidur"
  else if (settings.enabled) status = `Dijeda sampai ${clock.format(settings.pauseUntil)}`
  el("engine-status").textContent = status
}

async function loadSnapshot() {
  const version = ++snapshotVersion
  try {
    const [local, session, openTabs] = await Promise.all([
      chrome.storage.local.get("settings"), chrome.storage.session.get(["idle", "batchAfter"]), chrome.tabs.query({})
    ])
    if (version !== snapshotVersion) return
    const nextSettings = normalizeSettings(local.settings)
    const monitorChanged = !loaded || settings.liveMetrics !== nextSettings.liveMetrics
    settings = nextSettings
    records = session.idle ?? {}
    batchAfter = session.batchAfter ?? 0
    tabs = openTabs
    loaded = true
    syncControls()
    renderQueue()
    if (monitorChanged) updateMonitoring()
    el("tab-total").textContent = `${tabs.length} tab terbuka`
    el("tab-sleeping").textContent = `${tabs.filter(tab => tab.discarded).length} sedang tidur`
  } catch {
    if (version === snapshotVersion) error("Status tab gagal dimuat. Buka ulang popup untuk mencoba lagi.")
  }
}

function renderQueue() {
  const queue = el("next-tab")
  const label = el("queue-label")
  nextDue = Infinity
  queue.hidden = !isRunning(settings) || !loaded
  if (queue.hidden) {
    paintCountdown()
    return
  }

  let nextTab
  for (const tab of tabs) {
    const record = records[tab.id]
    if (!record || record.lastAccessed !== (tab.lastAccessed ?? 0) || !canSleep(tab, settings.protectedSites)) continue
    const due = dueTime(record, settings)
    if (due >= nextDue) continue
    nextDue = due
    nextTab = tab
  }
  const empty = !nextTab
  if (empty) {
    label.textContent = "Belum ada tab dalam antrean"
    label.removeAttribute("title")
  } else {
    label.textContent = nextTab.title || "Tab tanpa judul"
    label.title = label.textContent
  }
  paintCountdown()
}

function paintCountdown() {
  clearTimeout(countdownTimer)
  const time = el("queue-time")
  time.hidden = !Number.isFinite(nextDue)
  if (time.hidden || document.hidden || dialog.open) return
  const remaining = Math.max(0, Math.ceil((Math.max(nextDue, batchAfter) - Date.now()) / 1000))
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0")
  const seconds = String(remaining % 60).padStart(2, "0")
  time.textContent = remaining ? `${minutes}:${seconds}` : "Siap"
  time.dateTime = `PT${remaining}S`
  if (remaining > 0) countdownTimer = setTimeout(paintCountdown, 1000)
}

async function configure(next) {
  if (busy || !loaded) return
  busy = true
  error()
  syncControls()
  try {
    const result = await chrome.runtime.sendMessage({ type: "configure", ...next })
    if (!result?.ok) throw new Error("Configuration rejected")
  } catch {
    error("Pengaturan gagal diproses. Coba lagi.")
  } finally {
    await loadSnapshot()
    busy = false
    syncControls()
  }
}

function metric(key, value, info) {
  const meter = el(`${key}-meter`)
  el(`${key}-value`).textContent = value === null ? "—" : percent.format(value)
  el(`${key}-info`).textContent = info
  el(`${key}-info`).title = info
  meter.hidden = value === null
  if (value !== null) meter.value = value * 100
}

function fraction(value) {
  return Math.max(0, Math.min(1, value))
}

function showMemory({ capacity, availableCapacity }) {
  if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(availableCapacity)) {
    metric("ram", null, "Data RAM tidak tersedia")
    return
  }
  const used = fraction(1 - availableCapacity / capacity)
  const asGiB = bytes => decimal.format(bytes / (1024 ** 3))
  metric("ram", used, `${asGiB(used * capacity)} / ${asGiB(capacity)} GiB`)
}

function showCpu({ processors, numOfProcessors, modelName }) {
  if (!Array.isArray(processors) || !processors.length) {
    previousCpu = null
    metric("cpu", null, "Data CPU tidak tersedia")
    return
  }
  const sample = processors.reduce((sums, { usage }) => ({
    total: sums.total + usage.total,
    idle: sums.idle + usage.idle
  }), { total: 0, idle: 0 })

  let value = null
  if (previousCpu && sample.total > previousCpu.total && sample.idle >= previousCpu.idle) {
    value = fraction(1 - (sample.idle - previousCpu.idle) / (sample.total - previousCpu.total))
  }
  previousCpu = sample
  const description = modelName || `${numOfProcessors} prosesor logis`
  metric("cpu", value, value === null ? "Mengukur beban…" : description)
}

async function sampleSystem(generation, phase = "regular") {
  const [cpu, memory] = await Promise.allSettled([
    Promise.resolve().then(() => chrome.system.cpu.getInfo()),
    phase === "cpu-only" ? null : Promise.resolve().then(() => chrome.system.memory.getInfo())
  ])
  if (generation !== metricsGeneration) return
  if (cpu.status === "fulfilled") showCpu(cpu.value)
  else {
    previousCpu = null
    metric("cpu", null, "Data CPU tidak tersedia")
  }
  if (memory.status === "rejected") metric("ram", null, "Data RAM tidak tersedia")
  else if (memory.value) showMemory(memory.value)

  const quickSample = phase === "first" && previousCpu && el("cpu-meter").hidden
  if (!quickSample && !settings.liveMetrics) return
  metricsTimer = setTimeout(
    () => sampleSystem(generation, quickSample ? "cpu-only" : "regular"),
    quickSample ? 650 : 5000
  )
}

function updateMonitoring(force = false) {
  const generation = ++metricsGeneration
  clearTimeout(metricsTimer)
  previousCpu = null
  if (loaded && !document.hidden && !dialog.open && (force || settings.liveMetrics)) {
    void sampleSystem(generation, "first")
  }
  paintCountdown()
}

async function configureMonitoring() {
  liveMetrics.disabled = true
  error()
  try {
    const result = await chrome.runtime.sendMessage({ type: "live-metrics", enabled: liveMetrics.checked })
    if (!result?.ok) throw new Error("Monitor configuration rejected")
    await loadSnapshot()
  } catch {
    error("Preferensi monitor belum tersimpan.")
  } finally {
    syncControls()
  }
}

function node(tag, text, className) {
  const element = document.createElement(tag)
  element.textContent = text
  if (className) element.className = className
  return element
}

function openDialog(title) {
  el("detail-title").textContent = title
  content.replaceChildren()
  dialog.showModal()
  updateMonitoring()
}

function button(text, action) {
  const control = node("button", text, "secondary")
  control.type = "button"
  control.addEventListener("click", action)
  return control
}

function feedbackLine() {
  const line = node("p", "", "dialog-feedback")
  line.setAttribute("role", "status")
  return line
}

async function loadAdblock() {
  const version = ++adVersion
  try {
    const state = await readAdblock()
    if (version !== adVersion) return adState
    adState = state
    adToggle.checked = adState.enabled
    adStatus.textContent = adState.enabled ? "Aktif · jaringan iklan pihak ketiga" : "Nonaktif"
  } catch {
    if (version !== adVersion) return adState
    adState = undefined
    adStatus.textContent = "Status pemblokir iklan tidak tersedia"
  }
  adToggle.disabled = adBusy || !adState
  return adState
}

async function toggleAdblock() {
  if (adBusy) return
  adBusy = adToggle.disabled = true
  error()
  try {
    const result = await chrome.runtime.sendMessage({ type: "adblock-enable", enabled: adToggle.checked })
    if (!result?.ok) throw new Error("Ad blocking configuration rejected")
  } catch {
    error("Pemblokir iklan belum bisa diubah. Coba lagi.")
  } finally {
    adBusy = false
    await loadAdblock()
  }
}

async function showAdblockSites() {
  openDialog("Pengecualian adblock")
  const feedback = feedbackLine()
  const section = node("div", "")
  content.append(
    node("p", "Tambahkan situs jika halaman atau pemutarnya terganggu. Muat ulang halaman setelah mengubah aturan."),
    section, feedback
  )
  let site = ""
  let waiting = false

  function paint() {
    if (!section.isConnected || !dialog.open) return
    if (!adState) {
      section.replaceChildren(node("p", "Daftar pengecualian tidak tersedia."))
      return
    }
    const rows = adState.sites.map(host => {
      const row = node("li", "", "item")
      const remove = button("Hapus", () => save("adblock-remove", host))
      remove.setAttribute("aria-label", `Hapus pengecualian untuk ${host}`)
      row.append(node("span", host, "item-name"), remove)
      return row
    })
    const list = document.createElement("ul")
    list.append(...rows)
    section.replaceChildren(rows.length ? list : node("p", "Belum ada situs yang dikecualikan."))
    if (site && !coversSite(site, adState.sites)) {
      section.append(button(`Izinkan iklan di ${site}`, () => save("adblock-exempt", site)))
    }
  }

  async function save(type, host) {
    if (waiting) return
    waiting = true
    feedback.textContent = "Menyimpan…"
    try {
      const result = await chrome.runtime.sendMessage({ type, site: host })
      if (!result?.ok) {
        feedback.textContent = result?.reason === "limit"
          ? "Daftar pengecualian sudah penuh."
          : "Pengecualian gagal disimpan."
        return
      }
      await loadAdblock()
      paint()
      feedback.textContent = "Tersimpan. Muat ulang halaman yang bersangkutan."
      feedback.tabIndex = -1
      if (feedback.isConnected && dialog.open) feedback.focus()
    } catch {
      feedback.textContent = "Pengecualian gagal disimpan."
    } finally {
      waiting = false
    }
  }

  await Promise.all([
    loadAdblock(),
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      const host = tabSite(tab)
      if (host && !host.startsWith("[")) site = host
    }).catch(() => {})
  ])
  paint()
}

function showSleepNow() {
  openDialog("Tidurkan sekarang")
  const feedback = feedbackLine()
  const go = button("Tidurkan tab latar", () => sleep("sleep-now"))
  const duplicates = button("Khusus tab duplikat", () => sleep("sleep-duplicates"))
  async function sleep(type) {
    go.disabled = duplicates.disabled = true
    feedback.textContent = "Memproses tab…"
    try {
      const result = await chrome.runtime.sendMessage({ type })
      if (!result?.ok) throw new Error("Sleep rejected")
      feedback.textContent = result.slept
        ? `${result.slept} tab ditidurkan.`
        : type === "sleep-duplicates"
          ? "Tidak ada tab duplikat yang bisa ditidurkan."
          : "Belum ada tab yang bisa ditidurkan."
      if (result.remaining) feedback.textContent += " Jalankan lagi untuk tab berikutnya."
      void loadSnapshot()
    } catch {
      feedback.textContent = "Tab belum bisa diproses. Coba lagi."
    } finally {
      go.disabled = duplicates.disabled = false
    }
  }
  content.append(
    node("p", `Tidurkan hingga ${MANUAL_BATCH} tab di jendela ini. Untuk duplikat, satu tab dengan URL yang sama tetap dimuat. Simpan draf sebelum melanjutkan.`),
    go, duplicates, feedback
  )
}

function showSaverSettings() {
  openDialog("Jeda & situs")
  const feedback = feedbackLine()
  const pauseTitle = node("h3", "Jeda tidur otomatis")
  const pauseText = node("p", "")
  const pause = button("", () => update({ type: pause.dataset.action }))
  let currentSite = ""
  const quickProtect = button("", () => update({ type: "protect-site", site: currentSite }))
  quickProtect.hidden = true
  const list = document.createElement("ul")
  const form = node("form", "", "site-form")
  const label = node("label", "Tambah domain atau URL")
  const input = document.createElement("input")
  input.id = "site-input"
  input.type = "text"
  input.maxLength = 2048
  input.placeholder = "contoh.com"
  input.required = true
  input.autocomplete = "off"
  input.spellcheck = false
  label.htmlFor = input.id
  const add = node("button", "Tambah", "secondary")
  add.type = "submit"
  form.append(label, input, add)
  form.addEventListener("submit", event => {
    event.preventDefault()
    void update({ type: "protect-site", site: input.value })
  })

  let waiting = false
  function refreshControls() {
    pause.disabled = !settings.enabled
    const paused = settings.enabled && !isRunning(settings)
    pause.dataset.action = paused ? "resume" : "pause"
    pause.textContent = paused ? "Lanjutkan sekarang" : `Jeda ${PAUSE_MINUTES} menit`
    pauseText.textContent = paused
      ? `Dijeda sampai ${clock.format(settings.pauseUntil)}.`
      : "Jeda menghentikan peniduran otomatis untuk sementara."
    if (!settings.enabled) pauseText.textContent = "Aktifkan Tidur otomatis untuk memakai jeda."
    if (currentSite) {
      quickProtect.hidden = false
      quickProtect.disabled = coversSite(currentSite, settings.protectedSites)
      quickProtect.textContent = quickProtect.disabled ? "Situs ini sudah dilindungi" : `Lindungi ${currentSite}`
    }

    const rows = settings.protectedSites.map(site => {
      const row = node("li", "", "item")
      const remove = button("Hapus", () => update({ type: "unprotect-site", site }))
      remove.setAttribute("aria-label", `Hapus perlindungan untuk ${site}`)
      row.append(node("span", site, "item-name"), remove)
      return row
    })
    list.replaceChildren(...rows)
  }

  async function update(message) {
    if (waiting) return
    waiting = true
    feedback.textContent = "Menyimpan…"
    try {
      const result = await chrome.runtime.sendMessage(message)
      if (!result?.ok) {
        feedback.textContent = {
          site: "Masukkan domain atau URL HTTP/HTTPS yang valid.",
          limit: "Daftar situs yang dilindungi sudah penuh."
        }[result?.reason] ?? "Pengaturan belum tersimpan. Coba lagi."
        return
      }
      await loadSnapshot()
      if (!form.isConnected || !dialog.open) return
      refreshControls()
      if (message.type === "protect-site" && message.site === input.value) input.value = ""
      if (message.type === "unprotect-site") input.focus()
      feedback.textContent = "Pengaturan tersimpan."
    } catch {
      feedback.textContent = "Pengaturan belum tersimpan. Coba lagi."
    } finally {
      waiting = false
    }
  }

  refreshControls()
  content.append(
    pauseTitle, pauseText, pause,
    node("h3", "Situs yang dilindungi"),
    node("p", "Tab dari domain dan subdomain ini dilewati saat ditidurkan otomatis atau manual."),
    quickProtect, form, list, feedback
  )
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    const site = tabSite(tab)
    if (!site || !form.isConnected || !dialog.open) return
    currentSite = site
    refreshControls()
  }).catch(() => {})
}

function item(label, status, action) {
  const row = node("li", "", "item")
  const name = node(action ? "button" : "span", label, action ? "item-name item-button" : "item-name")
  if (action) {
    name.type = "button"
    name.addEventListener("click", action)
  }
  row.append(name, node("span", status, "item-status"))
  return row
}

function tabStatus(tab) {
  if (tab.discarded) return "Tidur"
  if (tab.active) return "Aktif"
  if (tab.pinned) return "Disematkan"
  if (tab.audible) return "Memutar audio"
  if (isProtected(tab, settings.protectedSites)) return "Dilindungi"
  return canSleep(tab, settings.protectedSites) ? "Latar" : "Dilewati"
}

function showTabs() {
  openDialog("Tab terbuka")
  const list = document.createElement("ul")
  for (const tab of tabs) {
    list.append(item(tab.title || "Tab tanpa judul", tabStatus(tab), async () => {
      try {
        await chrome.tabs.update(tab.id, { active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
        window.close()
      } catch {
        if (dialog.open) content.prepend(node("p", "Tab ini sudah tidak tersedia."))
      }
    }))
  }
  content.append(tabs.length ? list : node("p", "Belum ada tab terbuka."))
}

async function readExtensions() {
  if (!await chrome.permissions.contains(extensionPermission)) {
    extensions = null
    el("extension-total").textContent = "Ekstensi"
    el("extension-active").textContent = "Lihat daftar"
    return
  }

  extensions = (await chrome.management.getAll()).filter(extension => extension.type === "extension")
  extensions.sort((a, b) => a.name.localeCompare(b.name, "id"))
  el("extension-total").textContent = `${extensions.length} ekstensi`
  el("extension-active").textContent = `${extensions.filter(extension => extension.enabled).length} aktif`
}

function showExtensionList() {
  const list = document.createElement("ul")
  for (const extension of extensions) list.append(item(extension.name, extension.enabled ? "Aktif" : "Nonaktif"))
  content.replaceChildren(extensions.length ? list : node("p", "Belum ada ekstensi."))
}

async function showExtensions() {
  openDialog("Ekstensi terpasang")
  const loading = node("p", "Memuat daftar ekstensi…")
  content.append(loading)
  try {
    await readExtensions()
  } catch {
    if (loading.isConnected) loading.textContent = "Daftar ekstensi tidak tersedia."
    return
  }
  if (!loading.isConnected || !dialog.open) return
  if (extensions) {
    showExtensionList()
    return
  }

  const request = node("button", "Izinkan akses daftar", "secondary")
  request.type = "button"
  const feedback = node("p", "")
  feedback.setAttribute("role", "status")
  request.addEventListener("click", async () => {
    request.disabled = true
    try {
      if (await chrome.permissions.request(extensionPermission)) {
        await readExtensions()
        if (request.isConnected && dialog.open && extensions) showExtensionList()
      } else {
        feedback.textContent = "Izin belum diberikan."
      }
    } catch {
      feedback.textContent = "Izin tidak bisa dimuat. Coba lagi."
    } finally {
      request.disabled = false
    }
  })
  content.replaceChildren(node("p", "Berikan izin agar KillerTab bisa membaca jumlah dan status ekstensi yang terpasang."), request, feedback)
}

function showHelp() {
  openDialog("Cara kerja")
  content.append(
    node("p", "Tab latar yang ditidurkan tetap ada di bilah tab. Saat dibuka kembali, Chromium memuat ulang halamannya. Simpan draf atau sematkan tab penting sebelum memakai mode Langsung."),
    node("p", "Tab aktif, tab sematan, tab yang terdengar memutar audio, dan halaman internal browser dilewati."),
    node("p", "Gunakan Tidurkan sekarang untuk mengosongkan tab latar segera. Di Jeda & situs, kamu bisa menjeda mesin dan melindungi situs penting."),
    node("p", "Adblock memfilter jaringan iklan pihak ketiga. Gunakan Pengecualian situs jika sebuah halaman perlu memuat jaringan tersebut."),
    node("p", "Angka RAM dan CPU berasal dari sistem. Matikan opsi Live untuk mengukur hanya saat dibutuhkan."),
    node("p", `Versi ${chrome.runtime.getManifest().version} · Akira Keiji`)
  )
}

function scheduleSnapshot() {
  if (document.hidden) return
  clearTimeout(updateTimer)
  updateTimer = setTimeout(loadSnapshot, 180)
}

toggle.addEventListener("change", () => configure({ ...settings, enabled: toggle.checked }))
choices.addEventListener("change", event => configure({ ...settings, delay: Number(event.target.value) }))
el("tabs-button").addEventListener("click", showTabs)
el("extensions-button").addEventListener("click", showExtensions)
el("sleep-now").addEventListener("click", showSleepNow)
el("saver-settings").addEventListener("click", showSaverSettings)
adToggle.addEventListener("change", toggleAdblock)
el("adblock-sites").addEventListener("click", showAdblockSites)
liveMetrics.addEventListener("change", configureMonitoring)
el("measure").addEventListener("click", () => updateMonitoring(true))
document.querySelector(".help").addEventListener("click", showHelp)
dialog.addEventListener("close", () => updateMonitoring())
document.addEventListener("visibilitychange", () => {
  clearTimeout(updateTimer)
  updateMonitoring()
  if (!document.hidden) void loadSnapshot()
})

chrome.storage.onChanged.addListener(changes => {
  if ("settings" in changes || "idle" in changes || "batchAfter" in changes) scheduleSnapshot()
  if ("adblockEnabled" in changes && !document.hidden) void loadAdblock()
})
chrome.tabs.onUpdated.addListener((id, change) => {
  if (["title", "status", "discarded", "pinned", "audible"].some(key => key in change)) scheduleSnapshot()
})
chrome.tabs.onActivated.addListener(scheduleSnapshot)
chrome.tabs.onCreated.addListener(scheduleSnapshot)
chrome.tabs.onRemoved.addListener(scheduleSnapshot)
chrome.tabs.onReplaced.addListener(scheduleSnapshot)
chrome.permissions.onRemoved.addListener(() => { void readExtensions().catch(() => {}) })
void loadSnapshot()
void readExtensions().catch(() => {})
void loadAdblock()
