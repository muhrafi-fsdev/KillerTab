export async function rulesetEnabled(id) {
  return (await chrome.declarativeNetRequest.getEnabledRulesets()).includes(id)
}

async function setRuleset(id, enabled) {
  const options = enabled ? { enableRulesetIds: [id] } : { disableRulesetIds: [id] }
  await chrome.declarativeNetRequest.updateEnabledRulesets(options)
}

export async function restoreRuleset(id, storageKey) {
  const stored = await chrome.storage.local.get(storageKey)
  const enabled = stored[storageKey]
  if (typeof enabled === "boolean" && enabled !== await rulesetEnabled(id)) {
    await setRuleset(id, enabled)
  }
}

export async function configureRuleset(id, storageKey, enabled) {
  if (typeof enabled !== "boolean") return { ok: false }
  const previous = await rulesetEnabled(id)
  if (previous !== enabled) await setRuleset(id, enabled)
  try {
    await chrome.storage.local.set({ [storageKey]: enabled })
  } catch (error) {
    if (previous !== enabled) await setRuleset(id, previous)
    throw error
  }
  return { ok: true }
}

export async function readRuleDomains(id) {
  const rules = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: [id] })
  return rules.find(rule => rule.id === id)?.condition.requestDomains ?? []
}
