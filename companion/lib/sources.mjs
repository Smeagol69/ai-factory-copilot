/**
 * Outside-reference configuration.
 *
 * The copilot answers from the live save first. When a question genuinely needs
 * outside knowledge — a recipe the save has not unlocked, a mod's documented
 * behavior, a community technique — it searches, and it searches the sources
 * that are actually authoritative for Satisfactory rather than the open web.
 *
 * External results are reference material only. Nothing here can override the
 * snapshot or a solver result; that rule is enforced in the system prompt.
 */

/**
 * Official documentation and the established community references, most
 * authoritative first. Bare hosts, no scheme or path — both providers match on
 * host and include subdomains.
 */
export const OFFICIAL_SOURCE_DOMAINS = [
  // Coffee Stain and the official modding documentation
  "satisfactorygame.com",
  "questions.satisfactorygame.com",
  "docs.ficsit.app",
  "ficsit.app",
  // The primary community wiki (satisfactory.wiki.gg is the maintained one)
  "satisfactory.wiki.gg",
  "satisfactory.fandom.com",
  // Planning and reference tools the community treats as canonical
  "satisfactory-calculator.com",
  "satisfactorytools.com",
  // Forums and discussion
  "steamcommunity.com",
];

/**
 * Domains a provider's crawler cannot fetch.
 *
 * Anthropic rejects the whole request with a 400 when `allowed_domains` names a
 * site that blocks its user agent, so these are filtered out before the request
 * rather than discovered at answer time. reddit.com blocks it.
 */
export const PROVIDER_INACCESSIBLE_DOMAINS = {
  anthropic: ["reddit.com", "www.reddit.com", "old.reddit.com"],
};

/** Strips domains a provider is known to reject. */
export function accessibleDomains(domains, provider) {
  const blocked = PROVIDER_INACCESSIBLE_DOMAINS[provider] ?? [];
  if (blocked.length === 0) return domains;
  const lowered = new Set(blocked.map((entry) => entry.toLowerCase()));
  return domains.filter((domain) => !lowered.has(String(domain).toLowerCase()));
}

/**
 * Pulls the offending hosts out of a provider's "not accessible to our user
 * agent" error, so an unknown one can be dropped and the request retried.
 */
export function parseInaccessibleDomains(message) {
  const match = /not accessible to our user agent:\s*\[([^\]]*)\]/i.exec(String(message ?? ""));
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

/**
 * Web search tool versions. `web_search_20260209` adds dynamic filtering and
 * requires a recent model; older models need the basic variant. The bridge
 * deliberately does not infer the model, so this is configurable.
 */
const ANTHROPIC_WEB_SEARCH_TOOL_DEFAULT = "web_search_20260209";
const ANTHROPIC_WEB_SEARCH_TOOL_BASIC = "web_search_20250305";

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).toLowerCase());
}

function parseDomainList(value) {
  if (!value) return null;
  const domains = String(value)
    .split(",")
    .map((entry) => entry.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  return domains.length > 0 ? domains : null;
}

/** Resolved outside-reference settings for one request. */
export function resolveSourcePolicy(env = process.env) {
  const restrictToOfficial = envFlag(env.AIFACTORY_RESTRICT_SOURCES, true);
  const configured = parseDomainList(env.AIFACTORY_SOURCE_DOMAINS);
  return {
    enabled: envFlag(env.AIFACTORY_WEB_SEARCH, true),
    restrictToOfficial,
    domains: configured ?? OFFICIAL_SOURCE_DOMAINS,
    domainsAreConfigured: Boolean(configured),
    maxUses: Number.parseInt(env.AIFACTORY_WEB_SEARCH_MAX_USES ?? "", 10) || 5,
  };
}

/**
 * Messages API web search tool. `allowed_domains` is enforced by the API, so an
 * answer cannot cite a source outside the list while the restriction is on.
 */
export function anthropicWebSearchTool(policy, env = process.env) {
  if (!policy.enabled) return null;
  const type =
    env.ANTHROPIC_WEB_SEARCH_TOOL ||
    (envFlag(env.ANTHROPIC_WEB_SEARCH_BASIC, false)
      ? ANTHROPIC_WEB_SEARCH_TOOL_BASIC
      : ANTHROPIC_WEB_SEARCH_TOOL_DEFAULT);

  const tool = { type, name: "web_search", max_uses: policy.maxUses };
  if (policy.restrictToOfficial) {
    tool.allowed_domains = accessibleDomains(policy.domains, "anthropic");
  }
  return tool;
}

/** Responses API web search tool. */
export function openAIWebSearchTool(policy, env = process.env) {
  if (!policy.enabled) return null;
  const searchContextSize = ["low", "medium", "high"].includes(env.OPENAI_WEB_SEARCH_CONTEXT)
    ? env.OPENAI_WEB_SEARCH_CONTEXT
    : "low";
  const tool = { type: "web_search", search_context_size: searchContextSize };
  // Domain filtering on this provider is opt-in: the restriction is carried in
  // the prompt by default so an unsupported filter shape cannot fail a request.
  if (policy.restrictToOfficial && envFlag(env.OPENAI_WEB_SEARCH_DOMAIN_FILTER, false)) {
    tool.filters = { allowed_domains: policy.domains };
  }
  return tool;
}

/** The source-preference block appended to the system prompt. */
export function sourceInstructions(policy) {
  if (!policy.enabled) {
    return `Outside web search is disabled for this bridge. Answer from the live
snapshot and the solvers only. If a question genuinely needs outside
documentation, say that web search is turned off rather than answering from
memory as though it were verified.`;
  }

  return `When a question needs knowledge the save cannot supply — undiscovered
recipes, a mod's documented behavior, patch changes, community techniques —
search these sources, most authoritative first:
${policy.domains.map((domain) => `- ${domain}`).join("\n")}
${
  policy.restrictToOfficial
    ? "Do not rely on sources outside that list. If the answer is not there, say so."
    : "Prefer those sources; label anything from elsewhere as less reliable."
}
Search when outside information would change your answer. Do not search for
anything the snapshot or a solver already answers — live save state always wins
over any page, however official. When a page and the save disagree about this
world, the save is right and the page is describing a different version or a
different save. Cite what you used, and keep web-derived claims visibly separate
from save-derived ones.`;
}
