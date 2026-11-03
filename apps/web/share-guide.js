/**
 * Build a copy-paste model guide for another person's coding agent.
 * The profile lives in share.local.json and is never committed.
 */

function line(value) {
  return value == null || value === "" ? "—" : String(value);
}

function bulletList(items, indent = "  ") {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

function exampleBlock(example) {
  if (!example || typeof example !== "object") return "";
  return ["  example: |", ...JSON.stringify(example, null, 2).split("\n").map((row) => `    ${row}`)].join(
    "\n",
  );
}

export function buildModelShareGuide(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("缺少模型分享配置");
  }
  const baseUrl = line(profile.base_url);
  const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  const scheduling = Array.isArray(profile.scheduling) ? profile.scheduling : [];
  const sections = capabilities.map((item) => {
    const publicCall = item.public === true;
    const endpointBase = publicCall ? baseUrl : line(item.local_base_url);
    const lines = [
      `- capability: ${line(item.id)}`,
      `  title: ${line(item.title)}`,
      `  public: ${publicCall ? "true" : "false"}`,
      `  model: ${line(item.model)}`,
      `  api_key: ${publicCall ? line(item.api_key) : "none"}`,
      `  method: ${line(item.method || "POST")}`,
      `  url: ${endpointBase.replace(/\/$/, "")}${item.path || ""}`,
    ];
    if (item.local_model) lines.push(`  local_model: ${line(item.local_model)}`);
    if (item.context_tokens) lines.push(`  context_tokens: ${item.context_tokens}`);
    if (item.quota) lines.push(`  quota: ${item.quota}`);
    const notes = bulletList(item.notes);
    if (notes) lines.push("  notes:", notes);
    const example = exampleBlock(item.example);
    if (example) lines.push(example);
    return lines.join("\n");
  });

  return `把这份说明原样交给编程 Agent。按字段调用，不要改模型名，不要混用 Key。

provider: openai-compatible
base_url: ${baseUrl}
where: 请求先到香港 VPS 的 Sub2API，再转发到上海 Mac Studio。模型在 Mac 上运行。

rules:
- Base URL 必须以 /v1 结尾。客户端会自己补具体路径。
- model 必须与下面的 model 字段完全一致，不要加前缀，不要换成别的名字。
- 每把 api_key 只能调用自己的 capability。用文本 Key 调出图会被拒绝，反过来也一样。
- public: false 的能力没有公网入口。不要对 base_url 发这类请求。
- 超额返回 429。队列满也可能返回 429。内存不够返回 503。上下文超过窗口返回 400。

scheduling:
${scheduling.map((item) => `- ${item}`).join("\n")}

capabilities:
${sections.join("\n")}
`;
}
