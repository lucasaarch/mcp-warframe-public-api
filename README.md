# mcp-warframe-public-api

MCP server (stdio) for Warframe's public APIs:

- **DE Public Export** (`export_list`, `export_search`): official data for warframes, weapons, mods, recipes.
- **warframestat.us** (`wfstat_search`, `wfstat_item`, `wfstat_worldstate`): items and live worldstate.
- **warframe.market** (`market_search`, `market_item`, `market_orders`): mod and item prices (v2 API).

No API keys needed. Node 20+.

## Use

```bash
npm install
npm start
```

MCP client config:

```json
{ "mcpServers": { "warframe": { "command": "node", "args": ["/path/to/server.mjs"] } } }
```

`npm test` runs a smoke test against the real APIs.

## Notes

- Overframe has no public API, so builds from it are not included.
- Be gentle with the APIs: warframe.market asks for about 3 requests/second.
- Tool output is cut at 20,000 characters.
- Unofficial; not affiliated with Digital Extremes.

## License

MIT
