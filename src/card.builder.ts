/**
 * User-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * knowbe4_users_get results get a normalized `_card` object attached
 * (see domains/users.ts) that the ui:// user card renders from. The card is
 * progressive enhancement: every step here is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 */

export const USER_CARD_RESOURCE_URI = "ui://knowbe4/user-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const USER_CARD_META = {
  "ui/resourceUri": USER_CARD_RESOURCE_URI,
  ui: { resourceUri: USER_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/user-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The BRAND_INJECT comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_RE = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the BRAND_INJECT marker with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (!brand || Object.values(brand).every((v) => !v)) return html;
  const json = JSON.stringify(brand).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_RE, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Guarded for
 * runtimes without `process`, where this returns an empty brand and the card
 * serves its neutral defaults.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of UserCard in ui/user-card.ts — keep in sync. */
export interface UserCard {
  id: number;
  name: string;
  email?: string;
  status?: string;
  jobTitle?: string;
  department?: string;
  manager?: string;
  location?: string;
  groupCount?: number;
  riskScore?: number;
  phishPronePct?: number;
  joinedOn?: string;
  lastSignIn?: string;
  riskHistory: Array<{ date: string; score: number }>;
}

const CARD_RISK_HISTORY_LIMIT = 12;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the renderable card from a knowbe4_users_get payload. The KnowBe4 user
 * object already carries resolved display strings (names, department, manager)
 * so no id lookups are needed. The risk-score trend is fetched best-effort via
 * the provided callback; a failed fetch just renders the card without a trend.
 */
export async function buildUserCard(
  user: Record<string, unknown>,
  fetchRiskHistory?: (userId: number) => Promise<unknown>
): Promise<UserCard | null> {
  const id = num(user?.id);
  if (id === undefined) return null;

  const firstName = str(user.first_name);
  const lastName = str(user.last_name);
  const email = str(user.email);
  const name = [firstName, lastName].filter(Boolean).join(" ") || email;
  if (!name) return null;

  const card: UserCard = { id, name, riskHistory: [] };

  if (email) card.email = email;
  const status = str(user.status);
  if (status) card.status = status;
  const jobTitle = str(user.job_title);
  if (jobTitle) card.jobTitle = jobTitle;
  const department = str(user.department) ?? str(user.division);
  if (department) card.department = department;
  const manager = str(user.manager_name);
  if (manager) card.manager = manager;
  const location = str(user.location);
  if (location) card.location = location;
  if (Array.isArray(user.groups)) card.groupCount = user.groups.length;
  const riskScore = num(user.current_risk_score);
  if (riskScore !== undefined) card.riskScore = riskScore;
  const phishProne = num(user.phish_prone_percentage);
  if (phishProne !== undefined) card.phishPronePct = phishProne;
  const joinedOn = str(user.joined_on);
  if (joinedOn) card.joinedOn = joinedOn;
  const lastSignIn = str(user.last_sign_in);
  if (lastSignIn) card.lastSignIn = lastSignIn;

  // Risk-score history gives the card a visible improvement trend.
  if (fetchRiskHistory) {
    try {
      const result = await fetchRiskHistory(id);
      const history = Array.isArray(result)
        ? result
        : (result as Record<string, unknown>)?.data;
      if (Array.isArray(history)) {
        card.riskHistory = history
          .map((entry) => ({
            date: str((entry as Record<string, unknown>)?.date) ?? "",
            score: num((entry as Record<string, unknown>)?.risk_score),
          }))
          .filter((e): e is { date: string; score: number } => e.score !== undefined)
          .slice(-CARD_RISK_HISTORY_LIMIT);
      }
    } catch {
      // Best-effort: render the card without a trend rather than failing the tool.
    }
  }

  return card;
}
