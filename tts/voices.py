# 能用的声音。后端 tts.go 里的 ttsVoices 和前端 speech.ts 里的 ttsVoice 要和这里一致。
# 英文用 Kokoro v1.0：美音、英音各用 Kokoro 官方评分最高的女声（a 美音、b 英音，f 女声），值是不是英音。
VOICES = {"af_heart": False, "bf_emma": True}
# 中文（含中英混读）用 Kokoro v1.1-zh（sherpa-onnx，Apache 2.0）：值是模型里的说话人编号（sid=3 为 zf_001 女声，和英文女声统一）。
ZH_VOICES = {"zf_001": 3}
