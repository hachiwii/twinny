import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

type LarkAssetLogger = Pick<Logger, "warn">;

export interface LarkAssetImageKeys {
  logoImageKey?: string;
  bannerImageKey?: string;
}

export interface LarkAssetImageUploader {
  uploadImage(params: { filePath: string; fileName?: string; contentType?: string }): Promise<{ imageKey: string; raw?: unknown }>;
}

export interface ProvisionLarkAssetImageKeysOptions {
  cacheFile: string;
  logoFilePath: string;
  bannerFilePath: string;
  uploader: LarkAssetImageUploader;
  logger?: LarkAssetLogger;
}

type LarkAssetName = "logo" | "banner";

interface StoredLarkAsset {
  imageKey?: string;
  updatedAt?: string;
}

interface StoredLarkAssetsFile {
  version?: number;
  assets?: Partial<Record<LarkAssetName, StoredLarkAsset>>;
}

const ASSET_UPLOADS: Record<LarkAssetName, { fileName: string; contentType: string; resultKey: keyof LarkAssetImageKeys }> = {
  logo: { fileName: "logo.png", contentType: "image/png", resultKey: "logoImageKey" },
  banner: { fileName: "banner.png", contentType: "image/png", resultKey: "bannerImageKey" }
};

export async function provisionLarkAssetImageKeys(options: ProvisionLarkAssetImageKeysOptions): Promise<LarkAssetImageKeys> {
  const cache = await readStoredLarkAssetsFile(options.cacheFile, options.logger);
  const result: LarkAssetImageKeys = {};

  await provisionOneAsset("logo", options.logoFilePath, cache, result, options);
  await provisionOneAsset("banner", options.bannerFilePath, cache, result, options);

  return result;
}

async function provisionOneAsset(
  name: LarkAssetName,
  filePath: string,
  cache: StoredLarkAssetsFile,
  result: LarkAssetImageKeys,
  options: ProvisionLarkAssetImageKeysOptions
): Promise<void> {
  const upload = ASSET_UPLOADS[name];
  const existingImageKey = normalizeImageKey(cache.assets?.[name]?.imageKey);
  if (existingImageKey) {
    result[upload.resultKey] = existingImageKey;
    return;
  }

  try {
    const uploaded = await options.uploader.uploadImage({
      filePath,
      fileName: upload.fileName,
      contentType: upload.contentType
    });
    const imageKey = normalizeImageKey(uploaded.imageKey);
    if (!imageKey) {
      throw new Error(`Lark ${name} image upload response did not include image_key`);
    }
    result[upload.resultKey] = imageKey;
    cache.version = 1;
    cache.assets = {
      ...(cache.assets ?? {}),
      [name]: {
        imageKey,
        updatedAt: new Date().toISOString()
      }
    };
    await writeStoredLarkAssetsFile(options.cacheFile, cache, options.logger);
  } catch (error) {
    options.logger?.warn?.({ error, asset: name, filePath }, "failed to upload lark asset image; continuing without it");
  }
}

async function readStoredLarkAssetsFile(cacheFile: string, logger: LarkAssetLogger | undefined): Promise<StoredLarkAssetsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(cacheFile, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      logger?.warn?.({ error, cacheFile }, "failed to read lark asset image key cache; continuing with empty cache");
    }
    return { version: 1, assets: {} };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { version: 1, assets: {} };
    }
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      assets: parseStoredAssets(parsed.assets)
    };
  } catch (error) {
    logger?.warn?.({ error, cacheFile }, "failed to parse lark asset image key cache; continuing with empty cache");
    return { version: 1, assets: {} };
  }
}

async function writeStoredLarkAssetsFile(
  cacheFile: string,
  cache: StoredLarkAssetsFile,
  logger: LarkAssetLogger | undefined
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempFile, cacheFile);
  } catch (error) {
    logger?.warn?.({ error, cacheFile }, "failed to write lark asset image key cache; continuing with in-memory keys");
  }
}

function parseStoredAssets(value: unknown): Partial<Record<LarkAssetName, StoredLarkAsset>> {
  if (!isRecord(value)) {
    return {};
  }
  return {
    logo: parseStoredAsset(value.logo),
    banner: parseStoredAsset(value.banner)
  };
}

function parseStoredAsset(value: unknown): StoredLarkAsset | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const imageKey = normalizeImageKey(value.imageKey);
  return imageKey ? { imageKey } : undefined;
}

function normalizeImageKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
