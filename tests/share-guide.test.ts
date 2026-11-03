import assert from "node:assert/strict";
import test from "node:test";
import { buildModelShareGuide } from "../apps/web/share-guide.js";

test("model share guide keeps public models and blocks private video", () => {
  const text = buildModelShareGuide({
    base_url: "https://n8n.aster2025.asia/v1",
    scheduling: [
      "本机文本模型只有一个槽。拉起 qwen 会卸掉空闲的 ravenx-cyber:35b。",
      "用多了会返回 429 或 503。",
    ],
    capabilities: [
      {
        id: "text",
        title: "文本",
        public: true,
        model: "qwen3.8-27b-uncensored",
        api_key: "sk-text",
        path: "/chat/completions",
        local_model: "qwen3.8-27b-abliterated:q4km",
        context_tokens: 131072,
        example: { model: "qwen3.8-27b-uncensored", stream: true },
      },
      {
        id: "image",
        title: "文生图",
        public: true,
        model: "gpt-image-qwen-2.1",
        api_key: "sk-image",
        path: "/images/generations",
      },
      {
        id: "video",
        title: "视频",
        public: false,
        model: "minimax-h3",
        api_key: "sk-should-not-appear",
        path: "/videos/generations",
        local_base_url: "http://127.0.0.1:8192/v1",
        notes: ["不要对公网调用"],
      },
    ],
  });

  assert.match(text, /base_url: https:\/\/n8n\.aster2025\.asia\/v1/);
  assert.match(text, /model: qwen3\.8-27b-uncensored/);
  assert.match(text, /api_key: sk-text/);
  assert.match(text, /url: https:\/\/n8n\.aster2025\.asia\/v1\/chat\/completions/);
  assert.match(text, /context_tokens: 131072/);
  assert.match(text, /model: gpt-image-qwen-2\.1/);
  assert.match(text, /url: https:\/\/n8n\.aster2025\.asia\/v1\/images\/generations/);
  assert.match(text, /capability: video/);
  assert.match(text, /public: false/);
  assert.match(text, /url: http:\/\/127\.0\.0\.1:8192\/v1\/videos\/generations/);
  assert.match(text, /api_key: none/);
  assert.doesNotMatch(text, /sk-should-not-appear/);
  assert.match(text, /不要对 base_url 发这类请求/);
  assert.match(text, /local_model: qwen3\.8-27b-abliterated:q4km/);
  assert.match(text, /ravenx-cyber:35b/);
  assert.match(text, /429/);
  assert.match(text, /503/);
  assert.match(text, /400/);
});
