import { describe, expect, it } from "vitest";
import { markdownImageReferences, renderLocalPathMarkdownLinksAsCode } from "./markdown.js";

describe("renderLocalPathMarkdownLinksAsCode", () => {
  it("replaces local path markdown links with inline code spans", () => {
    expect(renderLocalPathMarkdownLinksAsCode("Changed [manager.ts](/repo/src/manager.ts:42)."))
      .toBe("Changed `/repo/src/manager.ts:42`.");
  });

  it("replaces angle-bracket local path targets with inline code spans", () => {
    expect(renderLocalPathMarkdownLinksAsCode("See [My Report.md](</repo/My Report.md:3>)"))
      .toBe("See `/repo/My Report.md:3`");
  });

  it("keeps URL and anchor markdown links unchanged", () => {
    const markdown = [
      "[docs](https://example.com/docs)",
      "[mail](mailto:team@example.com)",
      "[section](#heading)"
    ].join(" ");

    expect(renderLocalPathMarkdownLinksAsCode(markdown)).toBe(markdown);
  });

  it("keeps bare domain and relative markdown links unchanged", () => {
    const markdown = [
      "[h.api.ei](code.byted.org/ehi/api)",
      "[relative](docs/readme.md)",
      "[parent](../readme.md)"
    ].join(" ");

    expect(renderLocalPathMarkdownLinksAsCode(markdown)).toBe(markdown);
  });

  it("does not rewrite markdown links inside code spans, code fences, or images", () => {
    const markdown = [
      "Inline `[file](/repo/file.ts)` stays.",
      "```",
      "[file](/repo/file.ts)",
      "```",
      "![preview](/repo/preview.png)",
      "[real](/repo/real.ts)"
    ].join("\n");

    expect(renderLocalPathMarkdownLinksAsCode(markdown)).toBe([
      "Inline `[file](/repo/file.ts)` stays.",
      "```",
      "[file](/repo/file.ts)",
      "```",
      "![preview](/repo/preview.png)",
      "`/repo/real.ts`"
    ].join("\n"));
  });
});

describe("markdownImageReferences", () => {
  it("uses markdown parser image nodes with source offsets", () => {
    const markdown = "before ![授权[二维码]](/repo/auth.png) after ![remote](https://example.com/a.png)";

    expect(markdownImageReferences(markdown)).toEqual([
      {
        altText: "授权[二维码]",
        target: "/repo/auth.png",
        start: "before ".length,
        end: "before ![授权[二维码]](/repo/auth.png)".length
      },
      {
        altText: "remote",
        target: "https://example.com/a.png",
        start: "before ![授权[二维码]](/repo/auth.png) after ".length,
        end: markdown.length
      }
    ]);
  });

  it("does not return image syntax inside markdown code", () => {
    const markdown = [
      "`![inline](/repo/inline.png)`",
      "```",
      "![block](/repo/block.png)",
      "```",
      "![real](/repo/real.png)"
    ].join("\n");

    expect(markdownImageReferences(markdown)).toEqual([
      {
        altText: "real",
        target: "/repo/real.png",
        start: markdown.indexOf("![real]"),
        end: markdown.length
      }
    ]);
  });
});
