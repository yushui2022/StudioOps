import { readFileSync } from "node:fs";
import https from "node:https";
import { resolveWarpgateConfig, warpgateDataFile } from "./warpgate-config.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY_TYPE =
  /^(ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

export interface WarpgatePublicKey {
  id: string;
  label: string;
  publicKey: string;
  addedAt?: string;
  lastUsedAt?: string;
}

export interface WarpgateKeySnapshot {
  username: string;
  userId: string;
  keys: WarpgatePublicKey[];
}

interface ApiResult<T> {
  status: number;
  body?: T;
  text: string;
}

interface RawPublicKey {
  id: string;
  label: string;
  openssh_public_key: string;
  date_added?: string;
  last_used?: string;
}

interface RawUser {
  id: string;
  username: string;
}

function readApiToken(): string | undefined {
  const file = warpgateDataFile("warpgate-api-token");
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function warpgateRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const { adminPort } = resolveWarpgateConfig();
  const token = readApiToken();
  if (!token) {
    return Promise.reject(
      new Error(
        "缺少 Warpgate API Token，请把 token 写入 StudioOps 数据目录的 warpgate-api-token",
      ),
    );
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: adminPort,
        path: `/@warpgate/admin/api${path}`,
        method,
        rejectUnauthorized: false,
        headers: {
          "X-Warpgate-Token": token,
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: T | undefined;
          try {
            parsed = text ? (JSON.parse(text) as T) : undefined;
          } catch {
            parsed = undefined;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed, text });
        });
      },
    );
    request.setTimeout(8000, () =>
      request.destroy(new Error("Warpgate API 请求超时")),
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function ensureOk<T>(result: ApiResult<T>, action: string): T {
  if (result.status >= 200 && result.status < 300) {
    if (result.body === undefined) {
      if (result.status === 204) return undefined as T;
      throw new Error(`${action}失败：Warpgate 返回空响应`);
    }
    return result.body;
  }
  if (result.status === 401) {
    throw new Error("Warpgate API Token 无效或已过期");
  }
  const detail = result.text.trim().slice(0, 300);
  throw new Error(
    `${action}失败（HTTP ${result.status}）${detail ? `：${detail}` : ""}`,
  );
}

export function normalizePublicKey(raw: string): {
  publicKey: string;
  defaultLabel?: string;
} {
  const line = raw.trim();
  if (!line) throw new Error("公钥不能为空");
  if (line.length > 8192) throw new Error("公钥内容过长");
  if (/BEGIN [A-Z ]*PRIVATE KEY|PRIVATE KEY-----/.test(line)) {
    throw new Error("这是私钥内容，请粘贴 .pub 公钥");
  }
  if (line.includes("\n")) {
    throw new Error("请粘贴单行公钥，不要包含多行");
  }
  const parts = line.split(/\s+/);
  const type = parts[0] ?? "";
  const encoded = parts[1] ?? "";
  if (!PUBLIC_KEY_TYPE.test(type) || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new Error("公钥格式不正确，应以 ssh-ed25519 或 ssh-rsa 开头");
  }
  const defaultLabel = parts.slice(2).join(" ").slice(0, 64) || undefined;
  return { publicKey: parts.join(" "), defaultLabel };
}

async function resolveUserId(username: string): Promise<string> {
  const result = await warpgateRequest<RawUser[]>("GET", "/users");
  const users = ensureOk(result, "读取 Warpgate 用户");
  const user = users.find((item) => item.username === username);
  if (!user) throw new Error(`Warpgate 用户不存在：${username}`);
  return user.id;
}

function toPublicKey(raw: RawPublicKey): WarpgatePublicKey {
  return {
    id: raw.id,
    label: raw.label,
    publicKey: raw.openssh_public_key,
    addedAt: raw.date_added,
    lastUsedAt: raw.last_used,
  };
}

export async function listWarpgateKeys(): Promise<WarpgateKeySnapshot> {
  const { user } = resolveWarpgateConfig();
  const userId = await resolveUserId(user);
  const result = await warpgateRequest<RawPublicKey[]>(
    "GET",
    `/users/${encodeURIComponent(userId)}/credentials/public-keys`,
  );
  const keys = ensureOk(result, "读取公钥");
  return { username: user, userId, keys: keys.map(toPublicKey) };
}

export async function addWarpgateKey(input: {
  label?: string;
  publicKey: string;
}): Promise<WarpgateKeySnapshot> {
  const normalized = normalizePublicKey(input.publicKey);
  const label = (
    input.label?.trim() ||
    normalized.defaultLabel ||
    "friend"
  ).slice(0, 64);
  const { user } = resolveWarpgateConfig();
  const userId = await resolveUserId(user);
  const result = await warpgateRequest(
    "POST",
    `/users/${encodeURIComponent(userId)}/credentials/public-keys`,
    {
      label,
      openssh_public_key: normalized.publicKey,
    },
  );
  ensureOk(result, "添加公钥");
  return listWarpgateKeys();
}

export async function deleteWarpgateKey(
  id: string,
): Promise<WarpgateKeySnapshot> {
  if (!UUID_PATTERN.test(id)) throw new Error("无效的公钥 ID");
  const { user } = resolveWarpgateConfig();
  const userId = await resolveUserId(user);
  const result = await warpgateRequest(
    "DELETE",
    `/users/${encodeURIComponent(userId)}/credentials/public-keys/${encodeURIComponent(id)}`,
  );
  if (result.status !== 204) ensureOk(result, "删除公钥");
  return listWarpgateKeys();
}
