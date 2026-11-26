export const DELAYS = [0, 5, 15, 30]
export const SITE_LIMIT = 100
export const MANUAL_BATCH = 8
export const PAUSE_MINUTES = 30
export const DEFAULTS = { enabled: false, delay: 5, pauseUntil: 0, protectedSites: [], liveMetrics: true }

function hostname(url) {
  return url.hostname.toLowerCase().replace(/\.$/, "")
}

export function normalizeSite(value) {
  if (typeof value !== "string" || value.length > 2048) return ""
  const input = value.trim()
  if (!input || /\s/.test(input)) return ""
  const isURL = /^https?:\/\//i.test(input)
  if (!isURL && /[/@?#\\]/.test(input)) return ""

  try {
    const url = new URL(isURL ? input : `https://${input}`)
    if (url.username || url.password) return ""
    const host = hostname(url)
    if (host === "localhost" || host.startsWith("[")) return host
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
    return host.length <= 253 && host.includes(".") && host.split(".").every(part => label.test(part)) ? host : ""
  } catch {
    return ""
  }
}

export function normalizeSettings(value) {
  const enabled = value?.enabled === true
  const sites = Array.isArray(value?.protectedSites) ? value.protectedSites.slice(0, SITE_LIMIT) : []
  return {
    enabled,
    delay: DELAYS.includes(value?.delay) ? value.delay : DEFAULTS.delay,
    pauseUntil: enabled && Number.isSafeInteger(value?.pauseUntil) && value.pauseUntil > 0 ? value.pauseUntil : 0,
    protectedSites: [...new Set(sites.map(normalizeSite).filter(Boolean))],
    liveMetrics: value?.liveMetrics !== false
  }
}

export function isRunning(settings, now = Date.now()) {
  return settings.enabled && settings.pauseUntil <= now
}

export function tabSite(tab) {
  if (!/^https?:\/\//i.test(tab?.url ?? "")) return ""
  try {
    return hostname(new URL(tab.url))
  } catch {
    return ""
  }
}

export function coversSite(host, sites) {
  return !!host && sites.some(site => host === site || host.endsWith(`.${site}`))
}

export function isProtected(tab, sites) {
  return sites.length > 0 && coversSite(tabSite(tab), sites)
}

function isEligibleBackgroundTab(tab, sites) {
  return Number.isInteger(tab?.id)
    && tab.id >= 0
    && /^https?:\/\//i.test(tab.url ?? "")
    && !tab.active
    && !tab.pinned
    && !tab.audible
    && !tab.incognito
    && tab.autoDiscardable !== false
    && !tab.pendingUrl
    && !(tab.splitViewId >= 0)
    && !isProtected(tab, sites)
}

export function canSleep(tab, sites = []) {
  return isEligibleBackgroundTab(tab, sites) && !tab.discarded && tab.status === "complete"
}

export function isSleeping(tab) {
  return tab?.discarded === true || tab?.frozen === true
}

export function canCloseSleepingTab(tab, sites = []) {
  return isSleeping(tab) && isEligibleBackgroundTab(tab, sites) && !tab.highlighted && tab.status !== "loading"
}

function isLoadedWebTab(tab) {
  return !!tab && Number.isInteger(tab.id) && !tab.incognito && !tab.discarded
    && tab.status === "complete" && !tab.pendingUrl && /^https?:\/\//i.test(tab.url ?? "")
}

export function duplicateCandidates(tabs, sites) {
  const groups = new Map()
  for (const tab of tabs) {
    if (!isLoadedWebTab(tab)) continue
    const key = `${tab.windowId}\n${tab.url}`
    const eligible = canSleep(tab, sites)
    const priority = tab.active ? 0 : eligible ? 2 : 1
    const lastActive = tab.lastAccessed ?? 0
    let group = groups.get(key)
    if (!group) {
      group = { keeper: tab, priority, lastActive, eligible: [] }
      groups.set(key, group)
    }
    if (priority < group.priority || (priority === group.priority && lastActive > group.lastActive)) {
      Object.assign(group, { keeper: tab, priority, lastActive })
    }
    if (eligible) group.eligible.push(tab)
  }

  const candidates = []
  for (const { keeper, eligible } of groups.values()) {
    for (const tab of eligible) {
      if (tab.id !== keeper.id) candidates.push({ tab, keeperId: keeper.id })
    }
  }
  return candidates
}

export function sameLoadedPage(tab, current) {
  return isLoadedWebTab(current) && current.windowId === tab.windowId && current.url === tab.url
}

export function dueTime(record, settings) {
  const delay = settings.delay === 0 ? 30_000 : settings.delay * 60_000
  return Math.max(record.since + delay, record.retryAt ?? 0)
}

export function idleRecord(tab, previous, now) {
  const lastAccessed = tab.lastAccessed ?? 0
  if (previous?.lastAccessed === lastAccessed && previous.windowId === tab.windowId && previous.since <= now) {
    return previous
  }
  return { since: now, lastAccessed, windowId: tab.windowId }
}
