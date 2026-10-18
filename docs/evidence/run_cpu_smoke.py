"""Minimal macOS Apple Silicon CPU smoke test for the editable vLLM install at github/vllm.

Run with the project venv:
    cd /Users/bytedance/Workspace/github/vllm
    HF_HOME=/Users/bytedance/Workspace/github/.hf-cache \
    VLLM_CACHE_ROOT=/Users/bytedance/Workspace/github/.vllm-cache \
    VLLM_TARGET_DEVICE=cpu .venv/bin/python ../vllm-smoke/run_cpu_smoke.py
"""

import time

MODEL = (
    "/Users/bytedance/Workspace/github/.hf-cache/hub/"
    "models--facebook--opt-125m/snapshots/"
    "27dcfa74d334bc871f3234de431e71c6eeba5dd6"
)


def main() -> None:
    from vllm import LLM, SamplingParams

    t0 = time.time()
    llm = LLM(
        model=MODEL,
        dtype="float32",
        max_model_len=512,
        enforce_eager=True,
        gpu_memory_utilization=0.2,
    )
    print("LOAD_SECONDS", round(time.time() - t0, 1), flush=True)

    outs = llm.generate(
        ["Hello, my name is", "The capital of France is"],
        SamplingParams(temperature=0.0, max_tokens=24),
    )
    for o in outs:
        print("PROMPT:", repr(o.prompt))
        print("OUTPUT:", repr(o.outputs[0].text))
    print("TOTAL_SECONDS", round(time.time() - t0, 1))


if __name__ == "__main__":
    main()
