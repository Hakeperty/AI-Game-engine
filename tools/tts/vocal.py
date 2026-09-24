"""
Non-verbal vocalizations (gasps, whimpers, sobs, pain, screams, panicked breathing) with Nari Labs Dia,
which Qwen3-TTS cannot act. Dia clones the character's voice from its reference recording, so the sounds
match their lines. Each sound gets several takes; the best one wins on speaker similarity (WavLM), with
takes that are cut off, too short, silent, or that speak real words (Whisper) thrown out.

    tools/tts/.venv/Scripts/python.exe tools/tts/vocal.py <project> <jobs.json>

jobs.json:
    { "voice": "voices/milch.voice.json", "out": "audio/vocal", "takes": 4,
      "items": [ { "name": "pain_1", "text": "(groans) Nnh... agh... (exhales)", "seconds": 3, "words": false } ] }

`text` uses Dia's tags: (gasps) (inhales) (exhales) (sighs) (groans) (screams) (sniffs) (coughs) (mumbles)
(laughs) (clears throat); onomatopoeia ("Nnh...", "hhh", "Ah!") shapes the rest. `words: false` rejects takes
where Whisper hears more than a word or two. Output: <out>/<name>.ogg and <out>/<name>.json (score, takes).
"""

import json
import os
import re
import subprocess
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

