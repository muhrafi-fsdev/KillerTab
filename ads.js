import { coversSite, normalizeSite, SITE_LIMIT } from "./engine.js"

const RULESET = "ads"
const EXCEPTION_RULE = 101

async function rulesetEnabled() {
  return (await chrome.declarativeNetRequest.getEnabledRulesets()).includes(RULESET)
}

async function setRuleset(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] }
  )
}

async function exceptionDomains() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: [EXCEPTION_RULE] })
  return rules.find(rule => rule.id === EXCEPTION_RULE)?.condition.requestDomains ?? []
}

export async function readAdblock() {
  const [enabled, sites] = await Promise.all([rulesetEnabled(), exceptionDomains()])
  return { enabled, sites }
}

export async function restoreAdblock() {
  const { adblockEnabled } = await chrome.storage.local.get("adblockEnabled")
  if (typeof adblockEnabled === "boolean" && adblockEnabled !== await rulesetEnabled()) {
    await setRuleset(adblockEnabled)
  }
}

export async function configureAdblock(enabled) {
  if (typeof enabled !== "boolean") return { ok: false }
  const previous = await rulesetEnabled()
  if (previous !== enabled) await setRuleset(enabled)
  try {
    await chrome.storage.local.set({ adblockEnabled: enabled })
  } catch (error) {
    if (previous !== enabled) await setRuleset(previous)
    throw error
  }
  return { ok: true }
}

export async function changeAdblockSite(value, add) {
  const site = normalizeSite(value)
  if (!site || site !== value || site.startsWith("[")) return { ok: false, reason: "site" }
  const existing = await exceptionDomains()
  if (add && coversSite(site, existing)) return { ok: true }
  if (!add && !existing.includes(site)) return { ok: true }
  if (add && existing.length >= SITE_LIMIT) return { ok: false, reason: "limit" }

  const sites = add ? [...existing, site].sort() : existing.filter(host => host !== site)
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [EXCEPTION_RULE],
    addRules: sites.length ? [{
      id: EXCEPTION_RULE,
      priority: 10,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: sites, resourceTypes: ["main_frame"] }
    }] : []
  })
  return { ok: true }
}
