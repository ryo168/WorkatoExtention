# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Workato Insights CSV Exporter: an internal Chrome extension (Manifest V3, Chrome 102+) that downloads table / chart / KPI widget data from Workato Insights dashboards as CSV. The extension source lives in `workato-insights-csv/`. Code comments and UI text are in Japanese.

## Development

- There is no build step, package manager, linter, or test suite. The files are plain vanilla JS loaded directly by Chrome.
- To try changes, load `workato-insights-csv/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked), then reload the extension and the Workato tab after each edit.
- For debugging, `injector.js` always logs to the page console with the `[wkt-csv]` prefix (DevTools → filter by `wkt-csv`).

## Architecture

Data flows through four isolated contexts:

1. **`injector.js` (MAIN world, document_start)**: monkey-patches the page's `fetch` / XHR. It reads responses via `response.clone()` and never sends requests of its own.
   - Crow-QL query results (`/insights/crow-ql/api/v2/execute`) are forwarded as `capture` messages.
   - Dashboard layout responses are detected by the shape of the JSON (`looksLikeLayoutResponse`), not by URL, because the layout endpoint varies between environments. They are forwarded as `layout` messages so captures can be mapped to widgets (`queryId` → widget title/order).
2. **`content.js` (ISOLATED world)**: receives those via `window.postMessage`. It accepts only messages where `event.source === window` and `source === 'wkt-csv-ext'`.
   - It keeps captures in tab memory only (max 100). Captures are intentionally lost on page reload.
   - It answers popup requests through `chrome.runtime.onMessage`: `getCaptures`, `getWidgetInfo`, `highlightWidget`, `clearHighlight`.
   - It matches captures to on-screen widgets by comparing column/label text against DOM selectors (`lcap-dashboard-widget`, `.data-table-column-title__text`, Highcharts / KPI label classes). These selectors depend on Workato's Angular DOM and are the most fragile part of the extension.
3. **`popup.js` / `popup.html`**: lists the captures for the current dashboard and builds CSV client-side.
   - The popup filters captures by a dashboard key derived from the `handle` query param or the `/dashboards/<id>` path.
   - It offers two downloads: all columns, or only the columns visible in the widget.
   - User-entered labels are persisted per `queryId` in `chrome.storage.local`.
   - DOM rendering uses `textContent` only (no `innerHTML`).
4. **`background.js` (service worker)**: only swaps the toolbar icon between `icons/active-*` and `icons/inactive-*` depending on whether the tab is on `*.workato.com`.

Invariants to preserve:

- `getDashboardKey()` is duplicated in `injector.js` and `content.js` and must stay identical.
- No external network traffic and no persistence of captured data. The extension only observes the page's own requests.

## Releases

A release bumps `version` in `workato-insights-csv/manifest.json` and updates the version and download link in `README.md`. The zipped extension (`workato-insights-csv-vX.Y.Z.zip`) is attached to a GitHub Release. `build/` is gitignored.
