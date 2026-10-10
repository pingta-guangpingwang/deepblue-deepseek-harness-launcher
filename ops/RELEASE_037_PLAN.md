# 0.10.37 / DSH 0.2.1-alpha.2 publication plan

Status: operator prepared; **not signed or published by the module executor**.
Controller: `/root`. Source/worktree: `launcher-dsh-021`, branch
`codex/dsh-021-release-20261010`. The final source commit and artifact digests are
captured dynamically only after source review and the final build; historical
0.10.36 hashes are not reused as candidate hashes.

## Compatibility contract

The .35/.36 kernel runtime graph has no minimum-kernel field or enforcement.
`planRuntimeModuleUpdates` compares version inequality, so a .2 core advertised
in the existing directory could be installed by a kernel that strips the .2
startup authentication token. Adding an unknown `minKernel` property would not
make those clients safe.

Two independently signed schema-2 catalogs are therefore required:

| Public object | Readers | Allowed changes from the current .36 baseline |
| --- | --- | --- |
| `release-v2/launcher-manifest.json` | .35/.36 and explicit .1 rollback | `generatedAt` and `launcher` .37 update entry only; runtime graph, harness list, models, plugins and all other fields remain identical |
| `release-v2/dsh02/launcher-manifest.json` | .37 kernel, source ID `runtime-v2-dsh02` | same launcher entry; replace only `harness-core`, `launcher-ui`, `agent-host`; prepend `.2.1-alpha.2` as `preview`; preserve Node/pnpm and other descriptors exactly |

Changing just the URL on the old source ID is insufficient: `readConfig` merges
saved source values by ID and would keep the old URL. The DSH agent owns the new
source-ID implementation and explicit old-version rollback path. `.1` data stays
in `harness-data`; the .2 migration uses independent private `harness-data-v2`.
An explicit rollback may read the old signed graph but must not change the .37
automatic channel to the legacy graph.

Both envelopes use `{keyId,algorithm,payload,signature}`, Ed25519 key ID
`runtime-production-v2-1`. Runtime module descriptors contain only
`id,version,required,installWhen,dependencies,artifacts` and optional `probe`.
Artifact hashes/sizes/mirrors are inside `artifacts[]`, not module-level fields.

## Preparation and immutable artifacts

1. Commit/review source, complete .37 online/offline/shell builds and existing
   QA. Align Node/pnpm fallback descriptors to the current signed production
   descriptors. No new Node/pnpm bytes are published in this release.
2. Run `node scripts/prepare-release-037.mjs`. It makes no external writes and
   reads no secrets. It verifies the live legacy signature, saves exact raw
   baseline catalog/alias bytes, captures the new channel's signed baseline or
   exact 404, verifies six local artifacts and the actual packaged fallback,
   then exclusively creates unsigned payloads and `release-037-plan.json`.
3. Controller reviews the plan SHA printed by preparation, signs both payloads
   using the existing external signing-key workflow. Outputs must be
   `launcher-manifest.037.legacy.json` and `launcher-manifest.037.dsh02.json`.
   Signing is never performed by these operators.
4. Set `EXPECTED_RELEASE_037_PLAN_SHA256` to the controller-reviewed digest.
   `node scripts/publish-release-037.mjs check` validates both candidate
   signatures, exact allowed payload differences, source HEAD/clean tree,
   artifact bytes and live pointer states without reading credentials.
5. Controller publishes GitHub releases/tags/assets with `gh` through the
   existing approved workflow. All six assets must be public, uploaded, and
   have matching GitHub API digest, size and anonymous full byte readback.
6. For `artifacts`, set the external `OSS_PUBLISHER_PROFILE` location and
   `CONFIRM_RELEASE_037=publish-0.10.37-artifacts`; run the publisher.
   It uploads only the six approved immutable keys, verifies OSS overwrite
   prevention, refuses differing existing bytes and reads each artifact back
   from OSS and GitHub. New replacement descriptors advertise only these
   verified OSS/GitHub mirrors, not unuploaded Gitee build outputs.

The six immutable artifacts are .37 shell, online installer, offline installer,
.2 core, matching UI and matching Host. Public installer alias/catalog objects
are not changed by the `artifacts` stage.

## Ordered pointers and real public-install gate

