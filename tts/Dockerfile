# 构建上下文是 tts/。依赖和模型在构建时下载，下载过的 Python 包留在 Docker 的构建缓存里。
FROM python:3.12-slim
# 服务器上的构建器可以传入国内的 PyPI 镜像和 HuggingFace 镜像，不传时用官方源。
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG HF_ENDPOINT=https://huggingface.co
# misaki 用 spaCy 的英文小模型标词性，默认从 GitHub 下载 3.8.0；SPACY_MODEL_URL 可以换成镜像里的模型。
# HuggingFace（hf-mirror）上只有 3.7.1，文件名还不带版本号：fetch_wheel.py 会改好名字，模型用 --no-deps 装，
# 不让它把 spaCy 降到 3.7（3.7 要 numpy 1.x，和 kokoro-onnx 冲突）。3.7.1 在 spaCy 3.8 上能用，
# 词库一万句里只有二十来句的个别词读音不同（多是 that、read 这类按词性定读音的词），两个版本各有对错。
ARG SPACY_MODEL_URL=https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt download.py fetch_wheel.py ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python fetch_wheel.py "$SPACY_MODEL_URL" /tmp/wheels \
 && pip install --index-url "$PIP_INDEX_URL" -r requirements.txt \
 && pip install --index-url "$PIP_INDEX_URL" --no-deps kokoro-onnx==0.6.1 /tmp/wheels/*.whl \
 && rm -rf /tmp/wheels
# 模型和声音分两步下载，后一步失败时重新构建，前一步用缓存。
COPY fetch_models.py ./
RUN HF_ENDPOINT="$HF_ENDPOINT" python fetch_models.py /models model
COPY voices.py ./
RUN HF_ENDPOINT="$HF_ENDPOINT" python fetch_models.py /models voices
# 中文：Piper 的声音、g2pW 模型和 BERT 分词表。分词表存在 HF_HOME，运行时离线读，不再联网。
ENV HF_HOME=/models/hf
COPY fetch_zh.py ./
RUN HF_ENDPOINT="$HF_ENDPOINT" python fetch_zh.py /models
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
COPY server.py .
RUN useradd --uid 10001 --no-create-home app
USER app
EXPOSE 8880
ENTRYPOINT ["python", "server.py"]
