from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "声裁 Podcast Studio"
    database_url: str = "sqlite:///./podcast.db"
    redis_url: str = "redis://redis:6379/0"
    api_key: str = ""
    cors_origins: str = "http://localhost:3000"
    mock_providers: bool = True
    max_upload_bytes: int = 2 * 1024 * 1024 * 1024
    max_duration_ms: int = 2 * 60 * 60 * 1000
    local_storage_dir: str = "storage"
    retention_days: int = 30
    cos_bucket: str = ""
    cos_region: str = "ap-shanghai"
    cos_secret_id: str = ""
    cos_secret_key: str = ""
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    tencent_asr_app_id: str = ""
    tencent_asr_secret_id: str = ""
    tencent_asr_secret_key: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
