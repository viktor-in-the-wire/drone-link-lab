# Drone Link Lab: website

A single static page that demonstrates the Drone Link Protocol (DLP) live in the browser:
a wireframe 3D drone, a simulated link carrying real signed frames, a frame inspector,
the receiver pipeline (R1 to R7), simulated attacks, a byte-by-byte frame build, and the
conformance vectors of the specification, run on page load.

No build step, no framework, no backend. The only external request is the pinned
Three.js import (jsDelivr, three@0.160.0) used by the 3D view; everything else still
works if it cannot load.

## Files

```
index.html          page structure
styles.css          blueprint styling (line art on white)
.nojekyll           tells GitHub Pages to serve files as-is
js/main.js          wiring and the animation loop
js/protocol.js      frame build/parse, CRC-16/MCRF4XX, CRC_EXTRA, signing, receiver R1-R7
js/sha256.js        synchronous SHA-256 and HMAC-SHA256
js/conformance.js   the test vectors of Section 11 of the spec
js/sim.js           drone, ground station, link, attacker
js/drone3d.js       Three.js wireframe quadcopter
js/ui.js            inspector, pipeline, link canvas, chart, log, frame builder
```

The GitHub links in `index.html` point to `viktor-in-the-wire/drone-link-lab`.

## Run locally

ES modules are blocked on `file://` by most browsers, so serve the folder:

```
cd docs            # or wherever you put this folder
python3 -m http.server 8000
# open http://localhost:8000/
```

## Publish with GitHub Pages

1. Commit this folder to the repository as `docs/` (or another folder name of your choice) on `main`.
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
4. Choose branch **main** and folder **/docs** (GitHub Pages only offers `/` or `/docs`; for any other folder name, use a GitHub Actions workflow or move the folder).
5. Save. After a minute the site is live at `https://viktor-in-the-wire.github.io/drone-link-lab/`.

All paths in the site are relative (`./styles.css`, `./js/...`), so it works from the
`/<repo>/` sub-path. The empty `.nojekyll` file stops Jekyll from processing the folder.

## Notes

- Simulation only. No real aircraft or radio hardware is involved.
- The signing key is the public test key `00 01 02 ... 1f` from the specification.
- The conformance panel runs the same `protocol.js` that drives the demo.
- Spec test 7 flips a bit of the *unsigned* frame 10.2. A strict DLP receiver stops an
  unsigned frame at R2 before the checksum, so the test runs it with "signature not
  required" and also checks the same bit flip on the signed frame 10.3; both give R5.
