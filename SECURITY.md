# Security

GA holds a person's complete health record and can put parts of it on the internet through share links, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub: **Security** tab of this repository, then **Report a vulnerability**. Include what you found, how to reproduce it, and its impact. Never include real health data; use made-up records.

## Security model

- **Local by default.** The FHIR server, its database and GA's services bind to `127.0.0.1`. The server accepts browser requests only from the admin app origin `http://localhost:3000` (`MEDPLUM_ALLOWED_ORIGINS`), and VM-context bots are disabled. Anyone who can read `.ga/config.json` has full access to the record.
- **Hospital portals.** Read-only SMART on FHIR access. GA authenticates with its own private key (`private_key_jwt`, the key never leaves `.ga/smart/`), PKCE and a random `state`. Refresh tokens are stored encrypted (AES-256-GCM) in `.ga/smart/`; nothing is logged but counts and error codes.
- **What reaches the internet.** Only when you turn on Tailscale Funnel, and only the `ga-gateway` service: `/s/<token>` share links; `/callback`, accepted only for a login that is waiting (a pending `state`); and, only if you set `GA_PUBLIC_URL`, chat-app access: OAuth and passkey login pages, `/upload/<token>` (one-time link, passkey required) and `/mcp`. The FHIR server and admin app are never exposed.
- **Chat apps.** Only the owner gets in: `/mcp` needs a token from the passkey login, which you approve per app. Apps register only from known chat-app redirect addresses (`config/chat-apps.json`). Tokens last 1 hour (refresh 90 days idle); `ga apps disconnect <clientId>` cuts one off. Every remote call is logged locally (tool, app, time; never content). Known limit: for creating shares and enabling hospital types the agent carries your yes, so an agent fooled by hidden text in a document could act without you; every share is listed and revocable. Login, registration and upload are rate limited.
- **Share links.** Each link is a 256-bit random token (stored encrypted; looked up by its hash) with a scope, an expiry and instant revocation. Every route, download and answer is filtered to the share's records on the server; billing, contact and source-file records and other patients' data are never shared, and the patient record is trimmed to name, birth date and sex. Pages load nothing from third parties and send strict security headers. Failed link guesses are rate limited, and every view, download and question is logged locally (`ga share log`).
- **AI providers.** Record text goes to an AI provider only through the agent you use, or for share-link questions and `--llm api` imports if you turn them on, always with your own account.

See [TERMS.md](TERMS.md) for what GA does with data, and [docs/sharing.md](docs/sharing.md) and [docs/hospital-portals.md](docs/hospital-portals.md) for details.
