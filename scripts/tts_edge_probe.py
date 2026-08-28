#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力边界探针（#6）— 经验性扫 qwen3-tts-instruct-flash 的参数表面。
测 parameters 里 sample_rate / volume / format / pitch / rate / speed，
用时长 + 采样率 + RMS 音量判断参数是否真的生效。
硬编码 UTF-8，绕开 shell 编码问题。
"""
import json
import os
import time
import urllib.request
import wave
import math

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
TEXT = '今天我们来聊聊人工智能如何改变我们的生活方式，这是一个非常有趣的话题。'
out_dir = os.path.join(BASE_DIR, 'tmp', 'probe2')
os.makedirs(out_dir, exist_ok=True)


def rms(path):
    try:
        w = wave.open(path)
        n = w.getnframes()
        data = w.readframes(n)
        if w.getsampwidth() == 2:
            import array
            samples = array.array('h', data)
            if len(samples):
                sq = sum(s * s for s in samples) / len(samples)
                return 20 * math.log10(math.sqrt(sq) + 1e-9)
    except Exception as e:
        return f'err:{e}'
    return 'n/a'


def probe(out_name, parameters=None, label=''):
    body = json.dumps({
        'model': MODEL,
        'input': {'text': TEXT},
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
            info = f"{dur:.2f}s {w.getframerate()}Hz {w.getnchannels()}ch rms={rms(out):.1f}dB"
        except Exception:
            info = 'non-wav'
        print(f"[OK] {out_name}: {info} | {label}")
    except Exception as e:
        print(f"[FAIL] {out_name}: {label} -> {e}")


probe('edge_baseline.wav', {}, 'baseline 无参数')
probe('edge_format_mp3.wav', {'format': 'mp3'}, 'format=mp3')
probe('edge_rate_16k.wav', {'sample_rate': 16000}, 'sample_rate=16000')
probe('edge_rate_48k.wav', {'sample_rate': 48000}, 'sample_rate=48000')
probe('edge_volume_020.wav', {'volume': 20}, 'volume=20')
probe('edge_volume_300.wav', {'volume': 300}, 'volume=300')
probe('edge_pitch_plus.wav', {'pitch': 5}, 'pitch=5')
probe('edge_speed_08.wav', {'speed': 0.8}, 'speed=0.8')
probe('edge_rate_15.wav', {'rate': 1.5}, 'rate=1.5')
