# mcp-warframe-public-api

MCP server (stdio) for Warframe's public APIs:

- **DE Public Export** (`export_list`, `export_search`): official data for warframes, weapons, mods, recipes.
- **warframestat.us** (`wfstat_search`, `wfstat_item`, `wfstat_worldstate`): items and live worldstate.
- **warframe.market** (`market_search`, `market_item`, `market_orders`): mod and item prices (v2 API).

No API keys needed. Node 20+.

## Use (npx)

```json
{ "mcpServers": { "warframe": { "command": "npx", "args": ["-y", "mcp-warframe-public-api"] } } }
```

Dev: `npm install && npm start`.

## Publish

```bash
npm login && npm publish
```

`npm test` runs a smoke test against the real APIs.

## Notes

- Overframe has no public API, so builds from it are not included.
- Be gentle with the APIs: warframe.market asks for about 3 requests/second.
- Tool output is cut at 20,000 characters.
- Unofficial; not affiliated with Digital Extremes.

## License

MIT

## Build tools (heuristic)

- `compatible_mods`: mods for a warframe/weapon (by mod type; exclusive mods by item name).
- `build_check`: compatibility, duplicates, max rank, capacity/drain (polarity match = half, mismatch = +25%). Ignores exilus and arcanes.

## Your warframe.market account (optional)

Set env in the MCP config (never commit credentials): `WFM_TOKEN` (JWT) or `WFM_EMAIL` + `WFM_PASSWORD`; optional `WFM_PLATFORM` (pc, ps4, xbox, switch, mobile).

```json
{ "mcpServers": { "warframe": { "command": "npx", "args": ["-y", "mcp-warframe-public-api"],
  "env": { "WFM_EMAIL": "you@mail.com", "WFM_PASSWORD": "..." } } } }
```

Tools: `market_my_orders`, `market_create_order`, `market_update_order`, `market_delete_order`, `market_close_order`, `market_set_status`. They change the real account. Auth uses the v1 sign-in (the official docs say OAuth is not public yet); not tested with a real account.

## More warframe.market tools (v0.3)

`market_me`, `market_update_profile`, `market_get_order`, `market_recent_orders`, `market_item_orders`, `market_item_set`, `market_item_statistics`, `market_user`, `market_user_orders`, `market_riven_weapons`, `market_riven_weapon`, `market_riven_attributes`, and `market_api` (escape hatch: any endpoint with your auth).

## inventory (v0.4)

`inventory` reads your Warframe account inventory (read-only) via the unofficial game API. Env: `WF_EMAIL`, `WF_PASSWORD` (never commit). Logs in once and logs out; refuses if the game is open. Unofficial: use at your own risk.
