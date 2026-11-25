import {
  canSleep, DELAYS, dueTime, duplicateCandidates, idleRecord, isRunning, MANUAL_BATCH,
  normalizeSettings, normalizeSite, PAUSE_MINUTES, sameLoadedPage, SITE_LIMIT
} from "./engine.js"
import { changeAdblockSite, configureAdblock, restoreAdblock } from "./ads.js"
import { changeBlockedDomain, configureProtection, restoreProtection } from "./protection.js"
import { cleanup } from "./cleanup.js"

const ALARM = "next-tab-sleep"
const AUTO_BATCH = 4
const BATCH_INTERVAL = 30_000
const RETRY_INTERVAL = 120_000
const ELIGIBLE = { active: false, discarded: false, pinned: false, audible: false, status: "complete" }
const WATCHED = ["status", "url", "pinned", "audible", "discarded", "autoDiscardable", "splitViewId"]
const activeTabs = new Map()

let queue = Promise.resolve()
let pending
let settings
let idle
let batchAfter = 0
let dirty = false
let alarmTime

function run(task) {
  const operation = queue.then(task)
  queue = operation.catch(error => console.warn("KillerTab:", error))
  return operation
}

async function loadSettings() {
  if (settings) return
  const stored = await chrome.storage.local.get("settings")
  settings = normalizeSettings(stored.settings)
}

async function loadSession() {
  if (idle) return
  const stored = await chrome.storage.session.get(["idle", "batchAfter"])
  idle = stored.idle ?? {}
  batchAfter = stored.batchAfter ?? 0
}

async function saveSettings(next) {
  await chrome.storage.local.set({ settings: next })
  settings = next
}

async function saveSession() {
  if (!dirty) return
  await chrome.storage.session.set({ idle, batchAfter })
  dirty = false
}

async function schedule(when) {
  if (alarmTime === undefined) alarmTime = (await chrome.alarms.get(ALARM))?.scheduledTime ?? null
  if (alarmTime === when) return
  if (when === null) await chrome.alarms.clear(ALARM)
  else await chrome.alarms.create(ALARM, { when })
  alarmTime = when
}

function setIdle(id, record) {
  if (idle[id] === record) return
  if (record) idle[id] = record
  else delete idle[id]
  dirty = true
}

function setBatchAfter(time) {
  if (batchAfter === time) return
  batchAfter = time
  dirty = true
}

function changes(full = false) {
  return { full, alarm: false, activations: [], tabs: new Map(), resets: new Set() }
}

function enqueue({ full = false, alarm = false, activation, tabId, tab, reset = false } = {}) {
  if (!full && !alarm && settings && !isRunning(settings)) return
  if (!pending) {
    pending = changes()
    run(async () => {
      const work = pending
      pending = undefined
      await reconcile(work)
    })
  }
  pending.full ||= full
  pending.alarm ||= alarm
  if (activation) pending.activations.push(activation)
  if (tabId !== undefined) {
    pending.tabs.set(tabId, tab)
    if (reset) pending.resets.add(tabId)
  }
}

async function getTab(id) {
  try {
    return await chrome.tabs.get(id)
  } catch {
    return null
  }
}

async function discard(id) {
  try {
    return (await chrome.tabs.discard(id))?.discarded === true
  } catch {
    return false
  }
}

function track(tab, id, reset, now) {
  const record = canSleep(tab, settings.protectedSites)
    ? idleRecord(tab, reset ? undefined : idle[id], now)
    : undefined
  setIdle(id, record)
}

