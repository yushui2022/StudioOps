#!/usr/bin/env python3
"""MiniMax H3 video bridge for the StudioOps inference gateway.

Exposes a small OpenAI-style video endpoint on 127.0.0.1:8193:

  GET  /health
  GET  /v1/models
  POST /v1/videos/generations
  GET  /videos/<filename>

The request is held open while ComfyUI renders, so the gateway's concurrency
and queue limits apply to actual video jobs. Only metadata is logged here; the
prompt is passed to ComfyUI and is not written to the bridge log.
"""

import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
LISTEN_HOST = os.environ.get("VIDEO_BRIDGE_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("VIDEO_BRIDGE_PORT", "8193"))
OUTPUT_DIR = os.environ.get(
    "VIDEO_OUTPUT_DIR",
    os.path.expanduser("~/Documents/默认项目/ComfyUI/output/video"),
)
JOB_TIMEOUT = int(os.environ.get("VIDEO_JOB_TIMEOUT", "3600"))

MODEL = "minimax-h3"
UNET = "MiniMax-H3-FL2VA-Pruned-Q5_K_M.gguf"
CLIP = "qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
LORA = "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"


def comfy_json(path, payload=None, timeout=60):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        COMFY + path,
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def graph_for(prompt, width, height, seconds, steps, seed, negative=""):
    frames = max(124, min(362, int(round(seconds * 24))))
    frames += (5 - frames % 17) % 17
    graph = {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": UNET}},
        "2": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["1", 0], "lora_name": LORA, "strength_model": 1.0},
        },
        "3": {
            "class_type": "CLIPLoaderGGUF",
            "inputs": {"clip_name": CLIP, "type": "minimax"},
        },
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
        "6": {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {
                "clip": ["3", 0],
                "vae": ["4", 0],
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": frames,
            },
        },
        "7": {
            "class_type": "BasicGuider",
            "inputs": {"model": ["2", 0], "conditioning": ["6", 0]},
        },
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "9": {
            "class_type": "BasicScheduler",
            "inputs": {
                "model": ["2", 0],
                "scheduler": "simple",
                "steps": steps,
                "denoise": 1.0,
            },
        },
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "11": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["10", 0],
                "guider": ["7", 0],
                "sampler": ["8", 0],
                "sigmas": ["9", 0],
                "latent_image": ["6", 1],
            },
        },
        "12": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["11", 0], "vae": ["4", 0]},
        },
        "13": {
            "class_type": "VAEDecodeAudio",
            "inputs": {"samples": ["11", 0], "vae": ["5", 0]},
        },
        "14": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["12", 0],
                "fps": 24,
                "audio": ["13", 0],
                "bit_depth": "auto",
                "color_space": "sRGB",
                "codec": "auto",
            },
        },
        "15": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["14", 0],
                "filename_prefix": "video/H3_api",
                "format": "auto",
                "codec": "auto",
            },
        },
    }
    return graph, frames


def wait_for(comfy_prompt_id):
    deadline = time.time() + JOB_TIMEOUT
    while time.time() < deadline:
        try:
            history = comfy_json("/history/%s" % comfy_prompt_id, timeout=30)
        except Exception:
            time.sleep(3)
            continue
        if comfy_prompt_id not in history:
            time.sleep(3)
            continue
        entry = history[comfy_prompt_id]
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            messages = json.dumps(status.get("messages"), ensure_ascii=False)
            raise RuntimeError("ComfyUI execution failed: " + messages[:1200])
        outputs = entry.get("outputs") or {}
        videos = (outputs.get("15") or {}).get("images") or []
        if not videos:
            raise RuntimeError("ComfyUI finished without a video output")
        video = videos[0]
        return {
            "filename": video.get("filename"),
            "subfolder": video.get("subfolder", ""),
            "type": video.get("type", "output"),
        }
    raise RuntimeError("video job timed out after %ss" % JOB_TIMEOUT)


def output_path(filename, subfolder):
    safe_name = os.path.basename(filename or "")
    safe_sub = os.path.basename(subfolder or "")
    if not safe_name or not re.fullmatch(r"[A-Za-z0-9._ -]+", safe_name):
        raise ValueError("invalid video filename")
    if safe_sub and safe_sub != "video":
        raise ValueError("invalid video subfolder")
    path = os.path.join(OUTPUT_DIR, safe_name)
    if not os.path.realpath(path).startswith(os.path.realpath(OUTPUT_DIR) + os.sep):
        raise ValueError("video path escapes output directory")
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "StudioOpsH3Bridge/0.1"

    def log_message(self, fmt, *args):
        print("[video-bridge] " + (fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode() or "{}")

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(200, {"status": "ok", "model": MODEL, "comfy": COMFY})
            return
        if path in ("/v1/models", "/models"):
            self._send(
                200,
                {
                    "object": "list",
                    "data": [{"id": MODEL, "object": "model", "owned_by": "studioops"}],
                },
            )
            return
        if path.startswith("/videos/"):
            filename = urllib.parse.unquote(path[len("/videos/") :])
            try:
                file_path = output_path(filename, "video")
                with open(file_path, "rb") as handle:
                    data = handle.read()
            except FileNotFoundError:
                self._send(404, {"error": "video not found"})
                return
            except Exception as error:
                self._send(400, {"error": str(error)})
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/v1/videos/generations", "/videos/generations"):
            self._send(404, {"error": "not found"})
            return
        try:
            body = self._read_json()
        except Exception as error:
            self._send(400, {"error": "invalid JSON: %s" % error})
            return
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            self._send(400, {"error": "prompt is required"})
            return
        if body.get("model") and body.get("model") not in (MODEL, "minimax/h3"):
            self._send(404, {"error": "unknown model; use %s" % MODEL})
            return
        width = max(32, min(1344, int(body.get("width") or 864)))
        height = max(32, min(1344, int(body.get("height") or 480)))
        width -= width % 32
        height -= height % 32
        seconds = max(5.0, min(15.0, float(body.get("seconds") or 5)))
        steps = max(1, min(20, int(body.get("steps") or 4)))
        seed = int(body.get("seed") or random.randint(0, 2**31 - 1))
        started = time.time()
        try:
            graph, frames = graph_for(prompt, width, height, seconds, steps, seed)
            submitted = comfy_json("/prompt", {"prompt": graph, "client_id": "video-bridge"})
            prompt_id = submitted["prompt_id"]
            result = wait_for(prompt_id)
            output = output_path(result["filename"], result["subfolder"])
            self._send(
                200,
                {
                    "id": prompt_id,
                    "object": "video",
                    "created": int(time.time()),
                    "status": "completed",
                    "model": MODEL,
                    "filename": result["filename"],
                    "subfolder": result["subfolder"],
                    "path": output,
                    "width": width,
                    "height": height,
                    "seconds": round(frames / 24, 3),
                    "elapsed_seconds": round(time.time() - started, 1),
                },
            )
        except urllib.error.HTTPError as error:
            self._send(502, {"error": "ComfyUI HTTP %s" % error.code})
        except Exception as error:
            self._send(502, {"error": str(error)})


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.daemon_threads = True
    print(
        "[video-bridge] listening on http://%s:%s -> %s" % (LISTEN_HOST, LISTEN_PORT, COMFY),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
