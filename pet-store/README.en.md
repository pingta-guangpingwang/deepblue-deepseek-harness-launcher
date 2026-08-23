# DeepSeekHarness Pet Store

This repository publishes the free, signed pet catalog used by the Deep Blue DeepSeekHarness Launcher. It now contains 50 original transparent animated WebP companions; six legacy single-frame pets have been removed.

The new set begins with five original ten-character contact sheets, uses 25 seconds of 720P Seedance 2.0 motion masters for subtle blinking, breathing, ear, and tail movement, and is then cropped, keyed, de-spilled, and encoded locally. Pets support animation, hover reactions, click actions, double-click hearts, periodic greetings, dragging, and remembered position.

All interaction is declarative. Store entries cannot ship scripts, HTML, model weights, or executables. `catalog.json`, `trust.json`, and media URLs are stable and independent of launcher versions. The root-signed `trust.json` permits safe store-key rotation without a launcher release; when the online catalog is unavailable, the bundled catalog remains the fallback. Media downloads are verified by Ed25519 catalog signature, exact size, MIME type, and SHA-256 digest.

Original project media is released under CC0 1.0. Contributions must be original or carry a redistribution-compatible license, remain suitable for all ages, and provide a verified multi-frame animated WebP or GIF rather than a static image.