async function syncTabs(work) {
  const windows = new Set()
  for (const { tabId, windowId } of work.activations) {
    const previous = activeTabs.get(windowId)
    if (previous === undefined) windows.add(windowId)
    else if (previous !== tabId) work.tabs.set(previous, undefined)
    activeTabs.set(windowId, tabId)
    work.tabs.set(tabId, null)
  }

  // Tab update events already supply the tab, so most updates need no query.
  for (const [id, tab] of work.tabs) {
    track(tab === undefined ? await getTab(id) : tab, id, work.resets.has(id), Date.now())
  }

  if (!work.full && !windows.size) return
  const tabs = work.full
    ? await chrome.tabs.query(ELIGIBLE)
    : (await Promise.all([...windows].map(windowId => chrome.tabs.query({ ...ELIGIBLE, windowId })))).flat()
  const visible = new Set(tabs.map(tab => tab.id))
  for (const [id, record] of Object.entries(idle)) {
    if ((work.full || windows.has(record.windowId)) && !visible.has(Number(id))) setIdle(id, undefined)
  }
  const now = Date.now()
  for (const tab of tabs) track(tab, tab.id, work.resets.has(tab.id), now)
}

async function sleepDueTabs() {
  const now = Date.now()
  if (batchAfter > now) return
  const due = Object.entries(idle)
    .filter(([, record]) => dueTime(record, settings) <= now)
    .sort((a, b) => dueTime(a[1], settings) - dueTime(b[1], settings))

  for (const [id] of due.slice(0, AUTO_BATCH)) {
    const tabId = Number(id)
    const current = await getTab(tabId)
    track(current, tabId, false, Date.now())
    if (!idle[id] || pending?.resets.has(tabId) || dueTime(idle[id], settings) > Date.now()) continue
    if (await discard(tabId)) setIdle(id, undefined)
    else setIdle(id, { ...idle[id], retryAt: Date.now() + RETRY_INTERVAL })
  }
  if (due.length >= AUTO_BATCH) setBatchAfter(Date.now() + BATCH_INTERVAL)
}

async function scheduleNext() {
  let earliest = Infinity
  for (const record of Object.values(idle)) earliest = Math.min(earliest, dueTime(record, settings))
  const ready = Math.max(earliest, batchAfter)
  await schedule(Number.isFinite(ready) ? Math.max(ready, Date.now() + 1000) : null)
}

async function reconcile(work = changes(true)) {
  await loadSettings()
  if (work.alarm) alarmTime = undefined
  if (!isRunning(settings) && !work.full && !work.alarm) return

  await loadSession()
  if (!isRunning(settings)) {
    activeTabs.clear()
    if (Object.keys(idle).length) {
      idle = {}
      dirty = true
    }
    setBatchAfter(0)
    await saveSession()
    await schedule(settings.enabled ? settings.pauseUntil : null)
    return
  }

  if (settings.pauseUntil) {
    await saveSettings({ ...settings, pauseUntil: 0 })
    work.full = true
  }

  await syncTabs(work)
  await sleepDueTabs()
  await saveSession()
  await scheduleNext()
}

async function sleepNow(duplicatesOnly) {
  await loadSession()
  const filter = duplicatesOnly ? { discarded: false, status: "complete" } : ELIGIBLE
  const tabs = await chrome.tabs.query({ ...filter, lastFocusedWindow: true })
  const candidates = duplicatesOnly
    ? duplicateCandidates(tabs, settings.protectedSites)
    : tabs.filter(tab => canSleep(tab, settings.protectedSites)).map(tab => ({ tab }))
  candidates.sort((a, b) => (a.tab.lastAccessed ?? 0) - (b.tab.lastAccessed ?? 0))
  let slept = 0
  for (const { tab: candidate, keeperId } of candidates.slice(0, MANUAL_BATCH)) {
    if (keeperId !== undefined && !sameLoadedPage(candidate, await getTab(keeperId))) continue
    const tab = await getTab(candidate.id)
    if (!canSleep(tab, settings.protectedSites) || !sameLoadedPage(candidate, tab)
        || tab.lastAccessed !== candidate.lastAccessed || pending?.resets.has(tab.id)) continue
    if (await discard(tab.id)) {
      slept++
      setIdle(tab.id, undefined)
    }
  }
  await saveSession()
  if (isRunning(settings)) await scheduleNext()
  return { ok: true, slept, remaining: Math.max(0, candidates.length - MANUAL_BATCH) }
}

