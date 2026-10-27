# flashpass-mcp

An unofficial [MCP](https://modelcontextprotocol.io) server for [FlashPass](https://flashpass.net), the eAPIS / border-crossing manifest service for US and Mexico flights.

Through it, an AI assistant such as Claude can read your FlashPass address book, add passengers, and create or change manifest **drafts**. Submitting to CBP stays a deliberate manual step on flashpass.net.

> Not affiliated with or endorsed by FlashPass / Lobo Labs. It drives the regular web app with your own account, the same way you would in a browser.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `list_persons` | List saved persons (pilots, crew, passengers) with ids. Optional name filter. | – |
| `get_person` | All fields of a person, including travel documents. | – |
| `create_person` | Add a person to the address book. | ✔ |
| `update_person` | Change only the fields you pass. | ✔ |
| `list_aircraft` | Aircraft with ids. | – |
| `update_aircraft` | Change model, color, call sign, CBP decal, operator, owner. | ✔ |
| `list_manifests` | Manifests with route, leg, status, arrival date. | – |
| `get_manifest` | Flight fields and occupants. | – |
| `create_manifest_draft` | New manifest with occupants. **Saved, not submitted.** | ✔ |
| `update_manifest` | Change aircraft, times or airports; add or remove occupants. **Saved, not submitted.** | ✔ |

On purpose, there is **no submit-to-CBP tool and no delete tool**.

Field names are FlashPass's own form fields (`FirstName`, `DepartureAirport`, `ArrivalTime`…). Dropdowns accept human values (`"Mexico"`, `"Passport"`, a tail number, a person's name), and the server maps them to FlashPass's internal option ids. Dates use `MM/DD/YYYY` and times use local `HHMM`.

Example prompts:

- *"Add my friend Ana López, born 03/14/1988 in Monterrey, Mexican passport G1234567 expiring 05/2031."*
- *"Create a draft manifest MMTJ → KSAN on Dec 1 at 0900 local, arriving 0945, with me as pilot and Ana as pax, using my Home address."*
- *"Push the Dec 1 manifest departure to 1100 and remove Ana."*

## Setup

Requirements:

- Node.js **23.6+**, which runs the `.ts` file directly with no build step.
- **Google Chrome** installed. It is used headless, only to log in.

```bash
git clone https://github.com/arturodz/flashpass-mcp.git
cd flashpass-mcp
npm install
cp .env.example .env    # then fill in your FlashPass username and password
```

### Claude Code

```bash
claude mcp add flashpass --scope user -- node /absolute/path/to/flashpass-mcp/server.ts
```

### Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "flashpass": {
      "command": "node",
      "args": ["/absolute/path/to/flashpass-mcp/server.ts"],
      "env": { "FLASHPASS_USER": "you@example.com", "FLASHPASS_PASS": "…" }
    }
  }
}
```

Credentials come from environment variables first, then from `.env` next to `server.ts`. The session cookie is cached in `auth/cookie.txt` with mode `600`. Both `.env` and `auth/` are git-ignored.

### Smoke test

```bash
npm run smoke                                   # list tools
npm run smoke -- list_manifests                 # call a read-only tool
npm run smoke -- get_person '{"id":"123456"}'
```

## How it works

FlashPass is built on the [PRADO](https://github.com/pradosoft/prado) PHP framework. It has no JSON API. Every page is server-rendered, and every action is a **postback**: a `POST` to the same URL carrying all form fields, the hidden `PRADO_PAGESTATE`, and `PRADO_POSTBACK_TARGET` (the control that was "clicked"). This server maps each MCP tool to those request patterns and makes them with plain `fetch`. The only cookie it needs is the session's `PHPSESSID`.

| Tool | Requests (`/index.php?page=…`) |
|---|---|
| *login* | Headless Chrome: `GET /` → fill `ctl0$ctl2$Username` / `ctl0$ctl2$Password` → submit → keep `PHPSESSID` |
| `list_persons` | `GET subscriber.persons.Home` |
| `get_person` | `GET subscriber.persons.Edit&id={id}` |
| `create_person` | `GET subscriber.persons.Add` → `POST` target `ctl0$ContentPlaceHolder$Save` |
| `update_person` | `GET subscriber.persons.Edit&id={id}` → `POST` target `…$Save` |
| `list_aircraft` | `GET subscriber.aircrafts.Home` |
| `update_aircraft` | `GET subscriber.aircrafts.Edit&id={id}` → `POST` target `…$Save` |
| `list_manifests` | `GET subscriber.manifests.Home` |
| `get_manifest` | `GET subscriber.manifests.Edit&id={id}` |
| `create_manifest_draft` | `GET subscriber.manifests.Add` → `POST …$AddOccupant` (once per occupant) → `POST …$Save` |
| `update_manifest` | `GET subscriber.manifests.Edit&id={id}` → `POST …$DataGrid$ctlN$ctl4` (Remove, per occupant) → `POST …$AddOccupant` → `POST …$Save` |

Details:

- **Login uses a real browser** because the login form is protected by Cloudflare Turnstile. The check passes normally for a real Chrome; nothing is bypassed. After login everything is plain HTTP. If the session expires, the server logs in again once and retries.
- **Each postback chains page state.** The server serializes the form the way a browser would: no buttons, only checked radios and checkboxes, the selected option of each dropdown. It applies your changes and posts. Each `AddOccupant` response carries the new `PRADO_PAGESTATE`, which the next request uses.
- **Success is detected by navigation.** A successful Save navigates away from the Add/Edit page. If the page stays, the server returns FlashPass's visible validator messages. One example: *"Emergency Contact can't be on the flight."*
- **Requests run one at a time** (a single global queue) to keep load on flashpass.net minimal.

## For the FlashPass team

This was built as a pilot's convenience tool and is shared with you openly. A few things would make an integration like this sturdier, and kinder to your servers:

1. **A small authenticated JSON API**, or even just per-user API tokens. That would remove the need for a headless browser at login and for scraping HTML tables.
2. **Stable ids on grid rows and validators.** Today rows are matched by link URLs (`&id=`) and Remove buttons by generated control ids (`DataGrid_ctl2_ctl4`).
3. **An explicit "draft" vs "ready to submit" status.** Saved, unsubmitted manifests currently show as `Ready`.

If you'd prefer this didn't exist, or want changes to how it talks to FlashPass, open an issue and it'll be handled promptly.

## License

MIT
