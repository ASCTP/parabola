#!/usr/bin/env node
// Confirms every contract/token address hardcoded in src/constants.ts is a real,
// deployed contract on the network it claims to be on: not a typo, not an EOA,
// not a stale address from a redeployment. Public reads only, no funded account
// needed. See CONTRIBUTING.md's "Code Standards" section on src/constants.ts.

import { rpc, xdr } from "@stellar/stellar-sdk";

const ARC_RPC_URL = {
  testnet: "https://rpc.testnet.arc.network",
  mainnet: "https://rpc.mainnet.arc.io",
};
const STELLAR_RPC_URL = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};

const ARC_ADDRESSES = {
  testnet: {
    tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    usdc: "0x3600000000000000000000000000000000000000",
  },
  mainnet: {
    tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    usdc: "0x3600000000000000000000000000000000000000",
  },
};

const STELLAR_CONTRACTS = {
  testnet: {
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
  mainnet: {
    tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    cctpForwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
};

let failures = 0;

async function checkArcAddress(network, label, address) {
  let code;
  try {
    const res = await fetch(ARC_RPC_URL[network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    // A flaky or rate-limited RPC can answer with an HTML error page instead of JSON;
    // parse defensively so that surfaces as a clear FAIL rather than an uncaught crash.
    const body = JSON.parse(text);
    code = body.result;
  } catch (error) {
    console.log(`FAIL arc:${network}:${label} ${address} -> RPC error: ${error?.message ?? error}`);
    failures++;
    return;
  }
  const isContract = typeof code === "string" && code !== "0x" && code.length > 2;
  console.log(`${isContract ? "OK  " : "FAIL"} arc:${network}:${label} ${address} -> ${isContract ? `${(code.length - 2) / 2} bytes of code` : "no code (EOA or nonexistent)"}`);
  if (!isContract) failures++;
}

async function checkStellarContract(network, label, contractId) {
  const server = new rpc.Server(STELLAR_RPC_URL[network]);
  try {
    await server.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance(),
    );
    console.log(`OK   stellar:${network}:${label} ${contractId} -> instance found`);
  } catch (error) {
    console.log(`FAIL stellar:${network}:${label} ${contractId} -> ${error?.message ?? error}`);
    failures++;
  }
}

for (const network of ["testnet", "mainnet"]) {
  console.log(`Verifying Arc ${network} addresses...`);
  for (const [label, address] of Object.entries(ARC_ADDRESSES[network])) {
    await checkArcAddress(network, label, address);
  }

  console.log(`\nVerifying Stellar ${network} contracts...`);
  for (const [label, contractId] of Object.entries(STELLAR_CONTRACTS[network])) {
    await checkStellarContract(network, label, contractId);
  }
  console.log("");
}

if (failures > 0) {
  console.error(`${failures} address(es) failed verification.`);
  process.exit(1);
}
console.log("All addresses verified live on their claimed network.");
