import { encodeStellarForwardHook } from "../../src/utils/encoding.js";

export function buildBurnMessage(
  options: { forwardRecipient?: string } = {},
): `0x${string}` {
  const header = Buffer.alloc(148);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(26, 4);
  header.writeUInt32BE(27, 8);

  const body = Buffer.alloc(228);
  body.writeUInt32BE(1, 0);

  const hook =
    options.forwardRecipient === undefined
      ? Buffer.alloc(0)
      : Buffer.from(
          encodeStellarForwardHook(options.forwardRecipient).slice(2),
          "hex",
        );

  return `0x${Buffer.concat([header, body, hook]).toString("hex")}`;
}
