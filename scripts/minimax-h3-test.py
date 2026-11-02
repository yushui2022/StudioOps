#!/usr/bin/env python3
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8188"
UNET = "MiniMax-H3-FL2VA-Pruned-Q5_K_M.gguf"
CLIP = "qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
LORA = "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"
PROMPT = (
    "A cinematic product shot of a red apple resting on a white ceramic plate. "
    "Soft studio lighting, shallow depth of field, slow camera push-in. "
    "Audio: quiet room tone and a gentle glass chime near the end."
)

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
    "4": {
        "class_type": "VAELoader",
        "inputs": {"vae_name": VIDEO_VAE},
    },
    "5": {
        "class_type": "VAELoader",
        "inputs": {"vae_name": AUDIO_VAE},
    },
    "6": {
        "class_type": "MiniMaxH3ImageToVideo",
        "inputs": {
            "clip": ["3", 0],
            "vae": ["4", 0],
            "prompt": PROMPT,
            "width": 864,
            "height": 480,
            "length": 124,
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
            "steps": 4,
            "denoise": 1.0,
        },
    },
    "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
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
    "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
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
            "filename_prefix": "video/H3_test",
            "format": "auto",
            "codec": "auto",
        },
    },
}

request = urllib.request.Request(
    BASE + "/prompt",
    data=json.dumps({"prompt": graph, "client_id": "h3-test"}).encode(),
    headers={"content-type": "application/json"},
)
with urllib.request.urlopen(request, timeout=30) as response:
    submitted = json.load(response)
print("submitted", submitted)
prompt_id = submitted.get("prompt_id")
if not prompt_id:
    raise SystemExit(1)

started = time.time()
while time.time() - started < 7200:
    with urllib.request.urlopen(f"{BASE}/history/{prompt_id}", timeout=30) as response:
        history = json.load(response)
    if prompt_id in history:
        entry = history[prompt_id]
        status = entry.get("status") or {}
        print("elapsed", round(time.time() - started, 1), "status", status.get("status_str"))
        print("outputs", json.dumps(entry.get("outputs"), ensure_ascii=False)[:1200])
        if status.get("status_str") == "error":
            print("messages", json.dumps(status.get("messages"), ensure_ascii=False)[:2000])
        break
    time.sleep(5)
else:
    print("timeout")
