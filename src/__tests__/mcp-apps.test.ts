/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the user card:
 *   1. the renderable tool advertises the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. buildUserCard normalizes a KnowBe4 user into the card payload
 *      the iframe renders from (read-only — no write round-trip)
 */

import { describe, it, expect, vi } from "vitest";
import { getAvailableDomains, getDomainHandler } from "../domains/index.js";
import { listResources, readResource } from "../resources.js";
import {
  buildUserCard,
  applyBrandInjection,
  USER_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../card.builder.js";
import { USER_CARD_HTML } from "../generated/user-card-html.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const RENDERABLE_TOOLS = ["knowbe4_users_get"];

async function getAllTools(): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    tools.push(...handler.getTools());
  }
  return tools;
}

describe("MCP Apps user card", () => {
  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const tool = (await getAllTools()).find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(USER_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        USER_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", async () => {
      const others = (await getAllTools()).filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", () => {
      const card = listResources().find((r) => r.uri === USER_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", () => {
      const content = readResource(USER_CARD_RESOURCE_URI);
      expect(content.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content.text).toBe(USER_CARD_HTML);
      expect(content.text).toContain("card__bar");
      expect(content.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content.text).not.toContain('src="./user-card.ts"');
    });

    it("serves neutral defaults with no vendor identity", () => {
      const { text } = readResource(USER_CARD_RESOURCE_URI);
      expect(text).not.toMatch(/WYRE/i);
      expect(text).not.toContain("00c9db"); // WYRE cyan
      expect(text).not.toContain("ede947"); // WYRE yellow
      expect(text).not.toContain("fonts.googleapis.com"); // no external fetches
    });

    it("injects MCP_BRAND_* env vars into the served HTML", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#ff0000");
      try {
        const { text } = readResource(USER_CARD_RESOURCE_URI);
        expect(text).toContain(
          '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>'
        );
        expect(text).not.toContain("BRAND_INJECT");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("rejects unknown resource URIs", () => {
      expect(() => readResource("ui://knowbe4/nope.html")).toThrow(/Unknown resource/);
    });
  });

  describe("applyBrandInjection", () => {
    const html = USER_CARD_HTML;

    it("replaces the marker with an inline window.__BRAND__ script", () => {
      const out = applyBrandInjection(html, { name: "Acme", primaryColor: "#123456" });
      expect(out).toContain('window.__BRAND__={"name":"Acme","primaryColor":"#123456"}');
      expect(out).not.toContain("BRAND_INJECT");
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(html, { name: '</script><script>alert(1)' });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)");
    });

    it("returns the HTML unchanged for an empty brand", () => {
      expect(applyBrandInjection(html, {})).toBe(html);
      expect(applyBrandInjection(html, { name: "" })).toBe(html);
    });
  });

  describe("buildUserCard", () => {
    const user = {
      id: 667542,
      first_name: "William",
      last_name: "Marcoux",
      job_title: "VP of Sales",
      email: "wmarcoux@kb4-demo.com",
      phish_prone_percentage: 14.235,
      location: "Office A",
      division: "Sales West",
      manager_name: "Michael Scott",
      groups: [3264, 3265],
      current_risk_score: 45.742,
      joined_on: "2025-04-02T15:02:38.000Z",
      last_sign_in: "2026-07-01T15:02:38.000Z",
      status: "active",
      department: "Sales",
    };

    const mockHistory = vi.fn(async () => [
      { risk_score: 60.1, date: "2026-05-01" },
      { risk_score: 45.742, date: "2026-06-01" },
    ]);

    it("normalizes the user into the flat card payload", async () => {
      const card = await buildUserCard(user, mockHistory);
      expect(card).toMatchObject({
        id: 667542,
        name: "William Marcoux",
        email: "wmarcoux@kb4-demo.com",
        status: "active",
        jobTitle: "VP of Sales",
        department: "Sales",
        manager: "Michael Scott",
        location: "Office A",
        groupCount: 2,
        riskScore: 45.742,
        phishPronePct: 14.235,
        joinedOn: "2025-04-02T15:02:38.000Z",
        lastSignIn: "2026-07-01T15:02:38.000Z",
        riskHistory: [
          { date: "2026-05-01", score: 60.1 },
          { date: "2026-06-01", score: 45.742 },
        ],
      });
    });

    it("falls back to division, then email, when fields are missing", async () => {
      const bare = { id: 1, email: "jd@example.com", division: "Ops" };
      const card = await buildUserCard(bare, mockHistory);
      expect(card?.name).toBe("jd@example.com");
      expect(card?.department).toBe("Ops");
    });

    it("unwraps a {data: [...]} history envelope and caps the trend length", async () => {
      const long = Array.from({ length: 20 }, (_, i) => ({
        risk_score: i,
        date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      }));
      const card = await buildUserCard(user, async () => ({ data: long }));
      expect(card?.riskHistory).toHaveLength(12);
      expect(card?.riskHistory[11]).toEqual({ date: "2026-01-20", score: 19 });
    });

    it("drops malformed history entries", async () => {
      const card = await buildUserCard(user, async () => [
        { risk_score: 50, date: "2026-01-01" },
        { risk_score: "not-a-number", date: "2026-01-02" },
        null,
      ]);
      expect(card?.riskHistory).toEqual([{ date: "2026-01-01", score: 50 }]);
    });

    it("returns null for payloads that are not a user", async () => {
      expect(await buildUserCard({ id: 1 }, mockHistory)).toBeNull();
      expect(await buildUserCard({ email: "no-id@example.com" }, mockHistory)).toBeNull();
      expect(await buildUserCard({}, mockHistory)).toBeNull();
    });

    it("renders without a trend when no history fetcher is provided", async () => {
      const card = await buildUserCard(user);
      expect(card?.riskHistory).toEqual([]);
    });

    it("survives history-fetch failures (card is best-effort)", async () => {
      const card = await buildUserCard(user, async () => {
        throw new Error("KnowBe4 500");
      });
      expect(card).toMatchObject({ id: 667542, name: "William Marcoux", riskHistory: [] });
      expect(card?.riskScore).toBe(45.742);
    });
  });
});
