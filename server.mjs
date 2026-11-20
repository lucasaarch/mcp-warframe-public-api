#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import LZMA from "lzma";
import WebSocket from "ws";

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

const server = new McpServer({ name: "mcp-warframe-public-api", version: "0.4.0" });
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


// --- Build helpers (heuristic: compatibility is deduced from Export fields) ---
const norm = (s) => String(s ?? "").toLowerCase();
const pol = (p) => norm(p).replace(/^ap_/, "");
async function findItem(name) {
  const q = norm(name);
  for (const [file, kind] of [["ExportWarframes", "warframe"], ["ExportWeapons", "weapon"]]) {
    const list = Object.values(await exportFile(file)).find(Array.isArray) ?? [];
    const item = list.find((e) => norm(e.name) === q);
    if (item) return { item, kind };
  }
  throw new Error(`"${name}" not found in ExportWarframes/ExportWeapons (use the exact name).`);
}
const slotType = (item, kind) =>
  kind === "warframe" ? "WARFRAME" : { Pistols: "SECONDARY", Melee: "MELEE", LongGuns: "PRIMARY" }[item.productCategory];
async function mods() {
  return Object.values(await exportFile("ExportUpgrades")).find(Array.isArray) ?? [];
}
const compat = (m, item, kind, type) =>
  (kind === "warframe" && m.type === "AURA") || m.type === type || norm(m.compatName) === norm(item.name);

tool(
  "compatible_mods",
  "Mods that can go on a warframe or weapon (heuristic: by mod type/category; exclusive mods by item name). Optional text filter and weapon class filter (e.g. Rifle, Shotgun, Sniper, Bow, Pistol).",
  {
    item: z.string().describe("Exact warframe or weapon name, e.g. Narin, Soma"),
    query: z.string().optional().describe("Substring of mod name or effect"),
    weaponClass: z.string().optional().describe("Mod compatName filter, e.g. Rifle"),
    limit: z.number().int().min(1).max(100).default(40),
  },
  async ({ item: name, query, weaponClass, limit }) => {
    const { item, kind } = await findItem(name);
    const type = slotType(item, kind);
    const q = norm(query);
    const classes = [norm(weaponClass), norm(item.name), "any", "primary", "secondary", "warframe"];
    return (await mods())
      .filter((m) => compat(m, item, kind, type))
      .filter((m) => !weaponClass || classes.includes(norm(m.compatName)))
      .filter((m) => !q || norm(m.name).includes(q) || JSON.stringify(m.levelStats ?? "").toLowerCase().includes(q))
      .slice(0, limit)
      .map((m) => ({
        name: m.name,
        type: m.type,
        compat: m.compatName,
        polarity: m.polarity,
        baseDrain: m.baseDrain,
        maxRank: m.fusionLimit,
        maxEffect: m.levelStats?.at(-1)?.stats,
      }));
  },
);

tool(
  "build_check",
  "Validate a build: mod compatibility, duplicates, max rank, slot count and capacity (drain with polarity match/mismatch). Warframe: 1 aura + 8 mods; weapon: 8 mods. Heuristic, ignores exilus/arcanes.",
  {
    item: z.string(),
    mods: z
      .array(z.object({ name: z.string(), rank: z.number().int().min(0).optional().describe("default: max rank") }))
      .max(9),
    reactor: z.boolean().default(true).describe("Orokin Reactor/Catalyst installed (capacity 60 instead of 30)"),
    slotPolarities: z.array(z.string()).max(8).optional().describe('Polarity of the 8 normal slots in order, e.g. ["madurai","vazarin"]; omit = none'),
    auraPolarity: z.string().optional(),
  },
  async ({ item: name, mods: picked, reactor, slotPolarities = [], auraPolarity }) => {
    const { item, kind } = await findItem(name);
    const type = slotType(item, kind);
    const all = await mods();
    const problems = [];
    let capacity = reactor ? 60 : 30;
    let used = 0;
    let normal = 0;
    const seen = new Set();
    const lines = [];
    for (const p of picked) {
      const m = all.find((x) => norm(x.name) === norm(p.name));
      if (!m) {
        problems.push(`Unknown mod: ${p.name}`);
        continue;
      }
      if (seen.has(norm(m.name))) problems.push(`Duplicate mod: ${m.name}`);
      seen.add(norm(m.name));
      if (!compat(m, item, kind, type))
        problems.push(`${m.name} (${m.type}/${m.compatName}) is not compatible with ${item.name}`);
      const max = m.fusionLimit ?? 0;
      if (p.rank != null && p.rank > max) problems.push(`${m.name}: max rank is ${max}`);
      const drain = (m.baseDrain ?? 0) + Math.min(p.rank ?? max, max);
      if (m.type === "AURA") {
        const gain = auraPolarity && pol(auraPolarity) === pol(m.polarity) ? drain * 2 : drain;
        capacity += gain;
        lines.push(`${m.name} aura +${gain}`);
        continue;
      }
      const slot = pol(slotPolarities[normal++]);
      const free = !slot || slot === "any" || slot === "universal";
      const cost = free ? drain : slot === pol(m.polarity) ? Math.ceil(drain / 2) : Math.ceil(drain * 1.25);
      used += cost;
      lines.push(`${m.name}: ${cost}`);
    }
    if (normal > 8) problems.push("More than 8 normal mods");
    if (used > capacity) problems.push(`Over capacity: ${used}/${capacity}`);
    return { item: item.name, ok: problems.length === 0, capacity, used, free: capacity - used, problems, mods: lines };
  },
);

