ARG PYTHON_IMAGE=m.daocloud.io/docker.io/library/python:3.12-slim
ARG PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple
# ARG APT_MIRROR=https://mirrors.cloud.tencent.com

FROM ${PYTHON_IMAGE}
ARG PIP_INDEX_URL
ARG APT_MIRROR
ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}/debian|g; s|http://deb.debian.org/debian-security|${APT_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources 
RUN  apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*
# RUN apt-get update \
#     && apt-get install -y --no-install-recommends ffmpeg curl \
#     && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements.txt
COPY app ./app

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
