# DeepSeekHarness Skin Store

This repository publishes the free, signed visual-skin catalog used by the Deep Blue DeepSeekHarness Launcher. It currently contains 63 skins, including 55 dynamic and 1080P still variants derived locally from 11 original Seedance 2.0 masters.

The collection is original and does not scrape or remix online dance, film, game, or influencer media. The Moonlit Dance Studio uses a fictional, fully clothed adult performer and does not imitate a real person or third-party character.

The launcher downloads only paginated thumbnails while browsing and fetches full media only after the user selects Apply. `catalog.json`, `trust.json`, and asset URLs are stable and never contain a launcher version. The store catalog is signed with Ed25519, while `trust.json` is signed by the long-lived launcher root so store-key rotation does not require a launcher release. If the online catalog is unavailable, the launcher uses its bundled fallback catalog. Every asset also carries an exact byte count, MIME type, and SHA-256 digest. Store entries cannot execute JavaScript or CSS.

Original project media is released under CC0 1.0. Contributions must include verifiable authorship, source, and a redistribution-compatible license. “Found online” is not accepted.
