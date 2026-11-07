# GA from chat apps

Use GA from claude.ai, ChatGPT, Gemini, Grok, Grok Bot or Claude Code on another machine. After the one-time setup below, nothing needs Terminal.

Back to the [README](../README.md).

## One-time setup

1. Tailscale: turn on MagicDNS and HTTPS certificates and allow Funnel, as in [Sharing](sharing.md#turning-on-links).
2. Put your public address in `.env` (gitignored), then restart:

   ```sh
   echo 'GA_PUBLIC_URL=https://<machine>.<tailnet>.ts.net' >> .env
   docker compose up -d
   ```

   Without `GA_PUBLIC_URL`, `ga-gateway` serves only share pages and `/callback`.
3. Turn on Funnel (you run this, GA never does). One route `/` now serves everything, including the hospital login return `/callback`:

   ```sh
   tailscale funnel --bg 8110
   ```

   If you earlier routed `/callback` to port 8765, remove that route first: `tailscale funnel --set-path /callback off`. `tailscale funnel reset` clears every route; then run the line above.
4. Create your passkey (the `ga` command doesn't read `.env`, so give the address here too). This prints a one-time link (valid 24 hours); open it on your phone:

   ```sh
   GA_PUBLIC_URL=https://<machine>.<tailnet>.ts.net ga passkey link
   ```

5. In the chat app, add a custom connector with the URL `https://<machine>.<tailnet>.ts.net/mcp`. The app sends you to GA's login page: sign in with your passkey and approve the app by name.

Only you get in: every call needs your login. See which apps are connected and cut one off:

```sh
ga apps
ga apps disconnect <clientId>
```

Or use `connected_apps` and `disconnect_app` in chat. Every remote call is logged locally (tool, app, time; never the content).

## What you can do in chat

Read tools (`lab_results`, `fhir_search`, `fhir_read`, `vaccine_gaps`, `cardiovascular_risk_10yr`) plus:

| Area | Tools |
|---|---|
| Hospitals | `hospital_connect` (returns the MyChart login link), `hospital_status`, `hospital_enable`, `hospital_sync`, `hospital_disconnect` |
| Shares | `share_create`, `share_list`, `share_log`, `share_revoke` |
| Imports | `upload_link`, `import_file`, `import_status`, `ga_import` |
| Apps | `connected_apps`, `disconnect_app` |

Creating a share and enabling a hospital's record types are two steps: a preview first, then the action after your yes. The agent carries that yes: see [SECURITY.md](../SECURITY.md).

**Importing files.** The chat app can't hand GA a file, so ask it to import one: `upload_link` returns a link (single use, 15 minutes). Open it, sign in with your passkey, and pick the file. For a PDF or photo you pick it in the chat too, so the agent can read it. Apple Health, Epic EHI and C-CDA exports go up as a zip and import in the background; ask for the status. ChatGPT attachments are off until a file host is added to `config/chat-apps.json` (`fileHosts`, empty now), so use the upload link there too.

Connecting a hospital from chat needs the https redirect registered with Epic ([Hospital portals](hospital-portals.md)). Epic's sandbox (`http://localhost:8765/callback`) stays `ga connect` in Terminal.

## Per app

Each app's redirect addresses are in `config/chat-apps.json`.

- **Claude Code** (any machine): `claude mcp add --transport http ga https://<machine>.<tailnet>.ts.net/mcp`. Not yet verified.
- **Grok (grok.com)**: free account. Verified 2026-11-06. Add the connector under Connectors, Custom; passkey sign-in and consent worked. Grok uses GA only when you name it, e.g. "Look in my GA: ...". Reading records, hospital status, share preview, confirm and revoke, and upload links all worked. To import a PDF, attach it in the Grok chat too: Grok reads it, GA keeps the uploaded original. A chat app may open a share link right after creating it; that shows up as an access in the share log.
- **claude.ai**: a free personal account allows one custom connector. On an Enterprise plan only an organization Owner can add one. Not yet verified.
- **ChatGPT** (chatgpt.com): verified 2026-11-07. Turn on developer mode (Settings, Apps & Connectors, Advanced), then create a connector with the `/mcp` URL and OAuth, client ID and secret empty. In a chat, select GA with the + button in the text box. Attaching files straight to GA stays off; use upload links.
- **Gemini app** (gemini.google.com): verified 2026-11-07. Settings, Connected Apps, Custom apps, Add a custom app; leave Client ID and secret empty. Needs a personal Google account with Gemini Apps Activity on. Gemini uses GA only when you name it: start with "@" and the app name, or "use my GA server".
- **Grok Bot**: not yet verified.

In each app, add a custom connector with the URL from step 5; the passkey login is the same everywhere.

## When something fails

- `docker compose logs ga-gateway` shows whether remote access is on (`remote access on: <url>/mcp`).
- The app says the connector is unreachable: check `tailscale funnel status`, that the Mac is awake and online, and that a firewall allows Tailscale.
- Registration fails with "redirect_uris must belong to a known chat app": the app's redirect address isn't in `config/chat-apps.json`; add it and restart `ga-gateway`.
