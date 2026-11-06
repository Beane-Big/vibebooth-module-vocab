# 能用的声音。后端 tts.go 里的 ttsVoices 和前端 speech.ts 里的 ttsVoice 要和这里一致。
# 英文用 Kokoro：美音、英音各用 Kokoro 官方评分最高的女声（a 美音、b 英音，f 女声），值是不是英音。
VOICES = {"af_heart": False, "bf_emma": True}
# 中文用 Piper：值是 rhasspy/piper-voices 里的声音名。超文（chaowen）的训练数据是 CC0。
PIPER_VOICES = {"zh_chaowen": "zh_CN-chaowen-medium"}
