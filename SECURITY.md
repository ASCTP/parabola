# Security Policy

Parabola is a client-side SDK: it never holds funds or private keys, but it does construct the transactions that move real USDC once a developer signs them. A bug in address encoding, precision conversion, or contract routing can send funds to the wrong place or the wrong amount. Treat this class of bug seriously even though the SDK itself is non-custodial.

---

## Supported Versions

| Version       | Supported |
| -------------- | --------- |
| `main` branch  | Yes       |
| Latest npm tag | Yes       |
| All others     | No        |

---

## Scope

### In scope

- **Address encoding** (`src/utils/encoding.ts`) — anything that could cause a Stellar `G...`/`C...` address or an Arc `0x...` address to resolve to the wrong bytes32 recipient.
- **Precision conversion** (`src/utils/encoding.ts`, `src/utils/amount.ts`) — rounding, truncation, or overflow bugs converting between Stellar's 7-decimal and Arc's 6-decimal USDC.
- **CctpForwarder / hook routing** (`src/chains/stellar.ts`, `src/chains/arc.ts`) — anything that could route an inbound Stellar transfer around `CctpForwarder`, or mis-encode the forward-recipient hook.
- **Hardcoded contract addresses and domain IDs** (`src/constants.ts`) — an incorrect address here sends real funds to the wrong contract.
- **Signing logic** (`ArcSigner` / `StellarSigner` handling) — anything that could leak key material or sign a transaction other than the one the developer intended.
- **Dependency vulnerabilities** in `viem` or `@stellar/stellar-sdk` that affect transaction construction or signing.

### Out of scope

- Vulnerabilities in Circle's Iris service, CCTP contracts, or Arc/Stellar infrastructure themselves — report those to Circle, Arc, or the Stellar Development Foundation directly.
- Issues that only manifest with a compromised developer environment (e.g. a already-stolen private key).
- Theoretical findings with no demonstrated path to fund loss or key exposure.

---

## How to Report

**Do not open a public GitHub issue for a security vulnerability.**

Use [GitHub's private vulnerability reporting](https://github.com/ASCTP/parabola/security/advisories/new) for this repository. Include:

- A description of the vulnerability and where it lives (file/function)
- Steps to reproduce, ideally as a failing test case
- Impact: what an attacker or a buggy caller could cause (wrong recipient, wrong amount, fund loss, key exposure)
- Whether the finding applies to Arc, Stellar, or both
- A suggested fix, if you have one (optional)

If you don't receive an acknowledgement within 72 hours, open a [GitHub Discussion](https://github.com/ASCTP/parabola/discussions) (Q&A category, marked private) as a follow-up.

---

## Severity Guidance

| Severity     | Examples                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| **Critical** | Encoding or precision bug that misdirects or destroys funds on mainnet   |
| **High**     | Same class of bug, demonstrated on testnet with a clear path to mainnet  |
| **Medium**   | Incorrect fee estimation, polling logic that could cause a stuck transfer |
| **Low**      | Non-exploitable input validation gaps, misleading error messages          |

A hardcoded contract address or domain ID that's wrong is always at least **High** severity, regardless of whether Arc mainnet exists yet, because that mistake pattern is exactly what would cause fund loss the day it does.

---

## Disclosure Policy

We follow coordinated disclosure: report privately, allow time for a fix, and we'll credit you in the advisory and release notes unless you ask to stay anonymous. Parabola does not currently offer a paid bug bounty.

## Networks

Parabola supports both Arc and Stellar mainnet and testnet, selected by the `network` parameter, which defaults to `"mainnet"`. Mainnet transfers move real USDC. Encoding, precision, and address-validation bugs are the class most likely to cause real fund loss, so please report them under this policy regardless of which network you found them on.
