import { LarkOpenApiClient } from "./openapi.js";
import type { LarkLogger } from "./types.js";

export const LARK_APP_ACCESS_APPROVAL_DETAIL_FIELD_NAME = "应用详情";
export const DEFAULT_AUTO_APPROVAL_COMMENT = "Twinny 自动批准";

export interface LarkApprovalClientOptions {
  openApiClient: LarkOpenApiClient;
  logger?: LarkLogger;
}

export interface LarkApprovalTask {
  definitionCode: string;
  instanceCode: string;
  taskId: string;
  status?: string;
  supportApiOperate?: boolean;
  raw: unknown;
}

export interface LarkApprovalFormItem {
  id?: string;
  customId?: string;
  name?: string;
  type?: string;
  value?: unknown;
  raw: unknown;
}

export interface LarkApprovalInstance {
  definitionCode: string;
  instanceCode: string;
  status?: string;
  form: LarkApprovalFormItem[];
  raw: unknown;
}

export interface ListTodoApprovalTasksOptions {
  definitionCode?: string;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface ApproveApprovalTaskOptions {
  instanceCode: string;
  taskId: string;
  comment?: string;
  signal?: AbortSignal;
}

export interface AppAccessApprovalMatchOptions {
  definitionCode: string;
  appId: string;
}

export class LarkApprovalClient {
  private readonly openApiClient: LarkOpenApiClient;
  private readonly logger?: LarkLogger;

  constructor(options: LarkApprovalClientOptions) {
    this.openApiClient = options.openApiClient;
    this.logger = options.logger;
  }

  async listTodoTasks(options: ListTodoApprovalTasksOptions): Promise<LarkApprovalTask[]> {
    const tasks: LarkApprovalTask[] = [];
    let pageToken: string | undefined;

    do {
      const raw = await this.openApiClient.request("/approval/v4/tasks", {
        method: "GET",
        signal: options.signal,
        query: {
          topic: "1",
          definition_code: options.definitionCode,
          page_size: options.pageSize ?? 100,
          page_token: pageToken
        }
      });
      const data = getData(raw);
      for (const item of arrayField(data, "tasks")) {
        const task = normalizeApprovalTask(item);
        if (task) {
          tasks.push(task);
        } else {
          this.logger?.warn?.({ item }, "ignored malformed Lark approval task");
        }
      }
      pageToken = booleanField(data, "has_more") ? stringField(data, "page_token") || undefined : undefined;
    } while (pageToken);

    return tasks;
  }

  async getInstance(instanceCode: string, options: { signal?: AbortSignal } = {}): Promise<LarkApprovalInstance> {
    const raw = await this.openApiClient.request("/approval/v4/instances/detail", {
      method: "GET",
      signal: options.signal,
      query: {
        instance_code: instanceCode,
        locale: "zh-CN",
        user_id_type: "open_id"
      }
    });
    const data = getData(raw);
    return {
      definitionCode: stringField(data, "definition_code") || stringField(data, "approval_code"),
      instanceCode: stringField(data, "instance_code") || instanceCode,
      status: stringField(data, "status") || undefined,
      form: parseApprovalForm(data.form),
      raw
    };
  }

  async approveTask(options: ApproveApprovalTaskOptions): Promise<void> {
    await this.openApiClient.request("/approval/v4/tasks/pass", {
      method: "POST",
      signal: options.signal,
      body: {
        instance_code: options.instanceCode,
        task_id: options.taskId,
        comment: options.comment ?? DEFAULT_AUTO_APPROVAL_COMMENT
      }
    });
  }
}

export function isAppAccessApprovalInstance(
  instance: Pick<LarkApprovalInstance, "definitionCode" | "form">,
  options: AppAccessApprovalMatchOptions
): boolean {
  if (instance.definitionCode !== options.definitionCode) {
    return false;
  }
  return extractApprovalAppId(instance.form) === options.appId;
}

export function extractApprovalAppId(form: LarkApprovalFormItem[]): string | undefined {
  const detail = form.find((item) => item.name === LARK_APP_ACCESS_APPROVAL_DETAIL_FIELD_NAME);
  if (typeof detail?.value !== "string") {
    return undefined;
  }
  return detail.value.match(/\bcli_[A-Za-z0-9_]+\b/)?.[0];
}

export function parseApprovalForm(value: unknown): LarkApprovalFormItem[] {
  const rawItems = typeof value === "string" ? parseJsonArray(value) : Array.isArray(value) ? value : [];
  const items: LarkApprovalFormItem[] = [];
  for (const item of rawItems) {
    const record = toRecord(item);
    if (!record) {
      continue;
    }
    items.push({
      id: stringField(record, "id") || undefined,
      customId: stringField(record, "custom_id") || undefined,
      name: stringField(record, "name") || undefined,
      type: stringField(record, "type") || undefined,
      value: record.value,
      raw: item
    });
  }
  return items;
}

function normalizeApprovalTask(value: unknown): LarkApprovalTask | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  const definitionCode = stringField(record, "definition_code") || stringField(record, "approval_code");
  const instanceCode = stringField(record, "instance_code") || stringField(record, "process_code");
  const taskId = stringField(record, "task_id") || stringField(record, "id");
  if (!definitionCode || !instanceCode || !taskId) {
    return undefined;
  }
  return {
    definitionCode,
    instanceCode,
    taskId,
    status: stringField(record, "status") || undefined,
    supportApiOperate: booleanField(record, "support_api_operate"),
    raw: value
  };
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getData(raw: unknown): Record<string, unknown> {
  const record = toRecord(raw);
  const data = record?.data;
  return toRecord(data) ?? {};
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
