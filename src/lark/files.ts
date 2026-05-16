import fs from "node:fs/promises";
import path from "node:path";
import type { DownloadedLarkFile, IncomingLarkMessageResource } from "../types.js";
import { LarkOpenApiClient } from "./openapi.js";

export interface LarkFileDownloaderOptions {
  openApiClient: LarkOpenApiClient;
}

export interface DownloadLarkMessageResourceParams extends IncomingLarkMessageResource {
  messageId: string;
  outputDir: string;
}

export class LarkFileDownloader {
  constructor(private readonly options: LarkFileDownloaderOptions) {}

  async downloadMessageResource(params: DownloadLarkMessageResourceParams): Promise<DownloadedLarkFile> {
    const response = await this.options.openApiClient.download(
      `/im/v1/messages/${encodePathSegment(params.messageId)}/resources/${encodePathSegment(params.fileKey)}`,
      {
        method: "GET",
        query: {
          type: params.resourceType
        }
      }
    );
    await fs.mkdir(params.outputDir, { recursive: true });
    const fileName = buildFileName(params, response.contentType, response.contentDisposition);
    const filePath = path.join(params.outputDir, fileName);
    await fs.writeFile(filePath, response.body);
    return {
      resourceType: params.resourceType,
      fileKey: params.fileKey,
      fileName,
      path: filePath,
      contentType: response.contentType
    };
  }
}

function buildFileName(
  params: IncomingLarkMessageResource,
  contentType: string | undefined,
  contentDisposition: string | undefined
): string {
  const dispositionFileName = filenameFromContentDisposition(contentDisposition);
  const baseName = sanitizeFileName(params.fileName ?? dispositionFileName ?? params.fileKey);
  if (path.extname(baseName)) {
    return baseName;
  }
  return `${baseName}${extensionForContentType(contentType)}`;
}

function filenameFromContentDisposition(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) {
    return undefined;
  }
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const asciiMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return asciiMatch?.[1];
}

function sanitizeFileName(value: string): string {
  const name = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return name && name !== "." && name !== ".." ? name : "lark_file";
}

function extensionForContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