// --- warframe.market account (v1 sign-in + v2 order endpoints). Credentials only from env. ---
// WFM_TOKEN (JWT), or WFM_EMAIL + WFM_PASSWORD. Optional WFM_PLATFORM (pc/ps4/xbox/switch/mobile).
const WFM_PLATFORM = process.env.WFM_PLATFORM || "pc";
const deviceId = process.env.WFM_DEVICE_ID || `mcp-${Math.random().toString(36).slice(2)}`;
let token = process.env.WFM_TOKEN || "";
async function login() {
  const { WFM_EMAIL: email, WFM_PASSWORD: password } = process.env;
  if (!email || !password) throw new Error("Set WFM_TOKEN, or WFM_EMAIL and WFM_PASSWORD, in the MCP server env.");
  const r = await fetch("https://api.warframe.market/v1/auth/signin", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "JWT",
      Platform: WFM_PLATFORM,
      Language: "en",
    },
    body: JSON.stringify({ auth_type: "header", email, password, device_id: deviceId }),
  });
  const h = r.headers.get("authorization") ?? "";
  if (!r.ok || !h.startsWith("JWT ")) throw new Error(`warframe.market login failed (${r.status})`);
  return (token = h.slice(4));
}
async function account(method, path, body) {
  for (let retry = 0; ; retry++) {
    if (!token) await login();
    const r = await fetch(`${MARKET}${path}`, {
      method,
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Platform: WFM_PLATFORM,
        Language: "en",
        Crossplay: "true",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && retry === 0 && process.env.WFM_EMAIL) {
      token = "";
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : { ok: true };
  }
}
const itemId = async (slug) => (await json(`${MARKET}/item/${encodeURIComponent(slug)}`)).data.id;
const oid = (id) => encodeURIComponent(id);

tool("market_my_orders", "List YOUR warframe.market orders (needs WFM_* env).", {}, () => account("GET", "/orders/my"));
tool(
  "market_create_order",
  "Create a buy/sell order on YOUR warframe.market account. Changes the real account.",
  {
    slug: z.string().describe("Item slug from market_search"),
    type: z.enum(["sell", "buy"]),
    platinum: z.number().int().min(1),
    quantity: z.number().int().min(1).default(1),
    rank: z.number().int().min(0).optional().describe("Mod rank"),
    visible: z.boolean().default(true),
  },
  async ({ slug, ...o }) => account("POST", "/order", { itemId: await itemId(slug), ...o }),
);
tool(
  "market_update_order",
  "Update price, quantity or visibility of one of YOUR orders.",
  {
    orderId: z.string(),
    platinum: z.number().int().min(1).optional(),
    quantity: z.number().int().min(1).optional(),
    rank: z.number().int().min(0).optional(),
    visible: z.boolean().optional(),
  },
  ({ orderId, ...u }) => account("PATCH", `/order/${oid(orderId)}`, u),
);
tool("market_delete_order", "Delete one of YOUR orders.", { orderId: z.string() }, ({ orderId }) =>
  account("DELETE", `/order/${oid(orderId)}`),
);
tool(
  "market_close_order",
  "Mark a quantity of one of YOUR orders as traded (closes/reduces it).",
  { orderId: z.string(), quantity: z.number().int().min(1).default(1) },
  ({ orderId, quantity }) => account("POST", `/order/${oid(orderId)}/close`, { quantity }),
);
// Presence is websocket-only in v2: the status lasts while the socket is open, so keep it for the life of the MCP process.
let ws = null;
const wsSend = (route, payload) => ws.send(JSON.stringify({ route, payload, id: Math.random().toString(36).slice(2, 10) }));
async function wsConnect() {
  if (ws?.readyState === 1) return;
  if (!token) await login();
  ws = new WebSocket("wss://ws.warframe.market/socket", "wfm", { headers: { "User-Agent": UA } });
  ws.on("message", () => {});
  await new Promise((ok, no) => {
    ws.once("open", ok);
    ws.once("error", no);
  });
  wsSend("@wfm|cmd/auth/signIn", { token });
  await new Promise((r) => setTimeout(r, 800));
}
tool(
  "market_set_status",
  "Set YOUR warframe.market presence: online, ingame or invisible (websocket; lasts while this MCP process runs). Optional duration in seconds.",
  { status: z.enum(["online", "ingame", "invisible"]), duration: z.number().int().positive().optional() },
  async ({ status, duration }) => {
    await wsConnect();
    wsSend("@wfm|cmd/status/set", { status, ...(duration ? { duration } : {}) });
    await new Promise((r) => setTimeout(r, 800));
    const me = await account("GET", "/me");
    return { requested: status, lastSeen: me?.data?.lastSeen ?? me?.lastSeen, note: "Confirm on the site." };
  },
);

// --- more warframe.market coverage ---
const V1 = "https://api.warframe.market/v1";
const slugZ = z.string().describe("Slug (lowercase, underscores)");
tool("market_me", "YOUR warframe.market profile (status, platform, reputation, settings).", {}, () => account("GET", "/me"));
tool(
  "market_update_profile",
  "Update YOUR profile fields (about, status, platform, crossplay, etc). Pass only fields to change; they are sent as-is to PATCH /me. Changes the real account.",
  { fields: z.record(z.any()).describe("e.g. {\"about\":\"...\",\"status\":\"online\",\"crossplay\":true}") },
  ({ fields }) => account("PATCH", "/me", fields),
);
tool("market_get_order", "One order by id.", { orderId: z.string() }, ({ orderId }) => account("GET", `/order/${oid(orderId)}`));
tool("market_recent_orders", "Most recent public orders on warframe.market.", {}, () => json(`${MARKET}/orders/recent`));
tool("market_item_orders", "ALL public orders for an item (not just top).", { slug: slugZ }, ({ slug }) =>
  json(`${MARKET}/orders/item/${encodeURIComponent(slug)}`),
);
tool("market_item_set", "Parts of a set item (e.g. a Prime set) on warframe.market.", { slug: slugZ }, ({ slug }) =>
  json(`${MARKET}/item/${encodeURIComponent(slug)}/set`),
);
tool("market_item_statistics", "Price history/statistics of an item (v1: 48h and 90d closed trades).", { slug: slugZ }, ({ slug }) =>
  json(`${V1}/items/${encodeURIComponent(slug)}/statistics`),
);
tool("market_user", "Public profile of a user by slug.", { slug: slugZ }, ({ slug }) => json(`${MARKET}/user/${encodeURIComponent(slug)}`));
tool("market_user_orders", "Public orders of a user by slug.", { slug: slugZ }, ({ slug }) =>
  json(`${MARKET}/orders/user/${encodeURIComponent(slug)}`),
);
tool("market_riven_weapons", "Riven-capable weapons on warframe.market.", {}, () => json(`${MARKET}/riven/weapons`));
tool("market_riven_weapon", "One riven weapon by slug.", { slug: slugZ }, ({ slug }) => json(`${MARKET}/riven/weapon/${encodeURIComponent(slug)}`));
tool("market_riven_attributes", "Riven attributes (stats) list.", {}, () => json(`${MARKET}/riven/attributes`));
tool(
  "market_api",
  "Escape hatch: call any warframe.market endpoint with your account auth. Use for anything without a dedicated tool. path starts with / (v2 by default; set v1 true for v1). Writes change the real account.",
  { method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]), path: z.string().startsWith("/"), body: z.any().optional(), v1: z.boolean().default(false) },
  ({ method, path, body, v1 }) => account(method, v1 ? `/../v1${path}` : path, body),
);


