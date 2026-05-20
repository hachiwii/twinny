import {
  DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY,
  type LarkMessageRedactionConfig,
  type LarkMessageRedactionStrategy
} from "../types.js";

export const DEFAULT_LARK_MESSAGE_REDACTION: LarkMessageRedactionConfig = {
  email: DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY,
  chinesePhoneNumber: DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY
};

const EMAIL_PATTERN = /(^|[^\w.!#$%&'*+/=?^`{|}~-])([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?![\w-])/g;
const CHINESE_PHONE_PATTERN = /(^|[^\dA-Za-z])(1[3-9]\d)(\d{4})(\d{4})(?=$|[^\dA-Za-z])/g;

export function normalizeLarkMessageRedactionConfig(
  config: Partial<LarkMessageRedactionConfig> | undefined
): LarkMessageRedactionConfig {
  return {
    email: normalizeStrategy(config?.email),
    chinesePhoneNumber: normalizeStrategy(config?.chinesePhoneNumber)
  };
}

export function redactSensitiveText(
  text: string,
  config: Partial<LarkMessageRedactionConfig> | undefined = DEFAULT_LARK_MESSAGE_REDACTION
): string {
  const normalized = normalizeLarkMessageRedactionConfig(config);
  return redactChinesePhoneNumbers(redactEmails(text, normalized.email), normalized.chinesePhoneNumber);
}

export function redactLarkMessageContent<T>(content: T, config?: Partial<LarkMessageRedactionConfig>): T {
  return redactStringValues(content, normalizeLarkMessageRedactionConfig(config)) as T;
}

function normalizeStrategy(strategy: LarkMessageRedactionStrategy | undefined): LarkMessageRedactionStrategy {
  return strategy ?? DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY;
}

function redactEmails(text: string, strategy: LarkMessageRedactionStrategy): string {
  if (strategy === "none") {
    return text;
  }
  return text.replace(EMAIL_PATTERN, (_match, prefix: string, local: string, domain: string) => {
    if (strategy === "whitespace") {
      return `${prefix}${local} @ ${domain}`;
    }
    return `${prefix}${maskEmailLocalPart(local)}@${domain}`;
  });
}

function redactChinesePhoneNumbers(text: string, strategy: LarkMessageRedactionStrategy): string {
  if (strategy === "none") {
    return text;
  }
  return text.replace(CHINESE_PHONE_PATTERN, (_match, prefix: string, first: string, middle: string, last: string) => {
    if (strategy === "whitespace") {
      return `${prefix}${first} ${middle} ${last}`;
    }
    return `${prefix}${first}****${last}`;
  });
}

function maskEmailLocalPart(local: string): string {
  if (local.length <= 2) {
    return local;
  }
  return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}`;
}

function redactStringValues(value: unknown, config: LarkMessageRedactionConfig): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, config);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStringValues(item, config));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactStringValues(childValue, config);
  }
  return result;
}
