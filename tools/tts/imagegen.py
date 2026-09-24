"""
AIGE local image generation: FLUX.1-schnell (4-bit NF4 quantized so it fits a 16 GB GPU).

    python imagegen.py jobs.json

jobs.json: [{"prompt": "...", "out": "C:/abs/out.png", "width": 1024, "height": 768, "seed": 1, "steps": 4}, ...]
The model loads once for the whole batch. Used for 2D story content: old photographs, paintings, posters.
"""

import json
import os
import sys
import time

import torch
from diffusers import BitsAndBytesConfig, FluxPipeline, FluxTransformer2DModel
from transformers import BitsAndBytesConfig as TransformersBnb
from transformers import T5EncoderModel

REPO = os.environ.get("AIGE_FLUX_MODEL", "YuCollection/FLUX.1-schnell-Diffusers")


def load():
    t0 = time.time()
    q = dict(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
    transformer = FluxTransformer2DModel.from_pretrained(
        REPO, subfolder="transformer", quantization_config=BitsAndBytesConfig(**q), torch_dtype=torch.bfloat16
    )
    t5 = T5EncoderModel.from_pretrained(
        REPO, subfolder="text_encoder_2", quantization_config=TransformersBnb(**q), torch_dtype=torch.bfloat16
    )
    pipe = FluxPipeline.from_pretrained(REPO, transformer=transformer, text_encoder_2=t5, torch_dtype=torch.bfloat16)
    try:
        pipe.to("cuda")
    except Exception as err:  # not enough VRAM: stream modules in and out instead
        print(f"[imagegen] full GPU load failed ({err}); using CPU offload", flush=True)
        pipe.enable_model_cpu_offload()
    print(f"[imagegen] model ready in {time.time() - t0:.0f}s", flush=True)
    return pipe


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf-8"))
    pipe = load()
    for job in jobs:
        t0 = time.time()
        gen = torch.Generator("cpu").manual_seed(int(job.get("seed", 1)))
        image = pipe(
            job["prompt"],
            width=int(job.get("width", 1024)),
            height=int(job.get("height", 768)),
            num_inference_steps=int(job.get("steps", 4)),
            guidance_scale=0.0,
            max_sequence_length=256,
            generator=gen,
        ).images[0]
        os.makedirs(os.path.dirname(os.path.abspath(job["out"])), exist_ok=True)
        image.save(job["out"])
        print(f"[imagegen] {job['out']} in {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
