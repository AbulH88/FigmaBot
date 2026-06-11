# FigmaBot Control Panel v2 — UI Redesign

Date: 2026-06-11
Status: Approved by user

## Goal

Replace the single long-scroll page with a sidebar app layout. The most-used
controls (start/stop, live logs) become the landing view; set-once settings
move out of the way. Keep the dark glassmorphism visual theme.

## Scope

Front-end only: `public/index.html`, `public/style.css`, `public/script.js`.
No changes to `server.js` APIs, socket.io events, or `bot.js`.

## Structure

Vanilla HTML/CSS/JS, no framework, no build step. Single page with
hash-routed views (`#dashboard`, `#proxies`, `#accounts`, `#settings`).

- **Sidebar** (fixed left, collapses to top bar under 768px): logo, nav
  links for the four views, bot status pill at the bottom driven by the
  existing `botStatus` socket event.
- **Dashboard** (default): stat cards (Total accounts, Verified, Failed,
  Proxies loaded — computed client-side from `/api/accounts` and
  `/api/proxies`), quick "accounts to create" input that saves
  `ACCOUNTS_TO_CREATE` via `/api/settings`, Start/Stop buttons, live log
  terminal.
- **Proxies**: paste/upload panel + saved list with per-proxy check status.
  Same endpoints as today.
- **Accounts**: table with click-to-copy email/password, passwords masked
  with per-row reveal toggle, Export CSV (client-side blob download),
  delete per row.
- **Settings**: the env config form (DA_URL, DA_USERNAME, DA_PASSWORD,
  EMAIL_DOMAIN, IMAP_HOST, IMAP_PORT, ACCOUNTS_TO_CREATE).

## Error handling

- All fetches wrapped; failures surface as toast notifications, not
  silent console errors or native alert().
- Destructive actions (clear proxies, delete account) keep confirm().

## Testing

Manual: load each view, run start/stop against the real server, verify
socket log streaming, proxy check flow, account table rendering with the
repaired CSV, copy/reveal/export interactions, and responsive collapse.
