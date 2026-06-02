from __future__ import annotations

import os
import json
from dataclasses import dataclass
from pathlib import Path


PLC_CONFIG_PATH = Path.home() / ".aiplusx_plc_agent" / "plc_config.json"


def _load_dotenv(path: Path = Path(".env")) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return default if value in (None, "") else float(value)


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return default if value in (None, "") else int(value)


def _load_local_config() -> dict[str, object]:
    try:
        if not PLC_CONFIG_PATH.exists():
            return {}
        with PLC_CONFIG_PATH.open("r", encoding="utf-8") as file:
            data = json.load(file)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_local_device_config(device_sn: str) -> None:
    clean_device = device_sn.strip()
    if not clean_device:
        raise ValueError("device_sn cannot be empty")
    PLC_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with PLC_CONFIG_PATH.open("w", encoding="utf-8") as file:
        json.dump({"mqtt_device_sn": clean_device}, file, ensure_ascii=False, indent=2)
        file.write("\n")
    os.chmod(PLC_CONFIG_PATH, 0o600)


@dataclass(frozen=True)
class PlcTopics:
    tag_values: str
    command: str


@dataclass(frozen=True)
class PlcRegisters:
    temperature_raw: str = "MW0"
    cooling: str = "MW20"
    auto_mode: str = "MW21"
    manual_trigger: str = "MW22"


@dataclass(frozen=True)
class Settings:
    mqtt_host: str
    mqtt_port: int
    mqtt_username: str | None
    mqtt_password: str | None
    mqtt_device_sn: str
    mqtt_qos: int
    topics: PlcTopics
    registers: PlcRegisters
    temp_on_c: float
    temp_off_c: float
    control_interval_seconds: float
    manual_trigger_delay_seconds: float

    @classmethod
    def from_env(cls) -> "Settings":
        _load_dotenv()
        local_config = _load_local_config()
        username = os.getenv("MQTT_USERNAME") or None
        password = os.getenv("MQTT_PASSWORD") or None
        device_sn = os.getenv("MQTT_DEVICE_SN") or str(local_config.get("mqtt_device_sn") or "bistu13")

        temp_on_c = _env_float("TEMP_ON_C", 30.0)
        temp_off_c = _env_float("TEMP_OFF_C", 28.0)
        if temp_off_c > temp_on_c:
            raise ValueError("TEMP_OFF_C must be less than or equal to TEMP_ON_C")

        return cls(
            mqtt_host=os.getenv("MQTT_HOST", "192.168.31.197"),
            mqtt_port=_env_int("MQTT_PORT", 1883),
            mqtt_username=username or device_sn,
            mqtt_password=password or device_sn,
            mqtt_device_sn=device_sn,
            mqtt_qos=_env_int("MQTT_QOS", 0),
            topics=PlcTopics(
                tag_values=os.getenv("MQTT_TAG_VALUES_TOPIC", f"{device_sn}/TagValues"),
                command=os.getenv(
                    "MQTT_COMMAND_TOPIC", f"{device_sn}/MQTTSetValueCommand/1"
                ),
            ),
            registers=PlcRegisters(),
            temp_on_c=temp_on_c,
            temp_off_c=temp_off_c,
            control_interval_seconds=_env_float("CONTROL_INTERVAL_SECONDS", 2.0),
            manual_trigger_delay_seconds=_env_float(
                "MANUAL_TRIGGER_DELAY_SECONDS", 0.2
            ),
        )