1. `CONFIRM_RELEASE_037=publish-0.10.37-channel` → publisher `channel`.
   It verifies all public artifacts, claims the approved baseline transition
   and writes/verifies only the new `.2` signed channel. Existing legacy
   `.1` graph and installer alias remain in place.
2. Controller downloads the **immutable public** .37 installer into an empty
   isolated directory, installs/launches it against the actual public `.2`
   channel, and verifies .37 kernel, .2 authentication, independent data
   rollback, preserved Node/pnpm, plus one bounded real-model task. Synthetic
   stub/protocol checks cannot satisfy this release gate.
3. Controller records `release/release-037-public-qa.json`, hash-binding the
   plan, channel, installer, shell and evidence files. Contract below.
4. `CONFIRM_RELEASE_037=publish-0.10.37-pointers` → publisher `pointers`.
   It revalidates artifacts, signatures, claims, QA/evidence hashes and live
   pointer baselines; writes/verifies online alias first, then writes/verifies
   the legacy catalog's `.37` launcher entry last.
5. Re-run `check`, read both public signatures and exercise the direct website
   download. Final receipts are `release-037-{stage}-receipt.json`.

QA object (each truth must be backed by the supplied evidence):

```json
{
  "schemaVersion": 1,
  "passed": true,
  "planSha256": "<reviewed plan digest>",
  "sourceCommit": "<plan commit>",
  "testedAt": "<ISO timestamp after plan>",
  "catalogUrl": "https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/dsh02/launcher-manifest.json",
  "catalogSha256": "<signed new catalog digest>",
  "sourceId": "runtime-v2-dsh02",
  "bootstrapSha256": "<online installer digest>",
  "shellSha256": "<shell digest>",
  "installedLauncherVersion": "0.10.37",
  "installedDshVersion": "0.2.1-alpha.2",
  "emptyDirectoryInstall": true,
  "realPublicDownload": true,
  "authenticatedBrowser": true,
  "legacyCatalogStillDsh01": true,
  "userDataRollback": true,
  "nodeRuntimeUnchanged": true,
  "packageManagerUnchanged": true,
  "realTask": { "kind": "real-model", "passed": true, "report": "output/<task report>.json" },
  "evidence": [{ "file": "output/<task report>.json", "size": 123, "sha256": "<report digest>" }]
}
```

Evidence paths must be ordinary local `output/` or `release/` files, never
symlinks/junctions/parent traversals. Reports must not contain tokens, cookies,
keys, authenticated startup URLs or user prompt/file contents.

## Single writer, retry and failure recovery

OSS PutObject guarantees `x-oss-forbid-overwrite`, not a documented destination
`If-Match` atomic CAS. This operator deliberately uses **cooperative
single-writer CAS**: an immutable legacy-baseline claim matching the existing
operator convention and a separate new-channel-baseline claim bind the reviewed
plan/candidate hashes; live SHA256 values are checked immediately before writes.
Do not run an uncoordinated external publisher while a claim is active. See the
[official PutObject contract](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject).

- An already-uploaded immutable artifact is accepted only when bytes match.
- An already-published pointer is accepted only when it is the exact signed
  candidate (or exact installer bytes). Another hash/status stops publication.
- Every failure preserves a receipt with observed safe state. No automatic
  deletion/rollback of new-channel objects, aliases, claims or user data occurs.
- If `.2` channel is ready but QA fails, old users remain on `.1`; repair/rebuild
  in a newly reviewed plan, or retain current plan and repeat failed acceptance.
  Never overwrite pinned artifacts to make QA pass.
- If alias is `.37` but old catalog is still `.36`, repeat `pointers` with the
  same approved plan/QA; it skips the verified alias and finishes the legacy
  launcher entry. This intermediate state is safe: the .37 installer reads only
  its `.2` channel and the old kernel still reads only the `.1` graph.
- If legacy catalog already points to `.37`, both alias and new channel must
  match the exact candidate. All retries then validate and perform no changes.
- A different public pointer/claim requires controller reconciliation with live
  evidence and a separately approved recovery plan. Do not force-overwrite it.

Operator policy regression command:
`node --test scripts/release-037-qa-node-tests.mjs`. These pure tests are not publication
or real application acceptance.
