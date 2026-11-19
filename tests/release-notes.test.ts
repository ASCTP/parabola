import { describe, expect, it } from "vitest";
// @ts-expect-error the release script is plain JavaScript without declarations
import { extractReleaseNotes } from "../scripts/release-notes.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Pending change.

## [1.2.0] - 2026-11-01

### Added

- A feature.

## [1.1.0] - 2026-10-01

### Fixed

- A bug.
`;

describe("extractReleaseNotes", () => {
  it("returns the body of the requested version only", () => {
    const notes = extractReleaseNotes(CHANGELOG, "1.2.0");
    expect(notes).toContain("- A feature.");
    expect(notes).not.toContain("A bug.");
    expect(notes).not.toContain("Pending change.");
  });

  it("returns the final section", () => {
    expect(extractReleaseNotes(CHANGELOG, "1.1.0")).toContain("- A bug.");
  });

  it("rejects a missing version", () => {
    expect(() => extractReleaseNotes(CHANGELOG, "2.0.0")).toThrow(
      "No CHANGELOG section for version 2.0.0",
    );
  });

  it("rejects an empty section", () => {
    expect(() =>
      extractReleaseNotes("## [1.0.0] - x\n\n## [0.9.0] - y\n- a\n", "1.0.0"),
    ).toThrow("is empty");
  });
});
