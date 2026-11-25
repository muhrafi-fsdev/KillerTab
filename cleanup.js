import { canCloseSleepingTab } from "./engine.js"

export const CACHE_PERMISSION = { permissions: ["browsingData"] }

async function clearWebCache() {
  try {
    if (!await chrome.permissions.contains(CACHE_PERMISSION)) return "permission"
    await chrome.browsingData.removeCache({ since: 0, originTypes: { unprotectedWeb: true } })
    return "cleared"
  } catch {
    return "failed"
  }
}

export async function cleanup({ closeTabs, clearCache }, sites, tabChanged = () => false) {
  if (typeof closeTabs !== "boolean" || typeof clearCache !== "boolean" || (!closeTabs && !clearCache)) {
    return { ok: false }
  }
  const cache = clearCache ? clearWebCache() : "skipped"

  let closed = 0
  let failed = 0
  let skipped = 0
  let tabsFailed = false
  if (closeTabs) {
    try {
      const tabs = await chrome.tabs.query({ active: false })
      for (const tab of tabs) {
        if (!canCloseSleepingTab(tab, sites)) continue

        const current = await chrome.tabs.get(tab.id).catch(() => null)
        if (!canCloseSleepingTab(current, sites) || current.lastAccessed !== tab.lastAccessed
            || current.windowId !== tab.windowId || current.url !== tab.url || tabChanged(tab.id)) {
          skipped++
          continue
        }

        try {
          await chrome.tabs.remove(tab.id)
          closed++
        } catch {
          failed++
        }
      }
    } catch {
      tabsFailed = true
    }
  }
  return { ok: true, closed, failed, skipped, tabsFailed, cache: await cache }
}
