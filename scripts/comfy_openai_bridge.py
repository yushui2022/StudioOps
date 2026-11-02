#!/usr/bin/env python3
"""ComfyUI -> OpenAI Images API 桥

把 ComfyUI 的出图能力包装成 OpenAI 兼容的 /v1/images/generations，
供 Sub2API 之类只认 OpenAI 协议的网关转发。

只依赖标准库。监听 127.0.0.1:8190。

支持模型（改 MODELS 即可扩展）：
  qwen-image-2.1  -> qwen_image_2.1_int8_convrot.safetensors
  noctq-v4        -> NoctQ_V4_int8_convrot.safetensors   (同一套工作流)
"""

import base64
import email
import json
import os
import random
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
LISTEN_HOST = os.environ.get("BRIDGE_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("BRIDGE_PORT", "8190"))

CLIP_NAME = "qwen3vl_8b_int8_convrot.safetensors"
VAE_NAME = "qwen_image_2.1_vae_bf16.safetensors"

# 注意：Sub2API 的 /v1/images/generations 只认 gpt-image-* 或 grok-imagine 开头的
# 模型名，而且会同时校验「渠道映射后的名字」和「上游模型名」。所以对外名字必须
# 是 gpt-image-*，这里用 gpt-image-local 作为主名。
TURBO_UNET = "qwen_image_2.1_turbo_int8_convrot.safetensors"

MODELS = {
    # 对外主名也走 turbo 内核：8 步 sigma 调度，比 base 25 步快 3–5 倍，
    # 画质差距很小，但 2048 双图编辑从 64 分钟降到 5 分钟。
    "gpt-image-qwen-2.1": {
        "unet": TURBO_UNET,
        "steps": 8,
        "engine": "sigmas",
        "cfg": 8.0,
    },
    # Turbo：官方 8 步 sigma 调度，同等参数下比 base 快 3 倍以上
    "gpt-image-qwen-2.1-turbo": {
        "unet": "qwen_image_2.1_turbo_int8_convrot.safetensors",
        "steps": 8,
        "engine": "sigmas",
        "cfg": 8.0,
    },
    "gpt-image-local": {          # 旧名，保留兼容（同样走 turbo）
        "unet": TURBO_UNET,
        "steps": 8,
        "engine": "sigmas",
        "cfg": 8.0,
    },
    "gpt-image-noctq": {
        "unet": "NoctQ_V4_int8_convrot.safetensors",
        "steps": 25,
        "engine": "sampler",
    },
    # 直连时的别名（不经过 Sub2API 时可用）
    "qwen-image-2.1": {
        "unet": TURBO_UNET,
        "steps": 8,
        "engine": "sigmas",
        "cfg": 8.0,
    },
}

# Qwen-Image 2.1 Turbo 官方 sigma 调度（8 步）
TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"

# 单张图最长等待时间（秒）。2048 + 多张参考图的编辑可能超过 20 分钟。
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT", "3600"))


def _base_nodes(unet):
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": CLIP_NAME, "type": "qwen_image",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_NAME}},
        "6": {"class_type": "QwenImage21Cache",
              "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
    }


def _add_sampler(wf, spec, positive, negative, latent, seed, steps, cfg):
    """按模型引擎接采样：普通 KSampler 或 turbo 的 8 步自定义 sigma。"""
    if spec.get("engine") == "sigmas":
        wf["10"] = {"class_type": "CFGGuider",
                    "inputs": {"model": ["6", 0], "positive": positive,
                               "negative": negative, "cfg": float(spec.get("cfg", 8.0))}}
        wf["11"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
        wf["12"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
        wf["13"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": TURBO_SIGMAS}}
        wf["14"] = {"class_type": "SamplerCustomAdvanced",
                    "inputs": {"noise": ["11", 0], "guider": ["10", 0],
                               "sampler": ["12", 0], "sigmas": ["13", 0],
                               "latent_image": latent}}
        return ["14", 0]
    wf["7"] = {"class_type": "KSampler",
               "inputs": {"model": ["6", 0], "positive": positive,
                          "negative": negative, "latent_image": latent,
                          "seed": seed, "steps": steps, "cfg": cfg,
                          "sampler_name": "euler", "scheduler": "simple",
                          "denoise": 1.0}}
    return ["7", 0]


def _tail_nodes(wf, sample_link, prefix):
    wf["8"] = {"class_type": "VAEDecode",
               "inputs": {"samples": sample_link, "vae": ["3", 0]}}
    wf["9"] = {"class_type": "SaveImage",
               "inputs": {"images": ["8", 0],
                          "filename_prefix": f"{prefix}_{int(time.time())}"}}
    return wf


def build_workflow(spec, prompt, negative="", width=1024, height=1024,
                   steps=8, cfg=1.0, seed=0, prefix="api"):
    wf = _base_nodes(spec["unet"])
    wf["4"] = {"class_type": "TextEncodeQwenImage21",
               "inputs": {"clip": ["2", 0], "prompt": prompt,
                          "negative_prompt": negative, "resolution": 1024}}
    wf["5"] = {"class_type": "EmptyLatentImage",
               "inputs": {"width": width, "height": height, "batch_size": 1}}
    sample = _add_sampler(wf, spec, ["4", 0], ["4", 1], ["5", 0], seed, steps, cfg)
    return _tail_nodes(wf, sample, prefix)


def comfy_post(path, payload):
    req = urllib.request.Request(
        COMFY + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode())


def comfy_get(path):
    return json.loads(urllib.request.urlopen(COMFY + path, timeout=60).read().decode())


def wait_and_fetch(prompt_id):
    """轮询直到出图，返回 PNG 字节列表。"""
    deadline = time.time() + JOB_TIMEOUT
    while time.time() < deadline:
        try:
            hist = comfy_get(f"/history/{prompt_id}")
        except Exception:
            time.sleep(1.5)
            continue
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status") or {}
            if status.get("status_str") == "error":
                msgs = json.dumps(status.get("messages"), ensure_ascii=False)[:400]
                raise RuntimeError(f"ComfyUI 执行失败: {msgs}")
            imgs = (entry.get("outputs") or {}).get("9", {}).get("images", [])
            if not imgs:
                raise RuntimeError("ComfyUI 没有返回图片")
            out = []
            for im in imgs:
                q = urllib.parse.urlencode({
                    "filename": im["filename"],
                    "subfolder": im.get("subfolder", ""),
                    "type": im.get("type", "output"),
                })
                out.append(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=120).read())
            return out
        time.sleep(1.5)
    raise RuntimeError(f"等待出图超时（{JOB_TIMEOUT}s）")


def parse_size(size, default=(1024, 1024)):
    if not size or "x" not in str(size):
        return default
    try:
        w, h = str(size).lower().split("x")
        return int(w), int(h)
    except Exception:
        return default


def parse_multipart(body, content_type):
    """解析 multipart/form-data，返回 (普通字段 dict, [(字段名, 文件名, mime, 字节)])。"""
    msg = email.message_from_bytes(
        b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    fields, files = {}, []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        disp = part.get("Content-Disposition") or ""
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename:
            files.append((name, filename, part.get_content_type(), payload))
        elif name:
            fields[name] = payload.decode("utf-8", "ignore")
    return fields, files


def upload_image(name, data, mime="image/png"):
    """把图片传到 ComfyUI 的 input 目录，返回可给 LoadImage 用的文件名。"""
    boundary = "----bridge" + uuid.uuid4().hex
    safe_name = f"api_{int(time.time()*1000)}_{name}".replace("/", "_")
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="image"; filename="{safe_name}"\r\n'.encode()
    body += f"Content-Type: {mime}\r\n\r\n".encode()
    body += data + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        COMFY + "/upload/image", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    r = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
    sub = r.get("subfolder") or ""
    return f"{sub}/{r['name']}" if sub else r["name"]


# 参考图的编码分辨率上限。编码成本随分辨率平方增长（2048 双图实测 451 秒
# 还没编完），而参考图只是条件输入，压到 1024 肉眼几乎无差别。
REF_RESOLUTION_CAP = int(os.environ.get("REF_RESOLUTION_CAP", "1024"))


def build_edit_workflow(spec, image_names, prompt, negative="",
                        width=1024, height=1024, steps=8, cfg=1.0, seed=0,
                        prefix="api_edit"):
    """Qwen-Image-Edit：参考图走 TextEncodeQwenImage21 的 images.image_N 插槽。

    参考图按 REF_RESOLUTION_CAP 编码（便宜），输出尺寸由 width/height 决定：
    输出大于参考图编码尺寸时，改用 EmptyLatentImage，把两者解耦。
    """
    wf = _base_nodes(spec["unet"])
    out_side = max(width, height)
    ref_res = min(out_side, REF_RESOLUTION_CAP)
    enc = {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
           "negative_prompt": negative, "resolution": ref_res}
    for i, fname in enumerate(image_names[:12], start=1):
        node_id = f"img{i}"
        wf[node_id] = {"class_type": "LoadImage", "inputs": {"image": fname}}
        enc[f"images.image_{i}"] = [node_id, 0]
    wf["5"] = {"class_type": "TextEncodeQwenImage21", "inputs": enc}

    if out_side > ref_res:
        # 参考图已压小，输出用独立空 latent 保持高分辨率
        wf["15"] = {"class_type": "EmptyLatentImage",
                    "inputs": {"width": width, "height": height, "batch_size": 1}}
        latent = ["15", 0]
    else:
        latent = ["5", 2]
    sample = _add_sampler(wf, spec, ["5", 0], ["5", 1], latent, seed, steps, cfg)
    return _tail_nodes(wf, sample, prefix)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 每个响应后关连接：Sub2API 会复用连接，一旦有未读完的 body
        # （比如探测请求）就会把下一个请求行解析错，必须避免。
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _read_body(self):
        """始终按 Content-Length 读完 body，避免残留字节污染下一个请求。"""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/v1/models", "/models"):
            data = [{"id": m, "object": "model", "owned_by": "local-comfyui",
                     "created": 0, "type": "image"} for m in MODELS]
            return self._send(200, {"object": "list", "data": data})
        if path in ("/health", "/"):
            return self._send(200, {"status": "ok", "comfy": COMFY,
                                    "models": list(MODELS)})
        return self._send(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        raw = self._read_body()          # 先读完，避免残留
        ctype = self.headers.get("Content-Type") or ""
        if path in ("/v1/images/generations", "/images/generations"):
            return self._handle_generations(raw)
        if path in ("/v1/images/edits", "/images/edits"):
            return self._handle_edits(raw, ctype)
        return self._send(404, {"error": {"message": f"unsupported path {path}",
                                          "type": "invalid_request_error"}})

    def _handle_edits(self, raw, ctype):
        if "multipart/form-data" not in ctype.lower():
            return self._send(400, {"error": {
                "message": "image edits require multipart/form-data with an `image` file",
                "type": "invalid_request_error"}})
        try:
            fields, files = parse_multipart(raw, ctype)
        except Exception as e:
            return self._send(400, {"error": {"message": f"invalid multipart: {e}",
                                              "type": "invalid_request_error"}})
        imgs = [(n, fn, mime, d) for (n, fn, mime, d) in files
                if (n or "").split("[")[0] in ("image", "image[]")]
        if not imgs:
            return self._send(400, {"error": {"message": "an `image` file is required",
                                              "type": "invalid_request_error"}})
        prompt = (fields.get("prompt") or "").strip()
        if not prompt:
            return self._send(400, {"error": {"message": "prompt is required",
                                              "type": "invalid_request_error"}})
        model = fields.get("model") or "gpt-image-qwen-2.1"
        spec = MODELS.get(model)
        if not spec:
            return self._send(404, {"error": {
                "message": f"model {model} not found, available: {list(MODELS)}",
                "type": "invalid_request_error", "code": "model_not_found"}})

        width, height = parse_size(fields.get("size"))
        resolution = max(width, height)
        if resolution > 2048:
            return self._send(400, {"error": {
                "message": f"size {width}x{height} is too large; max supported is 2048x2048",
                "type": "invalid_request_error", "code": "size_too_large"}})
        steps = max(1, min(int(fields.get("steps") or spec["steps"]), 40))
        seed = fields.get("seed")
        seed = int(seed) if seed else random.randint(0, 2**31 - 1)
        negative = fields.get("negative_prompt") or ""
        count = max(1, min(int(fields.get("n") or 1), 4))

        t0 = time.time()
        try:
            names = [upload_image(fn, d, mime) for (_n, fn, mime, d) in imgs[:12]]
        except Exception as e:
            return self._send(502, {"error": {"message": f"upload to ComfyUI failed: {e}",
                                              "type": "upstream_error"}})

        images = []
        try:
            for i in range(count):
                wf = build_edit_workflow(spec, names, prompt, negative,
                                         width, height, steps, 1.0, seed + i,
                                         prefix="api_edit_" + model)
                r = comfy_post("/prompt", {"prompt": wf,
                                           "client_id": f"bridge-{os.getpid()}"})
                images.extend(wait_and_fetch(r["prompt_id"]))
        except Exception as e:
            return self._send(502, {"error": {"message": str(e),
                                              "type": "upstream_error"}})

        data = [{"b64_json": base64.b64encode(img).decode()} for img in images]
        print(f"  改图完成: model={model} {len(names)} 张参考 {resolution}px "
              f"steps={steps} n={count} 耗时 {time.time()-t0:.1f}s", flush=True)
        return self._send(200, {"created": int(time.time()), "data": data,
                                "usage": {"total_tokens": 0}})

    def _handle_generations(self, raw):
        try:
            req = json.loads(raw.decode() or "{}")
        except Exception as e:
            return self._send(400, {"error": {"message": f"invalid JSON: {e}",
                                              "type": "invalid_request_error"}})

        # Sub2API 的能力探测会往这个路径发 Responses 形状的 body，直接拒绝
        if "input" in req and "prompt" not in req:
            return self._send(400, {"error": {
                "message": "this endpoint only supports images; tool/Responses probing is not available",
                "type": "invalid_request_error", "code": "not_supported"}})

        prompt = (req.get("prompt") or "").strip()
        if not prompt:
            return self._send(400, {"error": {"message": "prompt is required",
                                              "type": "invalid_request_error"}})

        model = req.get("model") or "gpt-image-qwen-2.1"
        spec = MODELS.get(model)
        if not spec:
            return self._send(404, {"error": {
                "message": f"model {model} not found, available: {list(MODELS)}",
                "type": "invalid_request_error", "code": "model_not_found"}})

        width, height = parse_size(req.get("size"))
        # 上限 2048：1024 约 30–50 秒，2048 约 5 分钟以上，客户端超时要设够。
        if width > 2048 or height > 2048:
            return self._send(400, {"error": {
                "message": f"size {width}x{height} is too large; max supported is 2048x2048",
                "type": "invalid_request_error", "code": "size_too_large"}})
        count = max(1, min(int(req.get("n") or 1), 4))
        steps = int(req.get("steps") or spec["steps"])
        steps = max(1, min(steps, 40))
        seed = req.get("seed")
        seed = int(seed) if seed is not None else random.randint(0, 2**31 - 1)
        negative = req.get("negative_prompt") or ""
        fmt = (req.get("response_format") or "b64_json").lower()

        t0 = time.time()
        images = []
        try:
            for i in range(count):
                wf = build_workflow(spec, prompt, negative, width, height,
                                    steps, 1.0, seed + i, prefix="api_" + model)
                r = comfy_post("/prompt", {"prompt": wf, "client_id": f"bridge-{os.getpid()}"})
                images.extend(wait_and_fetch(r["prompt_id"]))
        except Exception as e:
            return self._send(502, {"error": {"message": str(e),
                                              "type": "upstream_error"}})

        data = [{"b64_json": base64.b64encode(img).decode()} for img in images]
        print(f"  出图完成: model={model} {width}x{height} steps={steps} "
              f"n={count} 耗时 {time.time()-t0:.1f}s", flush=True)
        return self._send(200, {
            "created": int(time.time()),
            "data": data,
            "usage": {"total_tokens": 0},
        })


def main():
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    srv.daemon_threads = True
    print(f"ComfyUI bridge listening on http://{LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    print(f"  上游 ComfyUI: {COMFY}", flush=True)
    print(f"  可用模型: {list(MODELS)}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
