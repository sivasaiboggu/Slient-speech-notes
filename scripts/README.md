# Screenshot recipe (headless Chrome on this VM)

The `--screenshot` / `--print-to-pdf` flags do nothing in this custom
"Muse Browser" build (exit 0, no file written). Screenshots go through the
DevTools Protocol instead:

```bash
python3 scripts/cdp-screenshot.py "file://$PWD/../index.html" out.png 1280 2200 --full --dark
python3 scripts/cdp-screenshot.py "file://$PWD/../index.html" out.png 390 2800 --full --light
```

Flags: `--full` captures beyond the viewport; `--dark` emulates
`prefers-color-scheme: dark` (headless Chrome defaults to light);
`--light` forces the light theme after load. The script also prints the
page's `scrollWidth` vs `innerWidth` — equal means zero horizontal overflow.

Chrome will not start without the WebGL domain policy:
`scripts/webgl-policy.txt` (content `hatch-webgl-all-origins-v1`, one line,
trailing newline) passed with `--hatch-webgl-allowed-domains-file` and its
SHA-256 via `--hatch-webgl-allowed-domains-sha256`; the script computes the
hash itself. Requires `websocket-client` (`pip install websocket-client`).

Note: headless Chrome cannot reach external HTTPS here (egress proxy), so
Google Fonts and the MediaPipe CDN do not load in these renders — the page
falls back to system fonts and the face-box guide, which is the honest
offline state, not a bug.