DIA_MODEL = os.environ.get("AIGE_DIA_MODEL", "nari-labs/Dia-1.6B-0626")
SV_MODEL = os.environ.get("AIGE_SV_MODEL", "microsoft/wavlm-base-plus-sv")
ASR_MODEL = os.environ.get("AIGE_ASR_MODEL", "openai/whisper-small.en")
DEVICE = os.environ.get("AIGE_TTS_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
SR = 44100
FPS = 86  # Dia's DAC frames per second
VOCAL = re.compile(r"^(cough\w*|sniff\w*|gasp\w*|sigh\w*|groan\w*|scream\w*|a+h*|o+h*|u+h*|u+gh+|a+r*gh+|h+m+|m+|s+h+|h+|e+h+|n+g*h*|w?h?o+[ao]*|oo+f|ouch|ow+|huh|hah?|heh|ha(ha)+|whe+w|phew|uh+m*|er+m*)$")


def load(path, sr):
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = torch.from_numpy(audio.mean(axis=1))
    return (AF.resample(audio, rate, sr) if rate != sr else audio).numpy()


def trim(audio, sr, floor_db=-42.0):
    """Trim silence at both ends (keeping 60 ms of air) and fade the edges."""
    frame = int(sr * 0.02)
    n = len(audio) // frame
    if n == 0:
        return audio
    rms = np.sqrt((audio[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    loud = np.where(20 * np.log10(rms / (rms.max() + 1e-12)) > floor_db)[0]
    if len(loud) == 0:
        return audio[:0]
    pad = int(sr * 0.06)
    out = audio[max(0, loud[0] * frame - pad) : min(len(audio), (loud[-1] + 1) * frame + pad)].copy()
    fade = min(len(out) // 4, int(sr * 0.015))
    if fade > 0:
        out[:fade] *= np.linspace(0, 1, fade)
        out[-fade:] *= np.linspace(1, 0, fade)
    return out


def main():
    project, jobs_path = sys.argv[1], sys.argv[2]
    job = json.load(open(jobs_path, encoding="utf-8"))
    out_dir = os.path.join(project, job.get("out", "audio/vocal"))
    os.makedirs(out_dir, exist_ok=True)
    takes = int(job.get("takes", 4))
    only = set(sys.argv[3:])

    from transformers import (
        AutoFeatureExtractor,
        AutoProcessor,
        DiaForConditionalGeneration,
        WavLMForXVector,
        pipeline,
    )

    processor = AutoProcessor.from_pretrained(DIA_MODEL)
    dia = DiaForConditionalGeneration.from_pretrained(DIA_MODEL, torch_dtype=torch.float16).to(DEVICE).eval()
    fe = AutoFeatureExtractor.from_pretrained(SV_MODEL)
    sv = WavLMForXVector.from_pretrained(SV_MODEL).to(DEVICE).eval()
    asr = pipeline("automatic-speech-recognition", model=ASR_MODEL, device=DEVICE)

    def embed(audio16):
        inputs = fe(audio16, sampling_rate=16000, return_tensors="pt").to(DEVICE)
        with torch.no_grad():
            return torch.nn.functional.normalize(sv(**inputs).embeddings, dim=-1)[0].float().cpu()

    ref_audio, ref_text, ref_emb, ref_rms = None, "", None, 0.1
    if job.get("voice"):
        voice = json.load(open(os.path.join(project, job["voice"]), encoding="utf-8"))
        ref_path = os.path.join(project, voice["refAudio"])
        ref_audio = load(ref_path, SR)
        ref_text = f"[S1] {voice['refText']} "
        ref_emb = embed(load(ref_path, 16000))
        ref_rms = float(np.sqrt((ref_audio**2).mean()))

    for item in job["items"]:
        name = item["name"]
        if only and name not in only:
            continue
        text = f"{ref_text}[S1] {item['text']}"
        seconds = float(item.get("seconds", 3))
        max_new = int(seconds * FPS * 1.6) + 40
        kw = {"text": [text] * takes, "padding": True, "return_tensors": "pt"}
        if ref_audio is not None:
            kw["audio"] = [ref_audio] * takes
        inputs = processor(**kw).to(DEVICE)
        prompt_len = processor.get_audio_prompt_len(inputs["decoder_attention_mask"]) if ref_audio is not None else None
        torch.manual_seed(int(item.get("seed", 1)))
        with torch.no_grad():
            gen = dia.generate(
                **inputs,
                max_new_tokens=max_new,
                guidance_scale=float(item.get("guidance", 3.0)),
                temperature=float(item.get("temperature", 1.4)),
                top_p=0.9,
                top_k=45,
            )
        decoded = processor.batch_decode(gen, audio_prompt_len=prompt_len) if prompt_len is not None else processor.batch_decode(gen)

        results = []
        for i, wav in enumerate(decoded):
            raw = np.asarray(wav.float().cpu() if torch.is_tensor(wav) else wav, dtype=np.float32).reshape(-1)
            audio = trim(raw, SR)
            dur = len(audio) / SR
            reasons = []
            if dur < 0.35:
                reasons.append("too short")
            if dur > seconds * 2.2:
                reasons.append("too long")
            # a take that still has sound in its last frames ran out of tokens and is cut off
            tail = raw[-int(SR * 0.08) :]
            if len(raw) >= (max_new - 12) * SR / FPS and np.sqrt((tail**2).mean()) > 0.02:
                reasons.append("cut off")
            heard = ""
            if dur >= 0.35:
                a16 = AF.resample(torch.from_numpy(audio), SR, 16000).numpy()
                heard = asr({"raw": a16, "sampling_rate": 16000})["text"].strip()[:120]
                sim = float(torch.dot(ref_emb, embed(a16))) if ref_emb is not None else 1.0
            else:
                sim = 0.0
            # Whisper spells vocal sounds as words ("Cough, cough", "Ahh! Ugh!"); only real speech counts
            words = [w for w in re.findall(r"[a-z']+", heard.lower()) if len(w) > 2 and not VOCAL.match(w)]
            if not item.get("words", False) and len(words) > int(item.get("maxWords", 2)):
                reasons.append(f"speaks: {heard[:40]}")
            score = sim - 0.5 * len(reasons)
            results.append({"take": i, "score": round(score, 3), "similarity": round(sim, 3), "seconds": round(dur, 2), "heard": heard, "rejected": reasons, "audio": audio})

        best = max(results, key=lambda r: r["score"])
        audio = best["audio"]
        cap = float(item.get("maxSeconds", 0))
        if cap and len(audio) > cap * SR:  # longer than its slot: cut with a short fade-out
            audio = audio[: int(cap * SR)].copy()
            fade = int(0.3 * SR)
            audio[-fade:] *= np.linspace(1, 0, fade)
        rms = float(np.sqrt((audio**2).mean())) + 1e-9
        audio = audio * min(ref_rms * float(item.get("gain", 1.0)) / rms, 0.97 / (np.abs(audio).max() + 1e-9))
        wav_path = os.path.join(out_dir, f"{name}.wav")
        sf.write(wav_path, audio, SR)
        ogg_path = os.path.join(out_dir, f"{name}.ogg")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-c:a", "libvorbis", "-q:a", "5", ogg_path], check=True)
        os.remove(wav_path)
        report = {"name": name, "text": item["text"], "best": {k: v for k, v in best.items() if k != "audio"}, "takes": [{k: v for k, v in r.items() if k != "audio"} for r in results]}
        with open(os.path.join(out_dir, f"{name}.json"), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(report, indent=2) + "\n")
        print(f"{name}: take {best['take']} sim {best['similarity']} {best['seconds']}s {best['rejected'] or 'ok'} heard={best['heard'][:40]!r}", flush=True)


if __name__ == "__main__":
    main()
