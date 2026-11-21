import { coversSite, normalizeSite, SITE_LIMIT, tabSite } from "./engine.js"
import { configureRuleset, readRuleDomains, restoreRuleset, rulesetEnabled } from "./rulesets.js"

const RULESET = "protection"
const STORAGE_KEY = "linkProtectionEnabled"
const BLOCK_RULE = 102
const SHORTENERS = ["bit.ly", "cutt.ly", "is.gd", "rebrand.ly", "s.id", "t.co", "tinyurl.com"]
const LOGIN_WORDS = ["login", "signin", "verify", "verifikasi", "reset", "password", "otp"]

export async function readProtection() {
  const [enabled, blockedDomains] = await Promise.all([rulesetEnabled(RULESET), readRuleDomains(BLOCK_RULE)])
  return { enabled, blockedDomains }
}

export function restoreProtection() {
  return restoreRuleset(RULESET, STORAGE_KEY)
}

export function configureProtection(enabled) {
  return configureRuleset(RULESET, STORAGE_KEY, enabled)
}

export async function changeBlockedDomain(value, add) {
  const domain = normalizeSite(value)
  if (!domain || domain !== value || domain.startsWith("[")) return { ok: false, reason: "domain" }
  const existing = await readRuleDomains(BLOCK_RULE)
  if (add && coversSite(domain, existing)) return { ok: true }
  if (!add && !existing.includes(domain)) return { ok: true }
  if (add && existing.length >= SITE_LIMIT) return { ok: false, reason: "limit" }

  const domains = add ? [...existing, domain].sort() : existing.filter(host => host !== domain)
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [BLOCK_RULE],
    addRules: domains.length ? [{
      id: BLOCK_RULE,
      priority: 100,
      action: { type: "block" },
      condition: { requestDomains: domains, resourceTypes: ["main_frame"] }
    }] : []
  })
  return { ok: true }
}

export async function readPattern() {
  const response = await fetch(chrome.runtime.getURL("rules/protection.json"))
  if (!response.ok) throw new Error("Local protection rules unavailable")
  const rules = await response.json()
  const officialDomains = rules[0].condition.excludedRequestDomains
  const patterns = rules.map(({ condition }) => new RegExp(
    condition.regexFilter, condition.isUrlFilterCaseSensitive ? "" : "i"
  ))
  return { patterns, officialDomains }
}

export function inspectLink(input, pattern, protection) {
  const value = typeof input === "string" ? input.trim() : ""
  if (!/^https?:\/\//i.test(value) || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }

  const host = tabSite({ url: url.href })
  if (!host) return null
  const official = coversSite(host, pattern.officialDomains)
  const hasImpersonation = !official && pattern.patterns.some(regex => regex.test(url.href))
  const manualBlock = coversSite(host, protection.blockedDomains)
  const reasons = []
  if (manualBlock) reasons.push("Domain masuk daftar blokir kamu.")
  if (hasImpersonation) {
    reasons.push(protection.enabled
      ? "Host menyisipkan nama domain resmi milik pihak lain."
      : "Host menyisipkan nama domain resmi. Blokir pola sedang nonaktif.")
  }
  if (!official && !hasImpersonation) {
    const words = host.split(/[^a-z0-9]+/)
    if (LOGIN_WORDS.some(word => words.includes(word))
        && pattern.officialDomains.some(domain => words.includes(domain.split(".")[0]))) {
      reasons.push("Host menyebut merek dan istilah login atau verifikasi di luar domain resmi.")
    }
  }
  if (url.username || url.password) reasons.push("Ada kredensial sebelum @. Host tujuan berada setelah @.")
  if (host.split(".").some(label => label.startsWith("xn--"))) reasons.push("Host memakai karakter internasional (Punycode). Periksa ejaannya.")
  if (host.startsWith("[") || /^(\d+\.){3}\d+$/.test(host)) reasons.push("Tujuan memakai alamat IP langsung.")
  if (coversSite(host, SHORTENERS)) reasons.push("Link diperpendek. Tujuan akhirnya belum diketahui.")
  if (url.protocol === "http:") reasons.push("Koneksi menggunakan HTTP tanpa enkripsi.")
  return {
    host, reasons, manualBlock,
    blocked: manualBlock || (hasImpersonation && protection.enabled),
    blockable: !!normalizeSite(host) && !host.startsWith("[")
  }
}
