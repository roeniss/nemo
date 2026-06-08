import { describe, expect, it } from "vitest";
import { foldDataUris, expandDataUris } from "../src/lib";

const big = "A".repeat(400); // >256 base64 chars → folded
const uri = `data:image/png;base64,${big}`;

describe("inline base64 folding", () => {
  it("folds a long data-URI to a short marker and round-trips exactly", () => {
    const text = `# shot\n\n![pic](${uri})\n\ntail`;
    const { display, map } = foldDataUris(text);

    expect(display).not.toContain(big); // the wall of base64 is gone from the view
    expect(display).toContain("fold:0");
    expect(display).toContain("KB"); // shows an approximate size
    expect(map).toEqual([big]);

    expect(expandDataUris(display, map)).toBe(text); // lossless
  });

  it("leaves short data-URIs and ordinary text untouched", () => {
    const tiny = "data:image/png;base64,AAAABBBB"; // well under the threshold
    const text = `# note\n\n![x](${tiny})\n\njust words`;
    const { display, map } = foldDataUris(text);
    expect(display).toBe(text);
    expect(map).toEqual([]);
  });

  it("indexes multiple folds independently so order/identity is preserved", () => {
    const a = "A".repeat(300);
    const b = "B".repeat(300);
    const text = `![a](data:image/png;base64,${a}) and ![b](data:image/jpeg;base64,${b})`;
    const { display, map } = foldDataUris(text);
    expect(map).toEqual([a, b]);
    expect(display).toContain("fold:0");
    expect(display).toContain("fold:1");
    expect(expandDataUris(display, map)).toBe(text);
  });

  it("deleting one marker drops only its image, leaving the rest intact", () => {
    const a = "A".repeat(300);
    const b = "B".repeat(300);
    const { display, map } = foldDataUris(
      `![a](data:image/png;base64,${a})\n![b](data:image/png;base64,${b})`
    );
    // user removes the first image's marker line entirely
    const edited = display.split("\n").slice(1).join("\n");
    const out = expandDataUris(edited, map);
    expect(out).toContain(b);
    expect(out).not.toContain(a);
  });

  it("expands an unknown index back to itself rather than losing data", () => {
    const stray = "data:image/png;base64,⟨🖼 1KB · fold:9⟩";
    expect(expandDataUris(stray, [])).toBe(stray);
  });
});
