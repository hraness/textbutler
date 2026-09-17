# Vendored `oh-archive-strict` WASM artifact

`oh_archive_strict_wasm.wasm` is a raw-ABI WASM build of the strict in-memory
ZIP/ZIP64 reader that ports `src/x-archive-zip.ts`'s validation contract to
Rust. `src/x-archive-zip-rust.ts` loads it as an optional fast path and falls
back to the TypeScript implementation whenever the artifact is unavailable or
a call fails, so the TypeScript reader remains authoritative.

## Provenance

- Source crate: `rust/oh-archive-strict-wasm` in the `hraness/oh` repository
  (public, `https://github.com/hraness/oh`), branch `rust-archive-foundations`.
- Implementation: `rust/oh-archive/src/strict.rs` in the same workspace.
- Build: `cargo build --release --target wasm32-unknown-unknown -p
  oh-archive-strict-wasm` with the rustup stable toolchain.
- The artifact has no imports, exports `memory`, `oh_archive_alloc`,
  `oh_archive_free`, and `oh_archive_read_strict`, and performs no network,
  filesystem, or environment access. All archive bytes and results pass
  through linear memory under the same bounds as the TypeScript reader.

## Updating

Rebuild the artifact at the exact `oh` revision being adopted, replace the
`.wasm` file, and re-run `bun run check` and the `x-archive` parity tests.
