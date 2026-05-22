import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionLarkAssetImageKeys } from "./lark-assets.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("provisionLarkAssetImageKeys", () => {
  it("uploads missing logo and banner image keys and caches them under runtime", async () => {
    const home = await tempHome();
    const uploader = {
      uploadImage: vi
        .fn()
        .mockResolvedValueOnce({ imageKey: "img_logo" })
        .mockResolvedValueOnce({ imageKey: "img_banner" })
    };

    const result = await provisionLarkAssetImageKeys({
      cacheFile: path.join(home, "runtime", "lark-assets.json"),
      logoFilePath: "/repo/configs/logo.png",
      bannerFilePath: "/repo/configs/banner.png",
      uploader
    });

    expect(result).toEqual({ logoImageKey: "img_logo", bannerImageKey: "img_banner" });
    expect(uploader.uploadImage).toHaveBeenNthCalledWith(1, {
      filePath: "/repo/configs/logo.png",
      fileName: "logo.png",
      contentType: "image/png"
    });
    expect(uploader.uploadImage).toHaveBeenNthCalledWith(2, {
      filePath: "/repo/configs/banner.png",
      fileName: "banner.png",
      contentType: "image/png"
    });
    await expect(fs.readFile(path.join(home, "runtime", "lark-assets.json"), "utf8")).resolves.toContain("img_banner");
  });

  it("reuses cached image keys without uploading again", async () => {
    const home = await tempHome();
    const cacheFile = path.join(home, "runtime", "lark-assets.json");
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        version: 1,
        assets: {
          logo: { imageKey: "img_cached_logo" },
          banner: { imageKey: "img_cached_banner" }
        }
      })
    );
    const uploader = { uploadImage: vi.fn() };

    await expect(
      provisionLarkAssetImageKeys({
        cacheFile,
        logoFilePath: "/repo/configs/logo.png",
        bannerFilePath: "/repo/configs/banner.png",
        uploader
      })
    ).resolves.toEqual({
      logoImageKey: "img_cached_logo",
      bannerImageKey: "img_cached_banner"
    });
    expect(uploader.uploadImage).not.toHaveBeenCalled();
  });

  it("continues when one asset upload fails", async () => {
    const home = await tempHome();
    const logger = { warn: vi.fn() };
    const uploader = {
      uploadImage: vi
        .fn()
        .mockRejectedValueOnce(new Error("upload failed"))
        .mockResolvedValueOnce({ imageKey: "img_banner" })
    };

    await expect(
      provisionLarkAssetImageKeys({
        cacheFile: path.join(home, "runtime", "lark-assets.json"),
        logoFilePath: "/repo/configs/logo.png",
        bannerFilePath: "/repo/configs/banner.png",
        uploader,
        logger
      })
    ).resolves.toEqual({ bannerImageKey: "img_banner" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ asset: "logo" }),
      "failed to upload lark asset image; continuing without it"
    );
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-lark-assets-"));
  tempDirs.push(dir);
  return dir;
}
