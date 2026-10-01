# @mscd/pack-tools

Framework pack and licence tooling (build plan E.8, D-14, D-15, D-16): a library used by the server's pack installer, licence service and demo seed, and the CLI `mscd-pack`. It also holds the development keys (`dev-keys/`) and the development licences (`dev-licences/`).

| Command | What it does |
|---|---|
| `npm run build -w @mscd/pack-tools` | Compiles `src` to `dist` (also builds `@mscd/shared`, a project reference) and marks `dist/cli.js` executable |
| `npm run typecheck -w @mscd/pack-tools` | Type-checks `src` and `test` |
| `npm test -w @mscd/pack-tools` | Unit tests in `test/` (`@mscd/shared` is read from source, no build needed) |
| `node packages/pack-tools/dist/cli.js --help` | CLI help |

## CLI

Run from the repository root after `npm run build -w @mscd/pack-tools`, as `node packages/pack-tools/dist/cli.js <command>`. The `mscd-pack` name in the table is the package bin (`node_modules/.bin/mscd-pack`, or `npx mscd-pack`); it runs only once `dist/cli.js` is executable, which the package build script does, so a `dist` written by another build (for example `tsc -b` of a project that references this package) needs `node packages/pack-tools/dist/cli.js` or a package build first. Exit codes: 0 success, 1 a build, signing or verification failure (one message on standard error), 2 a usage error.

