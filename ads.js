import { coversSite, normalizeSite, SITE_LIMIT } from "./engine.js"

import { configureRuleset, readRuleDomains, restoreRuleset, rulesetEnabled } from "./rulesets.js"

const RULESET = "ads"
const STORAGE_KEY = "adblockEnabled"
const EXCEPTION_RULE = 101

export async function readAdblock() {
  const [enabled, sites] = await Promise.all([rulesetEnabled(RULESET), readRuleDomains(EXCEPTION_RULE)])
  return { enabled, sites }
}

export function restoreAdblock() {
  return restoreRuleset(RULESET, STORAGE_KEY)
}

export function configureAdblock(enabled) {
  return configureRuleset(RULESET, STORAGE_KEY, enabled)
}

export async function changeAdblockSite(value, add) {
  const site = normalizeSite(value)
  if (!site || site !== value || site.startsWith("[")) return { ok: false, reason: "site" }
  const existing = await readRuleDomains(EXCEPTION_RULE)
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
