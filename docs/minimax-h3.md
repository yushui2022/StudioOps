# MiniMax H3 本地视频模型验证

日期：2026-11-02  
机器：Mac Studio，Apple M5 Max，64GB 统一内存  
ComfyUI：`0.43.0`，原生 MiniMax H3 节点 + ComfyUI-GGUF

## 结论

64GB Mac 可以本地跑 MiniMax H3，但属于“能跑、较慢、接近内存上限”的状态。

首次验证：

```text
分辨率:    864 × 480
时长:      5.166 秒 / 124 帧 / 24fps
步数:      4 步 Turbo
采样器:    res_multistep + simple
音频:      32kHz 双声道 AAC
视频:      H.264
文件:      ~636 KB
生成耗时:  225 秒（3 分 45 秒）
```

输出文件：

```text
~/Documents/默认项目/ComfyUI/output/video/H3_test_00001_.mp4
```

## 使用的模型

Abiray 的 ComfyUI 兼容 GGUF；不要用 unsloth 的 text encoder GGUF，它缺少 `general.architecture` 元数据，`CLIPLoaderGGUF` 会报 “This gguf file is incompatible with llama.cpp”。

```text
models/diffusion_models/MiniMax-H3-FL2VA-Pruned-Q5_K_M.gguf   13.1 GB
models/text_encoders/qwen3vl_32b_minimax_h3-Q4_K_M.gguf       13.5 GB
models/vae/minimax_h3_video_vae_fp16.safetensors              4.8 GB
models/vae/minimax_h3_audio_vae_fp32.safetensors              0.56 GB
models/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors  1.8 GB
```

## 工作流

API 工作流脚本：

```bash
python3 scripts/minimax-h3-test.py
```

核心节点：

```text
UnetLoaderGGUF
  → LoraLoaderModelOnly（4 步 Turbo）
  → BasicGuider
CLIPLoaderGGUF（type=minimax）
  → MiniMaxH3ImageToVideo（无 first/last frame，即 T2V）
VAELoader（视频 VAE / 音频 VAE）
  → SamplerCustomAdvanced（res_multistep + simple + 4 steps）
  → VAEDecode + VAEDecodeAudio
  → CreateVideo → SaveVideo
```

当前脚本使用 864×480、124 帧、4 步。首次运行会加载约 32GB 模型，需要几分钟。

## 资源与风险

- ComfyUI 进程 RSS 峰值约 24GB；MPS 统一内存和系统缓存另算。
- 生成前系统可用内存约 32GB，5 秒 480p 可完成；更高分辨率或更长时长会明显变慢。
- 机器上的 swap 使用量约 10GB；64GB 对 H3 来说余量不大。
- 这是 **0.4MP、5 秒** 的验证规格，不等于完整 768p/15 秒生产能力。
- 如果追求更稳的内存和速度，优先尝试更小的剪枝 Q4_K（10.6GB）和文本编码器 Q2_K_M（12.2GB），或使用 `h3.c` / MLX 原生 Mac 路线。
- 当前 StudioOps 的 ComfyUI Bridge（8190）仍是图片生成桥，没有把 H3 视频暴露成 OpenAI 视频接口；本次 H3 是直接走 ComfyUI 8188 验证的。

## 下一步建议

1. 先测 Q4_K + Q2_K 文本编码器，比较内存和耗时。
2. 如果稳定，再试 608×352 / 3 秒的更低规格批量测试。
3. 需要对外提供服务时，再单独设计视频任务队列和 Gateway 路由，不要直接复用图片桥。