// --- Warframe account inventory (unofficial game API; read-only). Credentials only from env: WF_EMAIL + WF_PASSWORD. ---
// One login per call, no retries (DE rate-limits hard). No `kick`: if the game is open the login is refused instead of logging the game out.
import wp from "whirlpool-hash";
const WF_API = "https://api.warframe.com/api";
const NAME_FILES = ["ExportUpgrades", "ExportRecipes", "ExportResources", "ExportRelicArcane", "ExportWarframes", "ExportWeapons", "ExportGear", "ExportSentinels", "ExportCustoms"];
let nameMap;
async function names() {
  if (!nameMap) {
    nameMap = new Map();
    for (const f of NAME_FILES) {
      try {
        for (const list of Object.values(await exportFile(f)))
          if (Array.isArray(list)) for (const e of list) if (e.uniqueName && e.name) nameMap.set(e.uniqueName, e.name);
      } catch {}
    }
  }
  return nameMap;
}
async function wfInventory() {
  const email = process.env.WF_EMAIL, password = process.env.WF_PASSWORD;
  if (!email || !password) throw new Error("Set WF_EMAIL and WF_PASSWORD in the MCP server env.");
  const hash = Buffer.from(new wp.Whirlpool().getHash(password), "latin1").toString("hex");
  const lr = await fetch(`${WF_API}/login.php`, {
    method: "POST",
    headers: { "User-Agent": "Warframe", "Content-Type": "application/octet-stream" },
    body: JSON.stringify({ email, password: hash, time: Math.floor(Date.now() / 1000), s: "", lang: "en", date: 0, ClientType: "" }),
  });
  const text = await lr.text();
  if (!lr.ok) throw new Error(`Warframe login refused (${lr.status}): ${text.slice(0, 120).replace(email, "<email>")}`);
  let login;
  try { login = JSON.parse(text); } catch { throw new Error("Warframe login returned non-JSON."); }
  const q = `accountId=${login.id}&nonce=${login.Nonce}`;
  try {
    const ir = await fetch(`${WF_API}/inventory.php?${q}`, { headers: { "User-Agent": "Warframe" } });
    if (!ir.ok) throw new Error(`inventory.php answered ${ir.status}`);
    return await ir.json();
  } finally {
    await fetch(`${WF_API}/logout.php?${q}`, { headers: { "User-Agent": "Warframe" } }).catch(() => {});
  }
}
tool(
  "inventory",
  "Read-only snapshot of YOUR Warframe inventory (needs WF_EMAIL/WF_PASSWORD env). Logs in once and logs out; fails if the game is open. section: summary (counts + credits/platinum), mods, relics, resources, blueprints, equipment. Names resolved via Public Export.",
  { section: z.enum(["summary", "mods", "relics", "resources", "blueprints", "equipment"]).default("summary"), limit: z.number().int().min(1).max(500).default(100) },
  async ({ section, limit }) => {
    const inv = await wfInventory();
    const nm = await names();
    const named = (arr = []) => arr.map((x) => ({ name: nm.get(x.ItemType) ?? x.ItemType, count: x.ItemCount ?? 1 }));
    const equip = ["Suits", "LongGuns", "Pistols", "Melee", "SpaceSuits", "Sentinels", "SentinelWeapons", "OperatorAmps"];
    if (section === "summary")
      return {
        platinum: inv.PremiumCredits, credits: inv.RegularCredits, tradesRemaining: inv.TradesRemaining,
        counts: { rawMods: inv.RawUpgrades?.length, rankedMods: inv.Upgrades?.length, miscItems: inv.MiscItems?.length, blueprints: inv.Recipes?.length, ...Object.fromEntries(equip.map((k) => [k, inv[k]?.length ?? 0])) },
      };
    if (section === "mods") return named(inv.RawUpgrades).sort((a, b) => b.count - a.count).slice(0, limit);
    if (section === "blueprints") return named(inv.Recipes).slice(0, limit);
    if (section === "relics") return named(inv.MiscItems?.filter((x) => /Projection/.test(x.ItemType))).slice(0, limit);
    if (section === "resources") return named(inv.MiscItems?.filter((x) => !/Projection/.test(x.ItemType))).slice(0, limit);
    return equip.flatMap((k) => (inv[k] ?? []).map((x) => ({ kind: k, name: nm.get(x.ItemType) ?? x.ItemType, xp: x.XP }))).slice(0, limit);
  },
);
await server.connect(new StdioServerTransport());
