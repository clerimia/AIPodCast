#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""语速探针（#6）— qwen3-tts-instruct-flash 语速怎么落地：
A) parameters.speed 数值参数  B) 指令文本（自然语言"慢一点"）  C) 都不行→ffmpeg atempo
硬编码 UTF-8，绕开 shell 编码问题。
"""
import json
import os
import time
import urllib.request
import wave

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env_line(key):
    with open(os.path.join(BASE_DIR, '.env'), encoding='utf-8') as f:
        for line in f:
            if line.startswith(key + '='):
                return line.strip().split('=', 1)[1]
    return ''


KEY = env_line('DASHSCOPE_API_KEY')
BASE = env_line('DASHSCOPE_BASE_URL')
API = BASE + '/api/v1/services/aigc/multimodal-generation/generation'
MODEL = 'qwen3-tts-instruct-flash'

# 同一句长文本，方便对比时长差异
TEXT = '今天我们来聊聊人工智能如何改变我们的生活方式，这是一个非常有趣的话题。'

out_dir = os.path.join(BASE_DIR, 'tmp', 'probe2')
os.makedirs(out_dir, exist_ok=True)


def synth(out_name, text=TEXT, parameters=None, label=''):
    body = json.dumps({
        'model': MODEL,
        'input': {'text': text},
        'parameters': parameters or {},
    }, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(API, data=body, headers={
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
    })
    out = os.path.join(out_dir, out_name)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read().decode('utf-8'))
        audio_url = resp['output']['audio']['url']
        with urllib.request.urlopen(audio_url, timeout=60) as r:
            data = r.read()
        with open(out, 'wb') as f:
            f.write(data)
        try:
            w = wave.open(out)
            dur = w.getnframes() / w.getframerate()
            info = f"{dur:.2f}s {w.getframerate()}Hz {w.getnchannels()}ch"
        except Exception:
            info = 'non-wav'
        print(f"[OK] {out_name}: total={time.time() - t0:.2f}s size={len(data)}B {info} | {label}")
    except Exception as e:
        print(f"[FAIL] {out_name}: {label} -> {e}")


# A) 引擎原生 speed 参数（试 1.5x）
synth('speed_param_150.wav', parameters={'speed': 1.5}, label='A speed=1.5 param')
synth('speed_param_050.wav', parameters={'speed': 0.5}, label='A speed=0.5 param')
# B) 指令文本控语速（慢）
synth('speed_instr_slow.wav',
      text='请用比平时慢很多、一字一顿的语速说：' + TEXT,
      label='B instruction "慢"')
# C) 指令文本控语速（快）
synth('speed_instr_fast.wav',
      text='请用很快的语速、像新闻快报一样说：' + TEXT,
      label='B instruction "快"')
# 对照：默认语速
synth('speed_baseline.wav', label='baseline 默认')
