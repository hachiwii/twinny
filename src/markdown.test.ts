import { describe, expect, it } from "vitest";
import { renderLocalPathMarkdownLinksAsCode } from "./markdown.js";

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