| Command | What it does |
|---|---|
| `mscd-pack keygen --out <dir> --name <name> [--force]` | Generates an Ed25519 pair: `<name>.key` (PKCS#8 PEM, mode 0600) and `<name>.pub` (SPKI PEM); prints the key id. Existing files are kept unless `--force` |
| `mscd-pack build <sourceDir> --sign-key-file <pem> --out <dir> [--reject-dev-keys]` | Builds and signs one pack source folder into `<dir>/<pack_id>-<pack_version>.pack` |
| `mscd-pack build-all --sign-key-file <pem> --out <dir> [--sources <dir>] [--reject-dev-keys]` | Builds every folder of `packs/sources` (or `--sources`); each folder name must equal its `pack_id`. All packs are built and checked before anything is written; `.pack` files in `<dir>` that no source produces any more are removed |
| `mscd-pack verify <file> --trusted <pub>... [--reject-dev-keys]` | Verifies a pack: archive rules, signature, checksums and every dataset; prints the pack id, version, key id and dataset counts |
| `mscd-pack licence sign <json> --key-file <pem> [--out <file>] [--reject-dev-keys]` | Sets `key_id`, signs the licence and prints it (or writes `--out`) |
| `mscd-pack licence verify <json> --trusted <pub>... [--reject-dev-keys]` | Verifies schema, key, signature and binding; prints the licence id, organisation, binding and validity |

`--reject-dev-keys` refuses the key ids of `dev-keys/dev-key-ids.json`, as a release build does. Used by the release image build (`build-all --reject-dev-keys`), a development key given as the `pack_signing_key` secret stops the build with a "development key" message. Without `dev-keys/dev-key-ids.json` the option exits 1 instead of running unchecked.

Development packs for `packs/dist` (git-ignored):

```bash
node packages/pack-tools/dist/cli.js build-all --sign-key-file packages/pack-tools/dev-keys/pack-signing.key --out packs/dist
```

## Pack format

`<pack_id>-<pack_version>.pack` is a gzipped tar of `manifest.json`, the 17 dataset files of E.8 (plus optional `mappings/<target>.csv`) and `signature`.

- `manifest.json`: the source manifest (every E.8 field except `datasets`) plus `datasets`, the `sha256:<hex>` of each dataset file, written with two-space indentation in the E.8 member order.
- `signature`: `ed25519:<base64 signature over the exact bytes of manifest.json>` on the first line, `key:<key id>` on the second.
- Key id: the first 16 hexadecimal characters of the SHA-256 of the public key in DER (SPKI) form (`keyId`).
- Deterministic archive: entries sorted by name, then `signature`; mtime 2026-01-01T00:00:00Z, uid and gid 0, empty user and group names, mode 0644, POSIX ustar headers, gzip level 9. Building the same sources with the same key on the same Node build gives the same bytes (Ed25519 signatures are deterministic). GNU tar and node-tar read the archives (both are tested).

## Library

```ts
import { buildPack, readPack, verifyPack, signLicence, verifyLicence, keyId, canonicalJson, DEV_KEY_IDS } from '@mscd/pack-tools';
```

| Export | Use |
|---|---|
| `buildPack(sourceDir, signingKey, {rejectKeyIds?})` | Reads a source folder (regular files only, `mappings/` the only subfolder, no `signature`), validates the manifest and every dataset with the schemas of `@mscd/shared`, writes the checksums, signs and archives. Returns `{fileName, bytes, manifest, datasets, keyId, sha256}`. `buildPackFromSource` takes the source in memory, `buildAllPacks` builds a whole sources folder |
| `readPack(buffer, limits?)` | E.8 step 1 before trusting anything: gzip only, at most `maxDecompressedBytes` (200 MiB) after gunzip, at most `maxEntries` (500) tar entries (a limit that is absent, `undefined` or `null` keeps its default; one that is not a positive safe integer throws `RangeError`, see `resolvePackLimits`), regular files only (no links, folders, devices, pax or GNU extension entries), no absolute paths, no `..` segments, no control characters or backslashes, unique names after normalisation (`.` and empty segments dropped, Unicode NFC), files only at the root or directly under `mappings/`, and exactly `manifest.json`, `signature` and the files of `manifest.datasets` |
| `verifyPack(buffer, trustedKeys, {rejectKeyIds?, limits?})` | `readPack`, then the signature with a trusted pack key (a key id in `rejectKeyIds` is refused first), the manifest schema, every checksum, and every dataset (`parsePackDatasets`). Returns the manifest, the typed dataset rows, the files and the key id |
| `parsePackDatasets(files, manifest)` | Validates the dataset set, the E.8 CSV headers, every row and JSON document with the shared schemas, and the references a pack can check on its own: unique codes, parent and catalogue requirement codes, frequencies, label keys in both languages and theme labels, required lookup domains, document template types, risk profiles of chain stages, phase names, mapping sources. Chain entity types, `engine_min_version` and installed versions are checked by the server's installer |
| `signLicence(doc, signingKey, {rejectKeyIds?})` | Sets `key_id`, signs the canonical JSON without `signature` (D-15) and checks the result against the licence schema and the binding rule |
| `verifyLicence(doc, trustedKeys, {rejectKeyIds?})` | Accepts JSON text, a buffer or an object; checks the schema, the key id, the signature and the binding rule (bound, or a trial of at most 90 days). Returns the document, key id and binding; the caller compares the bound id with its installation or organisation and derives the state from its clock |
| `keyId`, `generateSigningKeyPair`, `loadSigningKey`, `loadPublicKey`, `trustedKeysById` | Ed25519 keys. Trusted keys are key objects, PEM texts or the server's `TRUSTED_KEYS` entries `{kind, keyId, publicKeyPem}`; an entry with a `kind` is used only for that kind, so a licence key never verifies a pack (A-17), and a stated `keyId` must match its key |
| `canonicalJson` | Re-exported from `@mscd/shared` |
| `DEV_KEY_IDS` | The ids of `dev-keys/dev-key-ids.json` (an empty list when the file is absent, as in a release image) |
| `readTar`, `writeTar` | The strict tar reader and the deterministic ustar writer behind the archives (tests use `writeTar` to make hostile archives) |

Errors: `PackError` with `code` `archive`, `manifest`, `signature`, `untrusted_key`, `rejected_key`, `checksum`, `dataset`, `source` or `signing_key`; `LicenceError` with `code` `format`, `signature`, `untrusted_key`, `rejected_key`, `binding` (the server answers 422 `LIC-BINDING`) or `signing_key`. Both carry `issues`, the list of every problem found.

## Development keys and licences

`dev-keys/README.md` describes the development key pairs. `dev-licences/LIC-DEMO-NDT.json`, `-BSD`, `-RMN` and `-TST` are the licences of the demo and test organisations (G.3), bound to the fixed organisation ids `00000000-0000-4000-8000-00000000a001` to `a004` and signed with `dev-keys/licence-signing.key`. To change one, edit it and sign it again in place:

```bash
node packages/pack-tools/dist/cli.js licence sign packages/pack-tools/dev-licences/LIC-DEMO-NDT.json \
  --key-file packages/pack-tools/dev-keys/licence-signing.key --out packages/pack-tools/dev-licences/LIC-DEMO-NDT.json
```
