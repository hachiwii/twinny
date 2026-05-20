import { describe, expect, it } from "vitest";
import { redactLarkMessageContent, redactSensitiveText } from "./redactor.js";

describe("Lark message redactor", () => {
  it("masks email and Chinese phone numbers by default", () => {
    expect(redactSensitiveText("contact alice.smith@example.com or 13812345678")).toBe(
      "contact a*********h@example.com or 138****5678"
    );
  });

  it("can whitespace email and Chinese phone numbers", () => {
    expect(
      redactSensitiveText("contact alice.smith@example.com or 13812345678", {
        email: "whitespace",
        chinesePhoneNumber: "whitespace"
      })
    ).toBe("contact alice.smith @ example.com or 138 1234 5678");
  });

  it("can disable individual detectors", () => {
    expect(
      redactSensitiveText("contact alice.smith@example.com or 13812345678", {
        email: "none",
        chinesePhoneNumber: "mask"
      })
    ).toBe("contact alice.smith@example.com or 138****5678");
  });

  it("redacts every string value in Lark content without mutating the input object", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: "联系 alice@example.com 13812345678",
            behaviors: [
              {
                type: "callback",
                value: {
                  email: "alice@example.com",
                  phone: "13812345678"
                }
              }
            ]
          }
        ]
      }
    };

    expect(redactLarkMessageContent(card)).toEqual({
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: "联系 a***e@example.com 138****5678",
            behaviors: [
              {
                type: "callback",
                value: {
                  email: "a***e@example.com",
                  phone: "138****5678"
                }
              }
            ]
          }
        ]
      }
    });
    expect(card.body.elements[0]!.content).toBe("联系 alice@example.com 13812345678");
  });
});
