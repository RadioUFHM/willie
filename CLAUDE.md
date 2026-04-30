# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Willie is

Willie is a personal EA PWA for Rio Miner. It's a single-page app with four views (Home, FCIT, OPF, Creative) that syncs to Google Sheets and calls the Anthropic API for a morning brief. No build system — raw HTML/CSS/JS served directly.

## Running locally

```bash
# Any static server works. Python is the quickest:
python3 -m http.server 8080
# Then open http://localhost:8080
```

The app must be served over HTTP/HTTPS (not `file://`) for the Google OAuth flow and service worker to function.

## Configuration

Copy `config.js.example` → `config.js` (or edit `config.js` directly). It is gitignored. Fill in:
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `GOOGLE_CLIENT_ID` — already set to the project's OAuth client
- `SHEET_ID` — already set to Rio's sheet

The Google OAuth client must have `http://localhost:8080` (or the production origin) in its **Authorized JavaScript origins** in Google Cloud Console.

## Google Sheets structure

The spreadsheet has three named tabs. Row 1 on each is a header row; data starts at row 2. Row indices in `state` (`ri`) map directly to sheet row numbers, enabling targeted `PUT` updates.

| Tab | Columns (A→G or A→F) |
|-----|----------------------|
| FCIT | Name, Org, Stage, Last Contact, Next Action, Due Date, Notes |
| OPF | Task, Category, Priority, Due Date, Status, Notes |
| Creative | Project, Task, Priority, Due Date, Status, Notes |

Stage values: `prospect`, `warm`, `proposal`, `closed`  
Priority values: `high`, `medium`, `low`  
Status values: `todo`, `in-progress`, `done`, `blocked`  
Creative projects: `Troopers`, `Elf Realm`, `Poetry`, `Children's Books`

## Architecture

All logic lives in `app.js`. No framework, no bundler.

- **State** (`S` object) holds auth token, all sheet data as arrays of objects, current view, active filters, and the last Willie brief text.
- **Google auth** uses the GIS (`google.accounts.oauth2`) token client loaded from `accounts.google.com/gsi/client`. Token is requested on demand; on expiry (401 response) the token is cleared and the UI prompts reconnect.
- **Sheets API calls** are plain `fetch()` against `sheets.googleapis.com/v4`. `loadFCIT/OPF/Creative` fetch full ranges and map rows to objects with their 1-indexed `ri` (row index). Saves use `append` for new rows and `PUT values` for edits; deletes `clear` the row in place.
- **Ask Willie** streams from `api.anthropic.com/v1/messages` using SSE. Requires `anthropic-dangerous-direct-browser-access: true` header for direct browser calls.
- **Views** are rendered as innerHTML strings returned by `homeHTML()`, `fcitHTML()`, `opfHTML()`, `creativeHTML()`. After each render, `bindViewEvents()` attaches listeners (filter chips, cards, add buttons) using data attributes to avoid inline-handler escaping issues with strings like `Children's Books`.
- **Modal forms** are injected into `#modal` via `showModal(html, bindFn)`. The `bindFn` callback wires up save/delete/voice listeners after the HTML is set.
- **Voice input** uses `webkitSpeechRecognition` / `SpeechRecognition`. One active recognition session at a time; tap again to stop.

## PWA / offline

`sw.js` precaches app shell files and serves them cache-first. API calls (Sheets, Anthropic, Google auth) are always network-first. Add `icons/icon-192.png` and `icons/icon-512.png` to enable full PWA install prompts.
