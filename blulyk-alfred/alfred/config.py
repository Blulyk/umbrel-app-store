import base64
import hashlib
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    host: str = Field("0.0.0.0", alias="ALFRED_HOST")
    port: int = Field(8080, alias="ALFRED_PORT")
    db_path: str = Field("/data/alfred.sqlite3", alias="ALFRED_DB")
    redis_url: str | None = Field(None, alias="ALFRED_REDIS_URL")
    codex_home: str = Field("/data/codex", alias="CODEX_HOME")
    codex_bin: str = Field("codex", alias="JARVIS_CODEX_BIN")
    codex_model: str = Field("", alias="JARVIS_CODEX_MODEL")
    codex_timeout_seconds: float = Field(70.0, alias="JARVIS_CODEX_TIMEOUT")
    google_api_key: str | None = Field(None, alias="GOOGLE_API_KEY")
    google_model: str = Field("gemini-2.5-flash-lite", alias="JARVIS_GOOGLE_MODEL")
    google_base_url: str = Field("https://generativelanguage.googleapis.com/v1beta", alias="GOOGLE_BASE_URL")
    docker_control: bool = Field(False, alias="ALFRED_DOCKER_CONTROL")
    auth_log_path: str = Field("/host/var/log/auth.log", alias="ALFRED_AUTH_LOG")
    bridge_key: str | None = Field(None, alias="ALFRED_BRIDGE_KEY")
    bridge_secret: str | None = Field(None, alias="ALFRED_BRIDGE_SECRET")
    cpu_temp_caution: float = Field(75.0, alias="ALFRED_CPU_TEMP_CAUTION")
    cpu_temp_critical: float = Field(90.0, alias="ALFRED_CPU_TEMP_CRITICAL")
    ram_pressure_caution: float = Field(85.0, alias="ALFRED_RAM_PRESSURE_CAUTION")
    disk_pressure_caution: float = Field(90.0, alias="ALFRED_DISK_PRESSURE_CAUTION")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def fernet_key(self) -> str:
        if self.bridge_key:
            return self.bridge_key
        seed = self.bridge_secret or "alfred-development-bridge-secret"
        digest = hashlib.sha256(seed.encode()).digest()
        return base64.urlsafe_b64encode(digest).decode()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
