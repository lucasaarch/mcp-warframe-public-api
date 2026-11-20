#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import LZMA from "lzma";

const UA = "mcp-warframe-public-api/0.1";
const STATS = "https://api.warframestat.us";
const MARKET = "https://api.warframe.market/v2";
const EXPORT = "https://content.warframe.com/PublicExport";
const MAX = 20000;

const out = (data) => ({
  content: [{ type: "text", text: (typeof data === "string" ? data : JSON.stringify(data)).slice(0, MAX) }],
});
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] });
const wrap = (fn) => async (args) => {
  try {
    return out(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

async function get(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init.headers } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r;
}
const json = async (url, init) => (await get(url, init)).json();

// Public Export: the index is an LZMA file listing "Export*_en.json!<hash>"; cached per process.
let indexCache;
async function exportIndex() {
  if (!indexCache) {
    const buf = new Uint8Array(await (await get(`${EXPORT}/index_en.txt.lzma`)).arrayBuffer());
    indexCache = String(LZMA.decompress(Array.from(buf))).split(/\r?\n/).filter(Boolean);
  }
  return indexCache;
}
const exportCache = new Map();
async function exportFile(name) {
  const entry = (await exportIndex()).find((l) => l.startsWith(`${name}_en.json!`));
  if (!entry) throw new Error(`Unknown export "${name}". Use export_list.`);
  if (!exportCache.has(entry)) {
    const text = await (await get(`${EXPORT}/Manifest/${entry}`)).text();
    // DE's JSON has raw control characters inside strings; strip them before parsing.
    exportCache.set(entry, JSON.parse(text.replace(/[\u0000-\u001f]/g, " ")));
  }
  return exportCache.get(entry);
}

const server = new McpServer({ name: "mcp-warframe-public-api", version: "0.1.0" });
const tool = (name, description, shape, fn) => server.tool(name, description, shape, wrap(fn));

// --- DE Public Export ---
tool("export_list", "List the DE Public Export files (Warframes, Weapons, Upgrades/mods, Recipes...).", {}, async () =>
  (await exportIndex()).map((l) => l.split("!")[0].replace(/_en\.json$/, "")),
);
tool(
  "export_search",
  "Search a Public Export file (e.g. ExportWarframes, ExportUpgrades, ExportWeapons) by name substring. Returns raw DE entries.",
  {
    file: z.string().describe("Export file, e.g. ExportUpgrades"),
    query: z.string(),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ file, query, limit }) => {
    const data = await exportFile(file);
    const list = Object.values(data).find(Array.isArray) ?? [];
    const q = query.toLowerCase();
    return list.filter((e) => String(e.name ?? e.uniqueName ?? "").toLowerCase().includes(q)).slice(0, limit);
  },
);

// --- warframestat.us ---
const platform = z.enum(["pc", "ps4", "xb1", "swi"]).default("pc");
tool(
  "wfstat_search",
  "Search items (warframes, weapons, mods...) on warframestat.us by name.",
  { query: z.string(), language: z.string().default("en") },
  async ({ query, language }) => json(`${STATS}/items/search/${encodeURIComponent(query)}?language=${language}`),
);
tool(
  "wfstat_item",
  "Get one item (warframe, weapon, mod) from warframestat.us by exact name or uniqueName.",
  { name: z.string(), category: z.enum(["warframes", "weapons", "mods", "items"]).default("items") },
  async ({ name, category }) => json(`${STATS}/${category}/${encodeURIComponent(name)}`),
);
tool(
  "wfstat_worldstate",
  "Live worldstate from warframestat.us. section: empty for full state, or e.g. cetusCycle, vallisCycle, cambionCycle, fissures, alerts, invasions, sortie, archonHunt, voidTrader, nightwave, arbitration, events.",
  { section: z.string().default(""), platform },
  async ({ section, platform }) => json(`${STATS}/${platform}${section ? `/${encodeURIComponent(section)}` : ""}`),
);

// --- warframe.market (v2) ---
tool(
  "market_search",
  "Find warframe.market items by name substring (slug, name, tags, ducats). The slug feeds market_item and market_orders.",
  { query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
  async ({ query, limit }) => {
    const q = query.toLowerCase();
    const { data } = await json(`${MARKET}/items`, { headers: { Language: "en" } });
    return data
      .filter((i) => i.slug.includes(q.replace(/\s+/g, "_")) || i.i18n?.en?.name?.toLowerCase().includes(q))
      .slice(0, limit)
      .map((i) => ({ slug: i.slug, name: i.i18n?.en?.name, tags: i.tags, maxRank: i.maxRank, ducats: i.ducats }));
  },
);
tool("market_item", "Details of one warframe.market item by slug.", { slug: z.string() }, async ({ slug }) =>
  json(`${MARKET}/item/${encodeURIComponent(slug)}`),
);
tool(
  "market_orders",
  "Top sell and buy orders for an item on warframe.market (best prices first).",
  { slug: z.string(), rank: z.number().int().min(0).optional().describe("Mod rank filter") },
  async ({ slug, rank }) =>
    json(`${MARKET}/orders/item/${encodeURIComponent(slug)}/top${rank != null ? `?rank=${rank}` : ""}`, {
      headers: { Platform: "pc" },
    }),
);

await server.connect(new StdioServerTransport());
