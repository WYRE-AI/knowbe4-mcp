/**
 * Iframe bridge + renderer for the KnowBe4 user card (MCP Apps, SEP-1865).
 *
 * Runs inside the host's sandboxed iframe. Uses the official MCP Apps client
 * (`App`) to receive the knowbe4_users_get tool result from the host. The card
 * is read-only — KnowBe4 is a reporting surface here, so there is no write
 * round-trip.
 *
 * The server attaches a normalized `_card` payload to knowbe4_users_get
 * results (see src/card.builder.ts) so this renderer never needs to resolve
 * ids or entity names itself.
 *
 * Rendering uses DOM construction (no innerHTML) — user names, emails, and
 * titles are untrusted vendor data, so text only ever lands in text nodes.
 *
 * White-label: the card is neutral by default (no vendor identity) and applies
 * an injected `window.__BRAND__` override (set by the MCP server via
 * MCP_BRAND_* env vars, or a gateway per-org) so the same card can render in
 * any operator's brand.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Brand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}
declare global {
  interface Window {
    __BRAND__?: Brand;
  }
}

/** Mirror of UserCard in src/card.builder.ts — keep in sync. */
interface UserCard {
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

const brand: Brand = window.__BRAND__ ?? {};
const brandName = brand.name ?? "";

// Apply any injected brand overrides onto the CSS custom properties.
function applyBrand(): void {
  const root = document.documentElement.style;
  if (brand.primaryColor) root.setProperty("--brand-primary", brand.primaryColor);
  if (brand.accentColor) root.setProperty("--brand-accent", brand.accentColor);
  if (brand.bg) root.setProperty("--brand-bg", brand.bg);
  if (brand.text) root.setProperty("--brand-text", brand.text);
}

const app = new App({ name: "KnowBe4 User Card", version: "1.0.0" });

/** Create an element with a class and (safe, text-node) children. */
function el(
  tag: string,
  className = "",
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(child); // strings become text nodes — never parsed as HTML
  }
  return node;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function field(label: string, value: string | undefined): HTMLElement | null {
  if (!value) return null;
  return el(
    "div",
    "field",
    el("div", "field__label", label),
    el("div", "field__value", value),
  );
}

function badge(text: string | undefined, cls: string): HTMLElement | null {
  return text ? el("span", `badge ${cls}`, text) : null;
}

/** A labeled score block with a 0–100 meter underneath. */
function score(label: string, value: number | undefined): HTMLElement | null {
  if (value === undefined) return null;
  const fill = el("div", "meter__fill");
  fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  return el(
    "div",
    "score",
    el("div", "score__label", label),
    el("div", "score__value", value.toFixed(1)),
    el("div", "meter", fill),
  );
}

/** Risk-score history as a simple bar strip (values are 0–100). */
function trend(history: UserCard["riskHistory"]): HTMLElement | null {
  if (history.length < 2) return null;
  const bars = el("div", "trend__bars");
  history.forEach((entry, i) => {
    const bar = el("div", i === history.length - 1 ? "trend__bar trend__bar--last" : "trend__bar");
    bar.style.height = `${Math.max(4, Math.min(100, entry.score))}%`;
    bar.title = `${fmtDate(entry.date)}: ${entry.score.toFixed(1)}`;
    bars.append(bar);
  });
  return el(
    "div",
    "trend",
    el("div", "trend__h", "Risk score trend"),
    bars,
    el(
      "div",
      "trend__range",
      el("span", "", fmtDate(history[0].date)),
      el("span", "", fmtDate(history[history.length - 1].date)),
    ),
  );
}

function render(u: UserCard): void {
  // Brand identity only renders when a brand was injected — the neutral
  // default shows just the user id/vendor context in the header.
  let brandId: HTMLElement | null = null;
  if (brandName || brand.logoUrl) {
    brandId = el("span", "brandid");
    if (brand.logoUrl) {
      const logo = document.createElement("img");
      logo.src = brand.logoUrl;
      logo.alt = brandName;
      logo.style.display = "inline-block";
      brandId.append(logo);
    }
    if (brandName) brandId.append(el("span", "brand", brandName));
  }

  const body = el(
    "div",
    "card__body",
    el("div", "brandrow", brandId, el("span", "userno", `#${u.id} · KnowBe4`)),
    el("h1", "", u.name),
    u.email ? el("p", "email", u.email) : null,
    el("div", "badges", badge(u.status, "badge--status"), badge(u.jobTitle, "")),
    el("div", "scores", score("Risk score", u.riskScore), score("Phish-prone %", u.phishPronePct)),
    el(
      "div",
      "grid",
      field("Department", u.department),
      field("Manager", u.manager),
      field("Location", u.location),
      field("Groups", u.groupCount !== undefined ? String(u.groupCount) : undefined),
      field("Joined", u.joinedOn && fmtDate(u.joinedOn)),
      field("Last sign-in", u.lastSignIn && fmtDate(u.lastSignIn)),
    ),
    trend(u.riskHistory),
  );

  const root = document.getElementById("root")!;
  root.replaceChildren(el("div", "card", el("div", "card__bar"), body));
}

// knowbe4-mcp returns the user JSON directly and attaches the normalized
// card to knowbe4_users_get results as _card.
function extractCard(obj: unknown): UserCard | null {
  const card = (obj as { _card?: UserCard })?._card;
  return card && typeof card.id === "number" && typeof card.name === "string" ? card : null;
}

applyBrand();

// Must be set before connect() so the initial tool-result isn't missed.
app.ontoolresult = (result: { content?: Array<{ type: string; text?: string }> }) => {
  const payload = (result.content ?? []).find((c) => c.type === "text");
  if (!payload?.text) return;
  try {
    const card = extractCard(JSON.parse(payload.text));
    if (card) render(card);
  } catch {
    /* ignore malformed payloads */
  }
};

app.connect();
