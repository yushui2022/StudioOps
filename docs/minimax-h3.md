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

## 10 秒带货测试

同样的模型和工作流，`864×480`、10.123 秒、243 帧、4 步：

```text
提示词：黑人小哥在奶品柜台拿玻璃瓶鲜奶对镜头带货
画面文字：顶部「每日鲜奶」，下面「新鲜直达」
输出：H3_milk_00001_.mp4，2.8 MB
耗时：505.5 秒（8 分 25 秒）
```

中文文字渲染成功，没有明显错字；音频为 32kHz 双声道 AAC。10 秒任务比 5 秒任务慢约 2.25 倍，且内存/swap 压力更大。

## 经推理网关的视频请求

通过 StudioOps 网关 `8192` 提交同样题材的 5 秒、608×352 视频：

```text
HTTP 200
输出：H3_api_00001_.mp4，1.2 MB
耗时：113.3 秒
网关记录：backend=video, model=minimax-h3, duration=113276 ms
```

这验证了 `8192 → 8193 视频桥 → 8188 ComfyUI` 的队列、内存门槛和模型调用记录。

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
