from __future__ import annotations

import json
import threading
import time
from typing import Any

import paho.mqtt.client as mqtt

from .config import Settings


class PlcMqttClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._register_values: dict[str, str] = {}
        self._lock = threading.Lock()
        self._connected = threading.Event()
        self._connection_error: str | None = None
        self._client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        if settings.mqtt_username:
            self._client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

    def connect(self) -> None:
        self._client.connect(self.settings.mqtt_host, self.settings.mqtt_port, keepalive=30)
        self._client.loop_start()
        if not self._connected.wait(timeout=5):
            if self._connection_error:
                raise ConnectionError(self._connection_error)
            raise TimeoutError(
                f"Timed out connecting to MQTT broker "
                f"{self.settings.mqtt_host}:{self.settings.mqtt_port}"
            )

    def close(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()

    def publish_registers(self, values: dict[str, int | float | str]) -> None:
        payload = json.dumps(
            [
                {
                    "DeviceSN": self.settings.mqtt_device_sn,
                    "TagData": [values],
                }
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        result = self._client.publish(
            self.settings.topics.command,
            payload,
            qos=self.settings.mqtt_qos,
            retain=False,
        )
        result.wait_for_publish(timeout=3)
        if result.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"MQTT publish failed for {self.settings.topics.command}: rc={result.rc}")
        with self._lock:
            self._register_values.update({str(key): str(value) for key, value in values.items()})

    def subscribe(self, topic: str) -> None:
        result, _ = self._client.subscribe(topic, qos=self.settings.mqtt_qos)
        if result != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"MQTT subscribe failed for {topic}: rc={result}")

    def wait_for_register(self, register: str, timeout: float = 5) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if register in self._register_values:
                    return self._register_values[register]
            time.sleep(0.05)
        raise TimeoutError(f"No MQTT value received for {register} within {timeout}s")

    def _on_connect(
        self,
        client: mqtt.Client,
        userdata: Any,
        flags: mqtt.ConnectFlags,
        reason_code: mqtt.ReasonCode,
        properties: mqtt.Properties | None,
    ) -> None:
        if reason_code.is_failure:
            self._connection_error = f"MQTT connection failed: {reason_code}"
            return
        self._connected.set()
        self.subscribe(self.settings.topics.tag_values)

    def _on_disconnect(
        self,
        client: mqtt.Client,
        userdata: Any,
        flags: mqtt.DisconnectFlags,
        reason_code: mqtt.ReasonCode,
        properties: mqtt.Properties | None,
    ) -> None:
        self._connected.clear()

    def _on_message(self, client: mqtt.Client, userdata: Any, msg: mqtt.MQTTMessage) -> None:
        if msg.topic != self.settings.topics.tag_values:
            return
        values = self._decode_tag_values(msg.payload)
        with self._lock:
            self._register_values.update(values)

    @staticmethod
    def _decode_tag_values(payload: bytes) -> dict[str, str]:
        text = payload.decode("utf-8", errors="replace").strip()
        if not text:
            return {}
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            return {}

        updates: dict[str, str] = {}
        records = decoded if isinstance(decoded, list) else [decoded]
        for record in records:
            if not isinstance(record, dict):
                continue
            tag_data = record.get("TagData", [])
            if isinstance(tag_data, dict):
                tag_data = [tag_data]
            for item in tag_data:
                if not isinstance(item, dict):
                    continue
                for key, value in item.items():
                    if key == "Time":
                        continue
                    updates[str(key)] = str(value)
        return updates
