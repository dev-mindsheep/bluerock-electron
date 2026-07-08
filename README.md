# Blue Rock Procurement (Electron)

Cross-platform desktop app (Windows + macOS) that automates intake, extraction,
review, and QuickBooks Online entry of KAR Oil Refinery procurement documents
(Purchase Requests / Service Requests) for Blue Rock Trading Ltd.

**Design principle: complete handover, zero hosting.** Everything runs locally on
the staff member's machine. The only network calls are the ones the user configures:
IMAP polling, the AI vision API (image documents only), QuickBooks, and the optional
Google Drive archive. No document is stored in any cloud unless Drive archival is
explicitly enabled.

## Flow

1. **Settings tab** — enter IMAP inbox details, AI API key (Anthropic or OpenAI),
   QuickBooks credentials (or leave in Mock mode), optional Google Drive.
2. **Queue tab** — documents arrive by email polling or drag-and-drop
   (PDF / JPG / PNG / WEBP).
3. Click a document → it is **extracted with AI** (default): typed PDFs as text,
   photos/scans as vision — always through a strict JSON schema
   (Claude `claude-opus-4-8` by default, or GPT). A local no-AI parser for typed
   PDFs exists as a cost saver ("Use AI for typed PDFs" → Auto/Never in Settings).
4. **Review screen** — original document on the left, editable fields on the right.
   Low-confidence fields are highlighted. Fix anything, then:
5. **Approve & push** — a QuickBooks Bill is created (0.00 amounts, review-pending;
   the team adds cost/margin in QBO). In **Mock mode** the exact Bill payload is
   written to `qb-outbox/` instead, so the whole flow works before an Intuit
   developer account exists.

## Development

```bash
npm install
npm start                 # run the app
npm run test:extract samples/PR-30279.pdf   # test extraction without Electron
```

`samples/` is gitignored — client documents never go into the repo.

## Building installers

- Windows (on Windows): `npm run dist:win`
- macOS: electron-builder **cannot** build mac targets from Windows/Linux.
  Push a tag (`v0.1.0`) or run the **build** workflow manually — GitHub Actions
  builds unsigned DMG/ZIP on a macOS runner and NSIS installer on Windows,
  attached as workflow artifacts.
- The mac build is unsigned (per SOW): first launch is right-click → Open.

## Integration notes / gotchas

- **QuickBooks OAuth**: sandbox supports the built-in `http://localhost:<port>/callback`
  loopback flow. **Production apps cannot use localhost** (Intuit enforces HTTPS) —
  register a public HTTPS redirect page and use *Settings → QuickBooks → Manual code
  entry* to paste the `code` + `realmId` once. Refresh tokens rotate on every refresh
  and expire after ~100 days of disuse; the app persists the rotated token automatically.
- **Google Drive**: OAuth Desktop-app client, `drive.file` scope (app only sees files
  it creates). The Cloud Console consent screen must be **In production** — in
  *Testing* status refresh tokens die after 7 days.
- **Gmail intake**: plain IMAP needs an App Password (2FA required). A dedicated
  mailbox on the client's own domain is simpler.
- **Secrets** are encrypted at rest via Electron `safeStorage`
  (Keychain on macOS, DPAPI on Windows).

## Project docs

Estimate & technical requirements live in the shared Drive folder
"Blue Rock Trading - KAR Automation".
