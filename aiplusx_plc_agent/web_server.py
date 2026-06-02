from __future__ import annotations

import json
import os
import threading
import time
import math
from pathlib import Path
from urllib import error, request as urlrequest

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from .agent import PlcControlAgent
from .config import PLC_CONFIG_PATH, Settings, save_local_device_config
from .mqtt_plc import PlcMqttClient


PROVIDER_DEFAULTS = {
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4.1-mini",
    },
    "doubao": {
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "model": "doubao-seed-2-0-lite-260215",
    },
    "custom": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4.1-mini",
    },
}
AI_CONFIG_PATH = Path.home() / ".aiplusx_plc_agent" / "ai_config.json"


class PlcWebRuntime:
    def __init__(self, mock: bool = False) -> None:
        self.settings = Settings.from_env()
        self.plc = PlcMqttClient(self.settings)
        self.agent = PlcControlAgent(self.plc, self.settings)
        self.mock = mock
        self._lock = threading.Lock()
        self._connected = False
        self._last_error: str | None = None
        self._last_status: dict[str, object] | None = None
        self._last_status_at = 0.0
        self._mock_started_at = time.time()
        self._mock_cooling_on = False
        self._mock_auto_mode = False
        self._persisted_config = self._load_ai_config()
        self._provider = self._initial_provider(self._persisted_config)
        self._api_key: str | None = self._initial_api_key(self._persisted_config)
        provider_defaults = PROVIDER_DEFAULTS[self._provider]
        self._api_base_url = os.getenv("AI_BASE_URL") or str(self._persisted_config.get("base_url") or provider_defaults["base_url"])
        self._api_model = (
            os.getenv("AI_MODEL")
            or os.getenv("OPENAI_MODEL")
            or str(self._persisted_config.get("model") or provider_defaults["model"])
        )

    def connect(self) -> None:
        if self.mock:
            return
        with self._lock:
            if self._connected:
                return
            self.plc.connect()
            self._connected = True

    def status(self) -> dict[str, object]:
        if self.mock:
            return self._mock_status()
        try:
            self.connect()
            plc_status = self.agent.read_status(timeout=5)
            self._last_error = None
            status = {
                "ok": True,
                "temperature_c": round(plc_status.temperature_c, 2),
                "cooling_on": plc_status.cooling_on,
                "device": self.settings.mqtt_device_sn,
                "broker": f"{self.settings.mqtt_host}:{self.settings.mqtt_port}",
                "topics": {
                    "tag_values": self.settings.topics.tag_values,
                    "command": self.settings.topics.command,
                },
                "thresholds": {
                    "on": self.settings.temp_on_c,
                    "off": self.settings.temp_off_c,
                },
                "error": None,
            }
            self._last_status = status
            self._last_status_at = time.time()
            return status
        except Exception as exc:
            self._last_error = str(exc)
            if self._last_status:
                stale_status = dict(self._last_status)
                stale_status["ok"] = True
                stale_status["stale"] = True
                stale_status["stale_seconds"] = round(time.time() - self._last_status_at, 1)
                stale_status["error"] = self._last_error
                return stale_status
            return {
                "ok": False,
                "temperature_c": None,
                "cooling_on": None,
                "device": self.settings.mqtt_device_sn,
                "broker": f"{self.settings.mqtt_host}:{self.settings.mqtt_port}",
                "topics": {
                    "tag_values": self.settings.topics.tag_values,
                    "command": self.settings.topics.command,
                },
                "thresholds": {
                    "on": self.settings.temp_on_c,
                    "off": self.settings.temp_off_c,
                },
                "error": self._last_error,
            }

    def command(self, action: str, text: str | None = None) -> dict[str, object]:
        if self.mock:
            return self._mock_command(action, text)
        try:
            self.connect()
            if action == "manual-on":
                decision = self.agent.manual_cooling(True)
                message = f"{decision.action}: {decision.reason}"
            elif action == "manual-off":
                decision = self.agent.manual_cooling(False)
                message = f"{decision.action}: {decision.reason}"
            elif action == "manual-mode":
                decision = self.agent.disable_auto_mode()
                message = f"{decision.action}: {decision.reason}"
            elif action == "auto-once":
                decision = self.agent.auto_control_once()
                message = f"{decision.action}: {decision.reason}"
            elif action == "text":
                message = self.agent.handle_text_command(text or "")
                if message == "__EXIT__":
                    message = "Web UI 会话保持运行"
            else:
                return {"ok": False, "message": f"Unknown action: {action}"}
            return {"ok": True, "message": message, "status": self.status()}
        except Exception as exc:
            return {"ok": False, "message": str(exc), "status": self.status()}

    def api_settings(self) -> dict[str, object]:
        return {
            "ok": True,
            "has_api_key": bool(self._api_key),
            "provider": self._provider,
            "base_url": self._api_base_url,
            "model": self._api_model,
            "source": self._api_config_source(),
            "config_path": str(AI_CONFIG_PATH),
        }

    def connection_settings(self) -> dict[str, object]:
        return {
            "ok": True,
            "device": self.settings.mqtt_device_sn,
            "broker": f"{self.settings.mqtt_host}:{self.settings.mqtt_port}",
            "topics": {
                "tag_values": self.settings.topics.tag_values,
                "command": self.settings.topics.command,
            },
            "config_path": str(PLC_CONFIG_PATH),
            "source": "env" if os.getenv("MQTT_DEVICE_SN") else ("local" if PLC_CONFIG_PATH.exists() else "default"),
        }

    def update_device(self, device: str) -> dict[str, object]:
        clean_device = device.strip()
        if not clean_device:
            response = self.connection_settings()
            response.update({"ok": False, "message": "Device 号不能为空"})
            return response
        if self._connected:
            try:
                self.plc.close()
            except Exception:
                pass
        save_local_device_config(clean_device)
        self.settings = Settings.from_env()
        self.plc = PlcMqttClient(self.settings)
        self.agent = PlcControlAgent(self.plc, self.settings)
        self._connected = False
        self._last_status = None
        self._last_error = None
        return {"ok": True, "message": f"Device 已保存为 {clean_device}", **self.connection_settings()}

    def update_api_settings(
        self,
        api_key: str | None,
        model: str | None,
        provider: str | None = None,
        base_url: str | None = None,
    ) -> dict[str, object]:
        clean_key = (api_key or "").strip()
        clean_model = (model or "").strip()
        clean_provider = (provider or self._provider).strip().lower()
        if clean_provider not in PROVIDER_DEFAULTS:
            clean_provider = "custom"
        clean_base_url = (base_url or "").strip()
        self._provider = clean_provider
        self._api_key = clean_key or None
        self._api_model = clean_model or PROVIDER_DEFAULTS[clean_provider]["model"]
        self._api_base_url = clean_base_url or PROVIDER_DEFAULTS[clean_provider]["base_url"]
        if self._api_key:
            self._save_ai_config()
        else:
            self._delete_ai_config()
        return self.api_settings()

    def ai_agent(self, message: str) -> dict[str, object]:
        clean_message = message.strip()
        if not clean_message:
            return {"ok": False, "message": "请输入要交给 AIagent 的自然语言指令。", "status": self.status()}

        used_ai = False
        intent: str
        reply_hint = ""
        if self._api_key:
            try:
                intent, reply_hint = self._classify_with_model(clean_message)
                used_ai = True
            except Exception as exc:
                intent, reply_hint = self._local_intent(clean_message), f"AI 请求失败，已切换本地规则：{exc}"
        else:
            intent, reply_hint = self._local_intent(clean_message), "未配置 API Key，已使用本地规则识别。"

        result = self._execute_ai_intent(intent)
        response_message = result["message"]
        if reply_hint and intent == "unknown":
            response_message = reply_hint
        elif reply_hint and not used_ai:
            response_message = f"{reply_hint} {response_message}"
        elif reply_hint and used_ai:
            response_message = f"{reply_hint} {response_message}"

        return {
            "ok": result["ok"],
            "message": response_message,
            "intent": intent,
            "used_ai": used_ai,
            "status": result.get("status") or self.status(),
        }

    def ai_agent_stream(self, message: str):
        yield self._json_line({"type": "wait", "message": "AI 正在分析指令..."})
        result = self.ai_agent(message)
        text = str(result.get("message") or "")
        for char in text:
            yield self._json_line({"type": "delta", "text": char})
            time.sleep(0.012)
        yield self._json_line(
            {
                "type": "done",
                "ok": result.get("ok"),
                "intent": result.get("intent"),
                "used_ai": result.get("used_ai"),
                "status": result.get("status"),
            }
        )

    @staticmethod
    def _json_line(payload: dict[str, object]) -> str:
        return json.dumps(payload, ensure_ascii=False) + "\n"

    def _execute_ai_intent(self, intent: str) -> dict[str, object]:
        if intent == "read_temperature":
            status = self.status()
            temp = status.get("temperature_c")
            cooling = status.get("cooling_on")
            cooling_text = "未知" if cooling is None else ("开启" if cooling else "关闭")
            if isinstance(temp, (int, float)):
                return {"ok": bool(status.get("ok")), "message": f"当前温度 {temp:.2f} C，散热状态：{cooling_text}", "status": status}
            return {"ok": False, "message": "温度读取失败，请检查 MQTT 连接。", "status": status}
        if intent == "cooling_on":
            return self.command("manual-on")
        if intent == "cooling_off":
            return self.command("manual-off")
        if intent == "auto_once":
            return self.command("auto-once")
        return {"ok": False, "message": "没有识别到可执行意图。可以说：读取温度、打开散热、关闭散热、自动控制一次。", "status": self.status()}

    def _local_intent(self, text: str) -> str:
        command = text.strip().lower()
        cooling_words = ("散热", "风扇", "fan", "cool", "cooling")
        if any(keyword in command for keyword in ("自动", "auto", "太高", "高于", "超过")) and any(word in command for word in cooling_words):
            return "auto_once"
        if any(keyword in command for keyword in ("温度", "状态", "status", "temp", "temperature", "多少")):
            return "read_temperature"
        if any(keyword in command for keyword in ("开", "打开", "启动", "on", "enable")) and any(word in command for word in cooling_words):
            return "cooling_on"
        if any(keyword in command for keyword in ("关", "关闭", "停止", "off", "disable")) and any(word in command for word in cooling_words):
            return "cooling_off"
        if any(keyword in command for keyword in ("自动", "auto")):
            return "auto_once"
        return "unknown"

    def _classify_with_model(self, text: str) -> tuple[str, str]:
        payload = {
            "model": self._api_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是 PLC 散热控制中控台的意图分类器。"
                        "只能返回 JSON，不要 Markdown。"
                        "intent 只能是 read_temperature、cooling_on、cooling_off、auto_once、unknown。"
                        "read_temperature 表示读取温度或状态；cooling_on 表示手动打开散热器；"
                        "cooling_off 表示手动关闭散热器；auto_once 表示按温度自动判断并控制一次。"
                        "reply 是一句简短中文回复前缀。"
                    ),
                },
                {"role": "user", "content": text},
            ],
            "temperature": 0,
            "max_tokens": 180,
        }
        req = urlrequest.Request(
            f"{self._api_base_url.rstrip('/')}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=18) as response:
                data = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenAI HTTP {exc.code}: {detail[:180]}") from exc

        raw_text = self._extract_response_text(data)
        try:
            parsed = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"模型返回不是 JSON: {raw_text[:120]}") from exc
        intent = str(parsed.get("intent", "unknown")).strip()
        if intent not in {"read_temperature", "cooling_on", "cooling_off", "auto_once", "unknown"}:
            intent = "unknown"
        return intent, str(parsed.get("reply", "")).strip()

    @staticmethod
    def _extract_response_text(data: dict[str, object]) -> str:
        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            first_choice = choices[0]
            if isinstance(first_choice, dict):
                message = first_choice.get("message")
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    return message["content"].strip()
        output_text = data.get("output_text")
        if isinstance(output_text, str):
            return output_text.strip()
        chunks: list[str] = []
        for item in data.get("output", []) if isinstance(data.get("output"), list) else []:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    chunks.append(part["text"])
        return "".join(chunks).strip()

    @staticmethod
    def _load_ai_config() -> dict[str, object]:
        try:
            if not AI_CONFIG_PATH.exists():
                return {}
            with AI_CONFIG_PATH.open("r", encoding="utf-8") as file:
                data = json.load(file)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_ai_config(self) -> None:
        AI_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "provider": self._provider,
            "base_url": self._api_base_url,
            "model": self._api_model,
            "api_key": self._api_key,
        }
        with AI_CONFIG_PATH.open("w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.write("\n")
        os.chmod(AI_CONFIG_PATH, 0o600)

    @staticmethod
    def _delete_ai_config() -> None:
        try:
            AI_CONFIG_PATH.unlink()
        except FileNotFoundError:
            pass

    def _api_config_source(self) -> str:
        if self._api_key and self._api_key in {os.getenv("OPENAI_API_KEY"), os.getenv("ARK_API_KEY")}:
            return "env"
        if self._api_key and AI_CONFIG_PATH.exists():
            return "local"
        return "memory"

    @staticmethod
    def _initial_provider(persisted: dict[str, object]) -> str:
        provider = os.getenv("AI_PROVIDER", "").strip().lower()
        if provider in PROVIDER_DEFAULTS:
            return provider
        if os.getenv("ARK_API_KEY") and not os.getenv("OPENAI_API_KEY"):
            return "doubao"
        saved_provider = str(persisted.get("provider", "")).strip().lower()
        if saved_provider in PROVIDER_DEFAULTS:
            return saved_provider
        return "openai"

    def _initial_api_key(self, persisted: dict[str, object]) -> str | None:
        if self._provider == "doubao":
            return os.getenv("ARK_API_KEY") or os.getenv("OPENAI_API_KEY") or str(persisted.get("api_key") or "") or None
        return os.getenv("OPENAI_API_KEY") or os.getenv("ARK_API_KEY") or str(persisted.get("api_key") or "") or None

    def _base_status(self, temperature_c: float, cooling_on: bool | None, stale: bool = False) -> dict[str, object]:
        return {
            "ok": True,
            "mock": self.mock,
            "stale": stale,
            "temperature_c": round(temperature_c, 2),
            "cooling_on": cooling_on,
            "device": self.settings.mqtt_device_sn,
            "broker": f"{self.settings.mqtt_host}:{self.settings.mqtt_port}",
            "topics": {
                "tag_values": self.settings.topics.tag_values,
                "command": self.settings.topics.command,
            },
            "thresholds": {
                "on": self.settings.temp_on_c,
                "off": self.settings.temp_off_c,
            },
            "registers": {
                "MW0": round(temperature_c * 100),
                "MW20": 1 if cooling_on else 0,
                "MW21": 1 if self._mock_auto_mode else 0,
                "MW22": 0,
            },
            "error": None,
        }

    def _mock_status(self) -> dict[str, object]:
        elapsed = time.time() - self._mock_started_at
        temperature_c = 29.5 + 5.8 * math.sin(elapsed / 8.0)
        status = self._base_status(temperature_c, self._mock_cooling_on)
        self._last_status = status
        self._last_status_at = time.time()
        return status

    def _mock_command(self, action: str, text: str | None = None) -> dict[str, object]:
        if action == "manual-on":
            self._mock_cooling_on = True
            self._mock_auto_mode = False
            message = "模拟: 散热 ON，已按 MW20 -> MW22 顺序触发"
        elif action == "manual-off":
            self._mock_cooling_on = False
            self._mock_auto_mode = False
            message = "模拟: 散热 OFF，已按 MW20 -> MW22 顺序触发"
        elif action == "manual-mode":
            self._mock_auto_mode = False
            message = "模拟: 已切换手动模式，MW21=0"
        elif action == "auto-once":
            self._mock_auto_mode = True
            status = self._mock_status()
            temp = float(status["temperature_c"])
            if temp >= self.settings.temp_on_c:
                self._mock_cooling_on = True
                message = f"模拟: 温度 {temp:.2f} C，自动打开散热"
            elif temp <= self.settings.temp_off_c:
                self._mock_cooling_on = False
                message = f"模拟: 温度 {temp:.2f} C，自动关闭散热"
            else:
                message = f"模拟: 温度 {temp:.2f} C，保持当前状态"
        elif action == "text":
            command_text = (text or "").strip()
            if "开" in command_text:
                self._mock_cooling_on = True
                message = "模拟自然语言: 打开散热"
            elif "关" in command_text:
                self._mock_cooling_on = False
                message = "模拟自然语言: 关闭散热"
            else:
                message = "模拟自然语言: 已读取温度"
        else:
            message = f"模拟: 未识别动作 {action}"
        return {"ok": True, "message": message, "status": self._mock_status()}


def create_app(mock: bool = False) -> Flask:
    root = Path(__file__).resolve().parent.parent
    web_dir = root / "web"
    static_dir = web_dir / "static"
    runtime = PlcWebRuntime(mock=mock)

    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")

    @app.get("/")
    def index():
        return send_from_directory(web_dir, "index.html")

    @app.get("/api/status")
    def api_status():
        return jsonify(runtime.status())

    @app.post("/api/command")
    def api_command():
        payload = request.get_json(silent=True) or {}
        return jsonify(runtime.command(str(payload.get("action", "")), payload.get("text")))

    @app.get("/api/settings")
    def api_settings():
        return jsonify(runtime.api_settings())

    @app.get("/api/connection-settings")
    def api_connection_settings():
        return jsonify(runtime.connection_settings())

    @app.post("/api/connection-settings/device")
    def api_connection_device():
        payload = request.get_json(silent=True) or {}
        return jsonify(runtime.update_device(str(payload.get("device", ""))))

    @app.post("/api/settings/api-key")
    def api_api_key():
        payload = request.get_json(silent=True) or {}
        return jsonify(
            runtime.update_api_settings(
                payload.get("api_key"),
                payload.get("model"),
                payload.get("provider"),
                payload.get("base_url"),
            )
        )

    @app.post("/api/ai-agent")
    def api_ai_agent():
        payload = request.get_json(silent=True) or {}
        return jsonify(runtime.ai_agent(str(payload.get("message", ""))))

    @app.post("/api/ai-agent/stream")
    def api_ai_agent_stream():
        payload = request.get_json(silent=True) or {}
        return Response(
            stream_with_context(runtime.ai_agent_stream(str(payload.get("message", "")))),
            mimetype="application/x-ndjson; charset=utf-8",
        )

    return app


def run_web_server(host: str = "127.0.0.1", port: int = 8067, debug: bool = False, mock: bool = False) -> None:
    app = create_app(mock=mock)
    app.run(host=host, port=port, debug=debug)
