import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "api-token";
const MIN_TOKEN_LENGTH = 24;

export type ApiTokenSource = "env" | "file" | "none";

export interface ApiTokenState {
  token: string;
  source: ApiTokenSource;
  filePath: string;
}

/**
 * Load the API token. STUDIOOPS_TOKEN always wins so a user can rotate or
 * revoke a persisted token from the environment. The file is mode 0600 and is
 * deliberately excluded from exported backups.
 */
export function loadApiToken(
  dataDir: string,
  envToken = process.env.STUDIOOPS_TOKEN ?? "",
): ApiTokenState {
  const filePath = join(dataDir, TOKEN_FILE);
  if (envToken.trim())
    return { token: envToken.trim(), source: "env", filePath };
  if (!existsSync(filePath)) return { token: "", source: "none", filePath };
  const token = readFileSync(filePath, "utf8").trim();
  if (!token) return { token: "", source: "none", filePath };
  return { token, source: "file", filePath };
}

export function generateApiToken(): string {
  return `so_${randomBytes(24).toString("base64url")}`;
}

export function saveApiToken(dataDir: string, token: string): string {
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(
      `API token must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filePath = join(dataDir, TOKEN_FILE);
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return filePath;
}

export function removeApiToken(dataDir: string): void {
  rmSync(join(dataDir, TOKEN_FILE), { force: true });
}
