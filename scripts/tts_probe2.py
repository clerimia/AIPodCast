#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TTS 语音探针 v2（#10 后续）— 绕开 shell 编码，对比音色与模型。
硬编码 UTF-8 文本，直接 urllib 调专属部署 multimodal-generation 端点。
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

TEXT = '大家好，欢迎收听本期节目。今天我们来聊聊人工智能。'


def synth(out_name, model='qwen3-tts-instruct-flash', voice=None):
    params = {}
    if voice:
        params['voice'] = voice
    body = json.dumps({
        'model': model,
        'input': {'text': TEXT},
        'parameters': params,
    }, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(API, data=body, headers={
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
    })
    out = os.path.join(BASE_DIR, 'tmp', 'probe2', out_name)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read().decode('utf-8'))
        audio_url = resp['output']['audio']['url']
        t1 = time.time()
        with urllib.request.urlopen(audio_url, timeout=60) as r:
            data = r.read()
        t2 = time.time()
        with open(out, 'wb') as f:
            f.write(data)
        try:
            w = wave.open(out)
            info = f"{w.getnframes() / w.getframerate():.1f}s {w.getframerate()}Hz {w.getnchannels()}ch"
        except Exception:
            info = 'non-wav'
        print(f"{out_name}: submit={t1 - t0:.2f}s dl={t2 - t1:.2f}s total={t2 - t0:.2f}s "
              f"size={len(data)}B {info} | model={model} voice={voice}")
    except Exception as e:
        print(f"{out_name}: FAILED model={model} voice={voice} -> {e}")


os.makedirs(os.path.join(BASE_DIR, 'tmp', 'probe2'), exist_ok=True)
synth('instruct_default.wav', 'qwen3-tts-instruct-flash', None)
synth('instruct_cherry.wav', 'qwen3-tts-instruct-flash', 'Cherry')
synth('instruct_ethan.wav', 'qwen3-tts-instruct-flash', 'Ethan')
synth('flash_default.wav', 'qwen3-tts-flash', None)
