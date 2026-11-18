# JARVIS model benchmark — 2026-11-18 18:37:42

Host: Linux-6.18.44-fc-v595-x86_64-with-glibc2.39 (x86_64); provider openai_compatible at http://127.0.0.1:8080; 1 run(s) per case.

| Model | Pass rate | Consistent cases | Invalid tool calls | Median LLM call | Median task time |
|---|---|---|---|---|---|
| qwen3.5-4b | 0% | 1 | 0 | 13.2s | 144.8s |

## qwen3.5-4b

By category: completion 0%

| Case | Run | Result | Steps | Time | Detail |
|---|---|---|---|---|---|
| do_it_quiz | 1 | FAIL | 11 | 144.79s | page1={'Answer to question 1': 'Mitochondria', 'Answer to question 2': '84', 'Answer to qu |
