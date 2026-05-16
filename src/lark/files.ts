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

export interface UploadLarkImageParams {
  filePath: string;
  fileName?: string;
  contentType?: string;
}

export interface UploadLarkFileParams {
  filePath: string;
  fileName?: string;
  fileType?: string;
  contentType?: string;
  durationMs?: number;
}

export interface UploadedLarkImage {
  imageKey: string;
  raw: unknown;
}

export interface UploadedLarkFile {
  fileKey: string;
  raw: unknown;
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
    const { fileName: uniqueFileName, filePath } = await uniqueFileDestination(params.outputDir, fileName);
    await fs.writeFile(filePath, response.body);
    return {
      resourceType: params.resourceType,
      fileKey: params.fileKey,
      fileName: uniqueFileName,
      path: filePath,
      size: response.body.byteLength,
      contentType: response.contentType
    };
  }

  async uploadImage(params: UploadLarkImageParams): Promise<UploadedLarkImage> {
    const fileName = sanitizeFileName(params.fileName ?? path.basename(params.filePath));
    const body = await fs.readFile(params.filePath);
    const raw = await this.options.openApiClient.uploadMultipart(
      "/im/v1/images",
      { image_type: "message" },
      [
        {
          fieldName: "image",
          fileName,
          body,
          contentType: params.contentType ?? contentTypeForFileName(fileName)
        }
      ]
    );
    const imageKey = extractNestedString(raw, "data", "image_key");
    if (!imageKey) {
      throw new Error("Lark image upload response did not include image_key");
    }
    return { imageKey, raw };
  }

  async uploadFile(params: UploadLarkFileParams): Promise<UploadedLarkFile> {
    const fileName = sanitizeFileName(params.fileName ?? path.basename(params.filePath));
    const body = await fs.readFile(params.filePath);
    const raw = await this.options.openApiClient.uploadMultipart(
      "/im/v1/files",
      {
        file_type: params.fileType ?? larkFileTypeForFileName(fileName),
        file_name: fileName,
        duration: params.durationMs
      },
      [
        {
          fieldName: "file",
          fileName,
          body,
          contentType: params.contentType ?? contentTypeForFileName(fileName)
        }
      ]
    );
    const fileKey = extractNestedString(raw, "data", "file_key");
    if (!fileKey) {
      throw new Error("Lark file upload response did not include file_key");
    }
    return { fileKey, raw };
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

async function uniqueFileDestination(outputDir: string, fileName: string): Promise<{ fileName: string; filePath: string }> {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? fileName : `${stem}(${suffix})${extension}`;
    const filePath = path.join(outputDir, candidate);
    if (!(await pathExists(filePath))) {
      return { fileName: candidate, filePath };
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

function contentTypeForFileName(fileName: string): string | undefined {
  switch (path.extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    default:
      return undefined;
  }
}

function larkFileTypeForFileName(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".opus":
      return "opus";
    case ".mp4":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

function extractNestedString(value: unknown, ...pathSegments: string[]): string | undefined {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() !== "" ? current : undefined;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
