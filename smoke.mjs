// Smoke test: node smoke.mjs (hits the real APIs).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const c = new Client({ name: "smoke", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"] }));
let bad = 0;
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) bad++;
  console.log(r.isError ? "FAIL" : "ok  ", name, r.content[0].text.slice(0, 120));
};
console.log((await c.listTools()).tools.length, "tools");
await call("export_search", { file: "ExportWarframes", query: "narin" });
await call("wfstat_search", { query: "narin" });
await call("wfstat_worldstate", { section: "cetusCycle" });
await call("market_search", { query: "serration" });
await call("market_orders", { slug: "serration" });
await c.close();
process.exit(bad ? 1 : 0);
