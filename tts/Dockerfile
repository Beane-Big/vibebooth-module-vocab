# 构建上下文是 tts/。依赖和模型在构建时下载，下载过的 Python 包留在 Docker 的构建缓存里。
FROM python:3.12-slim
# 服务器上的构建器可以传入国内的 PyPI 镜像和 HuggingFace 镜像，不传时用官方源。
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG HF_ENDPOINT=https://huggingface.co
# misaki 用 spaCy 的英文小模型标词性，它只发布在 GitHub；SPACY_MODEL_URL 可以换成镜像里的同一个文件。
ARG SPACY_MODEL_URL=https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url "$PIP_INDEX_URL" -r requirements.txt "$SPACY_MODEL_URL" \
 && pip install --index-url "$PIP_INDEX_URL" --no-deps kokoro-onnx==0.6.1
COPY voices.py fetch_models.py ./
RUN HF_ENDPOINT="$HF_ENDPOINT" python fetch_models.py /models
COPY server.py .
RUN useradd --uid 10001 --no-create-home app
USER app
EXPOSE 8880
ENTRYPOINT ["python", "server.py"]
