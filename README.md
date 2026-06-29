# 声裁 Podcast Studio

面向小团队的中文播客自动精剪 MVP。系统生成保守版与重构版两套可审核时间线，用户可在文字时间线上删除、恢复、调序，确认后创建 MP3/WAV 导出任务。

## 目录

- `web`：Next.js 15 审核工作台。
- `api`：FastAPI 项目、任务、转写、方案、时间线和导出 API。
- `api/app/tasks.py`：Celery 串行媒体任务。
- `capcut-mate`：固定在 `ca2837f`，仅通过适配器预留未来剪映草稿能力。
- `nginx`：统一入口、API 限流和 2GB 请求上限。

## 本地启动

```bash
cp .env.example .env
docker compose up --build
```

打开 `http://localhost:8080`。默认 `MOCK_PROVIDERS=true`，可以直接体验双方案、审核和导出状态，不会调用或扣费任何外部 API。

中国大陆网络默认通过 DaoCloud 拉取 Docker Hub 镜像。如果镜像已同步到 CODING，
可在 `.env` 中覆盖 `DOCKER_MIRROR`、`NODE_IMAGE` 和 `PYTHON_IMAGE`。
Node 和 Python 依赖默认分别使用 npmmirror 与腾讯云 PyPI 镜像。

后端 OpenAPI：`http://localhost:8080/api/docs`

仓库中的 `docker-compose.override.yml` 会被本地 `docker compose` 自动加载，
用于绕过部分 WSL 环境中 Docker bridge 容器互联超时的问题。
腾讯云生产部署请仅使用基础配置：

```bash
sudo mkdir -p /mnt/lighthouse/podcast-cut/{media,work}
docker compose -f docker-compose.yml up -d
```

默认情况下，上传的原始音频、预览和最终导出文件保存在宿主机
`/mnt/lighthouse/podcast-cut/media`，FFmpeg 处理中间文件保存在
`/mnt/lighthouse/podcast-cut/work`。可通过 `.env` 中的
`MEDIA_STORAGE_PATH` 和 `WORKER_TEMP_PATH` 修改。部署前应确认
`/mnt/lighthouse` 已挂载到数据盘；否则这些目录仍会占用系统盘。

## 生产前必须完成

当前版本把业务契约、状态机、校验和 UI 跑通，但腾讯云 COS 临时密钥、录音文件识别、DeepSeek 结构化调用及 FFmpeg/COS 实际导出仍是 Provider 边界，Mock 模式不会生成真实音频文件。切换 `MOCK_PROVIDERS=false` 前需实现并联调这些 Provider。

生产部署还需要：

1. 在 `.env` 设置强密码、`API_KEY` 和云服务密钥。
2. 将 Nginx 配置切换为有效 HTTPS 证书，并关闭公网 HTTP。
3. 对 COS 配置仅限用户前缀的临时权限、生命周期和 CORS。
4. 在 CODING 构建镜像；不要在腾讯云主机运行时拉取 GitHub。
5. 将 `capcut-mate` 镜像仓库同步到 CODING，并校验提交为 `ca2837f`。

## API

- `POST /api/projects`
- `POST /api/projects/{id}/upload-session`
- `POST /api/projects/{id}/process`
- `GET /api/jobs/{id}`
- `GET /api/projects/{id}/transcript`
- `GET /api/projects/{id}/plans`
- `PUT /api/projects/{id}/timeline`
- `POST /api/projects/{id}/export`
- `GET /api/projects/{id}/exports`

所有时间均为整数毫秒。原始转写只读，`PUT timeline` 会校验片段 ID、原始时间范围、原文、重复引用和输出顺序，并始终创建新版本。
