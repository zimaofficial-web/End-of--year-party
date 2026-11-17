# Third-party code

Copied into the repo (not installed from a package manager at build time).

| File | Package | Version | Licence | SHA-256 |
|---|---|---|---|---|
| `site/vendor/qrcode.js` | qrcode-generator (Kazuhiko Arase) | 1.4.4 | MIT (header in file) | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |
| `admin/vendor/jsQR.js` | jsqr (cozmo) | 1.4.0 | Apache-2.0 (`admin/vendor/jsQR.LICENSE.txt`) | `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859` |

Both were checked for `eval`, `new Function`, `innerHTML`, `document.write` and network calls: none found.
