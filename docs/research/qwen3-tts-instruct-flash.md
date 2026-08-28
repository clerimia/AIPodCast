# qwen3-tts-instruct-flash 能力边界（#6 调研）

> 调研日期：2026-08-28。官方文档 + 经验性探针（`scripts/tts_probe2.py`、`tts_speed_probe.py`、`tts_edge_probe.py`，输出 `tmp/probe2/`）。
> 用途：为「tune 参数到引擎/ffmpeg 的映射」（#6）以及 ffmpeg 管线（#7）确定引擎的能力边界。

## 一句话结论

`qwen3-tts-instruct-flash` 走 DashScope 原生 multimodal-generation 接口，**请求体只有 `model` + `input{text, voice, language_type, instructions, optimize_instructions}`，没有任何音频参数**（无 `parameters` 对象、无 format/sample_rate/volume/speed/pitch 字段）。输出固定为 wav 文件 URL（流式固定 24kHz PCM 单声道 16-bit）。音量/语速/音调/风格只能靠 `instructions` 自然语言描述（仅中英文、≤1600 Token，且仅 instruct-flash 生效）；预置 24 个系统音色；**不支持中文方言，不支持参考音频复刻**（复刻=qwen3-tts-vc、声音设计=qwen3-tts-vd，属增强）。

## 官方字段（出处：help.aliyun.com/zh/model-studio/qwen-tts-api）

| 字段 | 支持 | 取值 / 默认 |
|---|---|---|
| `model` | 必填 | `qwen3-tts-instruct-flash` |
| `input.text` | 必填 | 多语种混合；千问-TTS 最大 512 Token |
| `input.voice` | 必填 | 24 个系统音色（见下），如 `Cherry` |
| `input.language_type` | 可选 | `Auto`/`Chinese`/`English`/…/`Russian`，默认 `Auto` |
| `input.instructions` | 可选，仅 instruct-flash | 自然语言指令，≤1600 Token，仅中英文；默认不设不生效 |
| `input.optimize_instructions` | 可选，仅 instruct-flash | boolean，对指令做语义优化/重写，默认 `false` |
| `input.audio`（参考音频） | 不支持 | 文档未提及（复刻走 qwen3-tts-vc） |
| `parameters.*` | **不存在** | 请求体顶层仅 `model`+`input` |

## 经验探针事实（与文档一致）

- `voice` 生效（Cherry/Ethan 均产出标准普通话）；默认音色即标准普通话。
- `format=mp3`、`sample_rate=16000/48000`、`volume=20/300`、`speed=0.8/1.5`、`rate=1.5`、`pitch=5` 全部**被接受但无效果**——因为请求体根本没有这些字段，服务端静默忽略未知字段（duration 在 6.5–7.8s 自然抖动，均落在噪声区间）。
- **语速只能经 `instructions`**：指令"慢"有效（约 +26% 时长），指令"快"无效甚至更慢 → **引擎只能单向放慢，双向可靠控速必须 ffmpeg atempo 后处理**。
- 指令式情感/语气有效（#10 已验证："用开心活泼的语气说…"）。

## 音色列表（24 个，instruct-flash 支持）

Cherry(芊悦)、Serena(苏瑶)、Ethan(晨煦)、Chelsie(千雪)、Momo(茉兔)、Vivian(十三)、Moon(月白)、Maia(四月)、Kai(凯)、Nofish(不吃鱼)、Bella(萌宝)、Eldric Sage(沧明子)、Mia(乖小妹)、Mochi(沙小弥)、Bellona(燕铮莺)、Vincent(田叔)、Bunny(萌小姬)、Neil(阿闻)、Elias(墨讲师)、Arthur(徐大爷)、Nini(邻家妹妹)、Seren(小婉)、Pip(顽屁小孩)、Stella(少女阿月)

instruct-flash 相对 qwen3-tts-flash 缺失：Jennifer/Ryan/Katerina/Aiden 及全部方言/外语音色（Jada 上海、Dylan 北京、Marcus 陕西、Rocky/Kiki 粤语等）。**中文方言不含于 instruct-flash。**

## 对领域模型的含义（#6 映射依据）

- **音色** → `input.voice`（逐说话人，Speaker 配置存 voice 名，24 选 1）——引擎原生。
- **语气 / 情感** → `input.instructions` 自然语言（合并成一个维度，合成时拼指令）——引擎原生。
- **语速** → 慢档可经 `instructions`，快档必须 **ffmpeg atempo 后处理**；建议统一走 atempo（双向、可控、音质可接受）。
- **停顿** → 文档未列停顿指令类型 → **拼接层参数**（ADR-0004 再次印证），档位落毫秒、插静音在 ffmpeg。
- **响度** → 引擎无音量字段 → **ffmpeg 归一化**（EBU R128，拼接待 #7）。
- **产物格式** → 引擎固定出 wav 24k mono → 拼接后按需转 mp3 等（#7/#8）。

## 出处

- 介绍/端点：https://help.aliyun.com/zh/model-studio/qwen-tts
- API 参考：https://help.aliyun.com/zh/model-studio/qwen-tts-api
- 音色列表：https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list
- 模型列表（能力/语言/指令控制）：https://help.aliyun.com/zh/model-studio/tts-model
- 指令控制用户指南：https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide
