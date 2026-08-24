# Packaged resources

`runtime-update-public-key.pem` is the independent Ed25519 trust root for the schema-2 launcher and runtime-module catalog. The launcher accepts only `runtime-production-v2-1` manifests from the fixed `release-v2` endpoint. Its private key stays outside this repository.

`update-public-key.pem` remains the legacy/store trust root. Do not replace it during the runtime-v2 migration: the skin and pet trust documents still depend on it.

`skin-catalog-public-key.pem` and `pet-catalog-public-key.pem` provide an offline verification fallback. Online stores use fixed `catalog.json`, `trust.json`, and asset URLs. The stable `trust.json` is signed by `update-public-key.pem`, so a reviewed store-key rotation does not require a new launcher version. Store and root private keys stay outside the repository.

The offline installer already carries platform-specific Node.js through the `node` npm package, `pnpm`, and the pinned `@deepseek-ai/dsh` package. Builds must run on the target operating system and architecture so the `node` package contains the matching executable.

`pet-runtime/l2d.js` is the vendored `l2d` 2.1.1 browser runtime (MIT wrapper; see `pet-runtime/L2D-LICENSE.txt`). Its integrated Live2D Cubism SDK remains subject to Live2D Inc.'s proprietary software and publication terms. Only signed, hash-verified model files are exposed to it.
