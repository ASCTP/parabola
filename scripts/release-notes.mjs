import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) {
    throw new Error(`No CHANGELOG section for version ${version}`);
  }
  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ["),
  );
  if (end === -1) {
    end = lines.length;
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  if (body === "") {
    throw new Error(`CHANGELOG section for version ${version} is empty`);
  }
  return body;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/release-notes.mjs <version>");
    process.exit(1);
  }
  try {
    process.stdout.write(
      `${extractReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), version)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
