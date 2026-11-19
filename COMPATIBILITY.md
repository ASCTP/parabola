# Compatibility policy

This document describes what Parabola considers public API, how versions change, and which runtimes it supports.

## Public API

The public API is everything reachable through the package entry points listed in `exports` in `package.json`:

- `@asctp/parabola`
- `@asctp/parabola/execution`
- `@asctp/parabola/indexer`
- `@asctp/parabola/runtime`
- `@asctp/parabola/api`
- `@asctp/parabola/observability`
- `@asctp/parabola/conformance`
- `@asctp/parabola/providers`
- `@asctp/parabola/webhooks`

It also includes the `parabola` command line interface: command names, option names, exit codes, and the shape of `--json` output.

The HTTP routes served by `createApiServer()` and `createStoreServer()`, the webhook signature format, the metric names, and the on-disk layout of the file stores are public as well.

Anything not exported from an entry point is internal. Importing from `dist/` paths, or from files that are not listed in `exports`, is unsupported and can change in any release.

## Versioning

Parabola follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is 0, a minor release can contain breaking changes and a patch release contains only fixes. Every breaking change is marked **Breaking** in the changelog and states what to change when upgrading. Once the package reaches 1.0.0, breaking changes only ship in major releases.

The following are always breaking:

- Removing or renaming an export, a CLI command or option, an HTTP route, or a metric name.
- Narrowing an accepted type or tightening validation so that previously valid input is rejected.
- Changing the signed webhook payload or signature scheme.
- Changing the file store layout without reading the previous layout.

The following are not breaking:

- Adding an export, an optional parameter, a CLI option, a route, or a field to a JSON response.
- Adding a metric or a log field.
- Fixing behavior that contradicted the documentation.
- Raising the minimum patch level of a supported dependency.

## Supported runtimes

Parabola supports the active and maintenance Node.js LTS lines that are at or above the `engines` range in `package.json`, which is currently Node 20 and later. CI runs the full suite on Node 20 and Node 22.

Dropping support for a Node.js line is a minor release while the major version is 0 and a major release afterwards. It is announced in the changelog at least one release in advance.

Parabola publishes ESM and CommonJS builds with type declarations. TypeScript consumers should use a version that is not older than the one in `devDependencies`.

## Supported networks

Parabola supports Circle's Arc network and Stellar through CCTP V2, on mainnet and testnet. Contract addresses and domain identifiers in `src/constants.ts` are verified against live networks in CI. A change to an address or domain identifier is a release note item, because it changes where funds move.

## Deprecation

A deprecated export keeps working for at least one minor release. The deprecation is documented in the changelog and marked with a `@deprecated` JSDoc tag that names the replacement. Removal follows the versioning rules above.

## Security fixes

Security fixes ship in a patch release of the latest minor version. See [SECURITY.md](SECURITY.md) for reporting instructions.

## Releases

Maintainers cut releases from `main` by tagging a version. The publish workflow runs lint, format, typecheck, tests with coverage, and build, publishes to npm with provenance, and creates a GitHub release from the matching changelog section. The steps are listed in [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

If Parabola is useful to you, consider starring the [ASCTP/parabola](https://github.com/ASCTP/parabola) repository.