async function changeSite(type, value) {
  const site = normalizeSite(value)
  if (!site) return { ok: false, reason: "site" }
  const add = type === "protect-site"
  const exists = settings.protectedSites.includes(site)
  if (add === exists) return { ok: true }
  if (add && settings.protectedSites.length >= SITE_LIMIT) return { ok: false, reason: "limit" }
  const protectedSites = add
    ? [...settings.protectedSites, site]
    : settings.protectedSites.filter(item => item !== site)
  await saveSettings({ ...settings, protectedSites })
  if (isRunning(settings)) await reconcile()
  return { ok: true }
}

async function command(message) {
  if (message.type === "adblock-enable") return configureAdblock(message.enabled)
  if (message.type === "adblock-exempt" || message.type === "adblock-remove") {
    return changeAdblockSite(message.site, message.type === "adblock-exempt")
  }
  if (message.type === "link-protection") return configureProtection(message.enabled)
  if (message.type === "link-block" || message.type === "link-unblock") {
    return changeBlockedDomain(message.domain, message.type === "link-block")
  }
  await loadSettings()
  switch (message.type) {
    case "cleanup":
      return cleanup(message, settings.protectedSites, id => pending?.resets.has(id))
    case "sleep-now":
    case "sleep-duplicates":
      return sleepNow(message.type === "sleep-duplicates")
    case "live-metrics":
      if (typeof message.enabled !== "boolean") return { ok: false }
      if (message.enabled !== settings.liveMetrics) {
        await saveSettings({ ...settings, liveMetrics: message.enabled })
      }
      return { ok: true }
    case "protect-site":
    case "unprotect-site":
      return changeSite(message.type, message.site)
    case "configure":
      if (typeof message.enabled !== "boolean" || !DELAYS.includes(message.delay)) return { ok: false }
      await saveSettings({
        ...settings, enabled: message.enabled, delay: message.delay,
        pauseUntil: message.enabled ? settings.pauseUntil : 0
      })
      break
    case "pause":
      if (!settings.enabled) return { ok: false }
      await saveSettings({ ...settings, pauseUntil: Date.now() + PAUSE_MINUTES * 60_000 })
      break
    case "resume":
      await saveSettings({ ...settings, pauseUntil: 0 })
      break
    default:
      return { ok: false }
  }
  await reconcile()
  return { ok: true }
}

function start() {
  run(restoreAdblock)
  run(restoreProtection)
  enqueue({ full: true })
}

chrome.runtime.onInstalled.addListener(start)
chrome.runtime.onStartup.addListener(start)
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) enqueue({ alarm: true })
})
chrome.tabs.onActivated.addListener(activation => enqueue({
  activation, tabId: activation.tabId, tab: null, reset: true
}))
chrome.tabs.onCreated.addListener(tab => enqueue({ tabId: tab.id, tab }))
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing || activeTabs.get(info.windowId) === tabId) activeTabs.delete(info.windowId)
  enqueue({ tabId, tab: null, reset: true })
})
chrome.tabs.onAttached.addListener((tabId, info) => {
  activeTabs.delete(info.newWindowId)
  enqueue({ tabId, reset: true })
})
chrome.tabs.onDetached.addListener((tabId, info) => {
  activeTabs.delete(info.oldWindowId)
  enqueue({ tabId, tab: null, reset: true })
})
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  for (const [windowId, tabId] of activeTabs) {
    if (tabId === removedId) activeTabs.set(windowId, addedId)
  }
  enqueue({ tabId: removedId, tab: null, reset: true })
  enqueue({ tabId: addedId, reset: true })
})
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  const reset = change.status === "loading" || "url" in change || change.audible === true
    || change.pinned === true || change.autoDiscardable === false
  if (WATCHED.some(key => key in change)) enqueue({ tabId: id, tab, reset })
})

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return
  if (typeof message?.type !== "string") return
  run(() => command(message)).then(respond, () => respond({ ok: false }))
  return true
})
