# BiasharaBot frontend (installable PWA)

React + Vite app that a duka owner installs to their phone's home screen. The
point of the PWA work is that **a sale can be recorded with no network** — by
voice or typed — and uploads itself once signal comes back, reconciling against
M-Pesa payments on arrival.

## Commands

```bash
npm run dev      # dev server
npm run build    # production build (also injects the SW precache manifest)
npm run lint     # oxlint
npm run icons    # regenerate public/icons/* from scripts/generate-icons.mjs
```

`VITE_API_BASE` overrides the backend URL. Development defaults to
`http://localhost:5000/api`; production builds default to the deployed Render
service. The URL is baked in at build time and is also what queued uploads use.
Restart Vite after changing an environment override. Start the local backend
from the repository root with `npm run dev:backend` when testing development.

## How offline works

| Piece | File |
| --- | --- |
| Install metadata, icons, shortcuts | [public/manifest.webmanifest](public/manifest.webmanifest) |
| App-shell cache, API replay, Background Sync | [public/sw.js](public/sw.js) |
| Precache list injected into the SW at build time | [vite.config.js](vite.config.js) |
| IndexedDB stores (queue + snapshots) | [src/lib/idb.js](src/lib/idb.js) |
| Upload queue, retries, idempotency keys | [src/lib/outbox.js](src/lib/outbox.js) |
| On-device parse of typed entries | [src/lib/localParse.js](src/lib/localParse.js) |
| SW registration, install prompt, storage persistence | [src/lib/pwa.js](src/lib/pwa.js) |
| Connectivity + queue state for the UI | [src/hooks/useOfflineSync.js](src/hooks/useOfflineSync.js) |

**Capture.** With no network, a typed entry or a recorded voice note goes into
an IndexedDB outbox (audio blob included) instead of being lost. Typed entries
also get an on-device parse so today's totals still move; that figure is shown
with `≈` and is replaced by the server's Gemini parse after sync. Voice notes
show no amount at all until they upload — the transcription only exists
server-side, so inventing a number would be a lie.

**Sync.** The queue drains when the browser fires `online`, when the app is
focused again, on a slow poll, and — where supported — through the service
worker's Background Sync, which uploads even with the app closed. Every queued
item carries a `clientId`; the backend treats it as an idempotency key, so a
retry or an app/service-worker race can never write the same sale twice. The
capture time travels with the upload as `occurredAt`, so a sale made at 4pm and
uploaded at 8pm still lands on the right day in the weekly report.

**Reconciliation.** If the customer's M-Pesa payment reaches the server before
the offline sale does, PayHero's webhook logs a placeholder payment. When the
real entry arrives, `backend/offline-sync.js` absorbs that placeholder — marking
the sale paid and deleting the duplicate — so revenue is counted once.

**Reads.** The ledger and the weekly till slip are snapshotted locally, so both
screens open offline. Anything served from a saved copy says so, and the app
never claims the weekly SMS went out when the response came from cache.

## Needs network

Registering a business, unlocking the Admin Ledger (bcrypt check is server-side)
and sending an STK push all require a live connection, and the UI says so rather
than queueing something that cannot work later.

## Hosting

Deployed on Vercel at https://biashara-gpt.vercel.app — the Vercel project's
Root Directory is this `frontend/` folder, which is where [vercel.json](vercel.json)
has to live. That config does three things: falls unknown paths back to
`index.html`, caches the content-hashed `assets/` immutably (Vercel's default
revalidates the JS and CSS on every launch, which costs data on a slow
connection), and keeps `sw.js` uncacheable so a deploy can actually reach
phones that already have the app installed.

### Requirements on any host

- **HTTPS** (or localhost). Service workers do not run otherwise.
- Serve `sw.js` from the **site root** so its scope covers the whole app, and
  with a short/no-cache `Cache-Control` so updates are picked up.
- SPA fallback: unknown paths should return `index.html`.
- Hashed assets in `assets/` can be cached immutably; `index.html` should not.
- Background Sync is Chromium-only. On iOS the queue drains when the app is
  next opened, which is why the install prompt matters there.
