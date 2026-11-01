import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function appBundlePath(command: string): string | undefined {
  const match = command.match(/^(.+?\.app)(?:\/|$)/);
  if (!match?.[1]) return undefined;
  try {
    return statSync(match[1]).isDirectory() ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves process icons lazily and caches the PNGs under the data directory.
 * Only app bundle paths discovered from the process table can be requested.
 */
export class ProcessIconStore {
  private readonly iconDir: string;
  private readonly paths = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(dataDir: string) {
    this.iconDir = join(dataDir, "icons");
    mkdirSync(this.iconDir, { recursive: true });
  }

  register(command: string): string | undefined {
    const appPath = appBundlePath(command);
    if (!appPath) return undefined;
    const key = createHash("sha1").update(appPath).digest("hex").slice(0, 16);
    this.paths.set(key, appPath);
    return `/icons/${key}.png`;
  }

  async icon(key: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{16}$/.test(key)) return undefined;
    const appPath = this.paths.get(key);
    if (!appPath) return undefined;
    const cached = join(this.iconDir, `${key}.png`);
    if (existsSync(cached)) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.build(key, appPath, cached);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  private async build(
    key: string,
    appPath: string,
    output: string,
  ): Promise<string | undefined> {
    const temporary = join(this.iconDir, `${key}.tmp-${process.pid}.png`);
    const resized = join(this.iconDir, `${key}.tmp-${process.pid}-s.png`);
    try {
      const icns = await this.findIcns(appPath);
      if (icns) {
        await execFileAsync("sips", [
          "-s",
          "format",
          "png",
          "-Z",
          "64",
          icns,
          "--out",
          temporary,
        ]);
      } else {
        await this.renderWithAppKit(appPath, temporary);
        if (existsSync(temporary))
          await execFileAsync("sips", [
            "-Z",
            "64",
            temporary,
            "--out",
            resized,
          ]);
      }
      const source = existsSync(resized) ? resized : temporary;
      if (!existsSync(source)) return undefined;
      renameSync(source, output);
      return output;
    } catch {
      return undefined;
    } finally {
      rmSync(temporary, { force: true });
      rmSync(resized, { force: true });
    }
  }

  private async findIcns(appPath: string): Promise<string | undefined> {
    const resources = join(appPath, "Contents", "Resources");
    const candidates: string[] = [];
    try {
      const name = await execFileAsync("plutil", [
        "-extract",
        "CFBundleIconFile",
        "raw",
        "-o",
        "-",
        join(appPath, "Contents", "Info.plist"),
      ]);
      const icon = name.stdout.trim();
      if (icon) {
        candidates.push(join(resources, icon));
        if (!icon.endsWith(".icns"))
          candidates.push(join(resources, `${icon}.icns`));
      }
    } catch {
      // Bundle may use Assets.car without CFBundleIconFile.
    }
    for (const name of ["AppIcon.icns", "app.icns", "icon.icns"]) {
      candidates.push(join(resources, name));
    }
    try {
      for (const file of readdirSync(resources))
        if (file.endsWith(".icns")) candidates.push(join(resources, file));
    } catch {
      // No Resources directory.
    }
    return candidates.find((candidate) => existsSync(candidate));
  }

  private async renderWithAppKit(
    appPath: string,
    output: string,
  ): Promise<void> {
    const script = `
      ObjC.import("AppKit");
      var image = $.NSWorkspace.sharedWorkspace.iconForFile(${JSON.stringify(appPath)});
      var rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
      var data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      data.writeToFileAtomically(${JSON.stringify(output)}, true);
    `;
    await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 8000,
    });
  }
}
