# Fudan iCourse Live Player

Standalone current-live player for Fudan iCourse. This is a separate project;
it does not contain the encrypted-summary subscriber, email delivery, database,
recording, download, or pre-release playback features.

## Components

- `live_player/` — loopback-only Windows/Python bridge and current-live API.
- `edge_extension/` — Microsoft Edge Manifest V3 helper and embedded player.
- `frontend/live/` — static GitHub Pages shell.

The Pages shell has no cloud proxy. It works with the Edge extension or with an
explicitly started local bridge. Pairing tokens are fragment-only, one-use, and
kept in memory; media is streamed without local persistence.

## Run locally

Install Python dependencies from `requirements.txt`, set `StuId`, `UISPsw`, and
`COURSE_IDS` in the local environment, then run:

```powershell
python -m live_player.cli --pages
```

The launcher binds only to `127.0.0.1` and opens the Pages live route in Edge.
Never commit the environment file or real credentials.

## Build the Edge extension

```powershell
node edge_extension/scripts/build.mjs
```

Load `dist/edge-extension` in `edge://extensions` with Developer mode enabled.
The generated ZIP is `dist/fudan-icourse-live-edge.zip`.

## Test

```powershell
python -m unittest discover -s tests -q
node --test tests/pages_live/*.test.mjs tests/extension/*.test.mjs
```

Real playback still requires an authorized Fudan session and a lecture that is
currently live. The project intentionally does not bypass delayed replay access.
