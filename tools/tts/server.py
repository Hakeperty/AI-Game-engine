"""
AIGE local voice server: Qwen3-TTS (voice design + voice cloning) and Whisper (transcription checks).

Started on demand by the AIGE host (packages/host/src/voice/tts-client.ts). Models load lazily on the
first request and stay on the GPU. Audio is exchanged as WAV files on disk (paths in JSON), not base64.

Endpoints (JSON):
  GET  /health                       -> { ok, device, loaded: [...] }
  POST /design {texts, language, instruct, outs, seed}              -> { files: [{ out, sr, duration }] }
  POST /clone  {texts, language, ref_audio, ref_text, outs, seed}   -> { files: [...] }
  POST /asr    {audio}                                              -> { text }
  POST /similarity {ref, audios}  speaker similarity, cosine of WavLM x-vectors -> { similarity: [...] }
  POST /unload                                                      -> { ok }
"""

import argparse
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
import torch

DESIGN_MODEL = os.environ.get("AIGE_TTS_DESIGN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
BASE_MODEL = os.environ.get("AIGE_TTS_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
ASR_MODEL = os.environ.get("AIGE_ASR_MODEL", "openai/whisper-small.en")
SV_MODEL = os.environ.get("AIGE_SV_MODEL", "microsoft/wavlm-base-plus-sv")
DEVICE = os.environ.get("AIGE_TTS_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32

_lock = threading.Lock()  # one GPU job at a time
_models: dict = {}
_clone_prompts: dict = {}


def _tts(name: str):
    if name not in _models:
        from qwen_tts import Qwen3TTSModel

        t0 = time.time()
        _models[name] = Qwen3TTSModel.from_pretrained(
            name, device_map=DEVICE, dtype=DTYPE, attn_implementation="sdpa"
        )
        print(f"[aige-tts] loaded {name} in {time.time() - t0:.1f}s", flush=True)
    return _models[name]


def _asr():
    if "asr" not in _models:
        from transformers import pipeline

        _models["asr"] = pipeline(
            "automatic-speech-recognition",
            model=ASR_MODEL,
            device=DEVICE,
            torch_dtype=torch.float16 if DEVICE.startswith("cuda") else torch.float32,
        )
    return _models["asr"]


def _sv():
    if "sv" not in _models:
        from transformers import AutoFeatureExtractor, WavLMForXVector

        fe = AutoFeatureExtractor.from_pretrained(SV_MODEL)
        model = WavLMForXVector.from_pretrained(SV_MODEL).to(DEVICE).eval()
        _models["sv"] = (fe, model)
    return _models["sv"]


def _load_16k(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != 16000:
        import torchaudio.functional as AF

        audio = AF.resample(torch.from_numpy(audio), sr, 16000).numpy()
    return audio


_embeddings: dict = {}


def _embedding(path):
    key = (path, os.path.getmtime(path))
    if key not in _embeddings:
        fe, model = _sv()
        inputs = fe(_load_16k(path), sampling_rate=16000, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            emb = model(**inputs).embeddings
        _embeddings[key] = torch.nn.functional.normalize(emb, dim=-1)[0].float().cpu()
    return _embeddings[key]


def _write(outs, wavs, sr):
    files = []
    for out, wav in zip(outs, wavs):
        audio = np.asarray(wav, dtype=np.float32).reshape(-1)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        sf.write(out, audio, sr, subtype="PCM_16")
        files.append({"out": out, "sr": sr, "duration": len(audio) / sr})
    return files


def _seed(seed):
    if seed is not None:
        torch.manual_seed(int(seed))
        np.random.seed(int(seed) % (2**32))


def design(req):
    texts, outs = req["texts"], req["outs"]
    model = _tts(DESIGN_MODEL)
    _seed(req.get("seed"))
    wavs, sr = model.generate_voice_design(
        text=texts,
        language=[req.get("language", "English")] * len(texts),
        instruct=[req["instruct"]] * len(texts),
    )
    return {"files": _write(outs, wavs, sr)}


def clone(req):
    texts, outs = req["texts"], req["outs"]
    model = _tts(BASE_MODEL)
    ref_audio, ref_text = req["ref_audio"], req["ref_text"]
    key = (ref_audio, os.path.getmtime(ref_audio), ref_text)
    prompt = _clone_prompts.get(key)
    if prompt is None:
        prompt = model.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text, x_vector_only_mode=False)
        _clone_prompts[key] = prompt
    _seed(req.get("seed"))
    wavs, sr = model.generate_voice_clone(
        text=texts,
        language=[req.get("language", "English")] * len(texts),
        voice_clone_prompt=prompt,
    )
    return {"files": _write(outs, wavs, sr)}


def asr(req):
    result = _asr()(req["audio"])
    return {"text": (result.get("text") or "").strip()}


def similarity(req):
    ref = _embedding(req["ref"])
    return {"similarity": [float(torch.dot(ref, _embedding(p))) for p in req["audios"]]}


def unload(_req):
    _models.clear()
    _embeddings.clear()
    _clone_prompts.clear()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return {"ok": True}


ROUTES = {"/design": design, "/clone": clone, "/asr": asr, "/similarity": similarity, "/unload": unload}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "device": DEVICE,
                    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                    "loaded": [k for k in _models],
                },
            )
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        route = ROUTES.get(self.path)
        if route is None:
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            with _lock:
                t0 = time.time()
                res = route(req)
                res["ms"] = int((time.time() - t0) * 1000)
            self._send(200, res)
        except Exception as err:  # report to the host, keep serving
            traceback.print_exc()
            self._send(500, {"error": f"{type(err).__name__}: {err}"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7861)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[aige-tts] listening on 127.0.0.1:{args.port} ({DEVICE})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
