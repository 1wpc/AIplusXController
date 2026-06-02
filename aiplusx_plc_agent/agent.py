from __future__ import annotations

import time
from dataclasses import dataclass

from .config import Settings
from .mqtt_plc import PlcMqttClient


@dataclass(frozen=True)
class PlcStatus:
    temperature_c: float
    cooling_on: bool | None


@dataclass(frozen=True)
class AgentDecision:
    action: str
    reason: str
    changed: bool


class PlcControlAgent:
    def __init__(self, plc: PlcMqttClient, settings: Settings) -> None:
        self.plc = plc
        self.settings = settings
        self._last_cooling_state: bool | None = None

    def read_temperature_c(self, timeout: float = 5) -> float:
        raw = self.plc.wait_for_register(
            self.settings.registers.temperature_raw,
            timeout=timeout,
        )
        return self.parse_temperature_payload(raw)

    def read_status(self, timeout: float = 5) -> PlcStatus:
        temperature = self.read_temperature_c(timeout=timeout)
        cooling_on = None
        try:
            cooling_raw = self.plc.wait_for_register(
                self.settings.registers.cooling,
                timeout=0.5,
            )
            cooling_on = self._to_bool(cooling_raw)
            self._last_cooling_state = cooling_on
        except TimeoutError:
            pass
        return PlcStatus(temperature_c=temperature, cooling_on=cooling_on)

    def manual_cooling(self, turn_on: bool) -> AgentDecision:
        self.disable_auto_mode()
        if not turn_on:
            self.plc.publish_registers({self.settings.registers.manual_trigger: 0})
        self.plc.publish_registers({self.settings.registers.cooling: 1 if turn_on else 0})
        time.sleep(self.settings.manual_trigger_delay_seconds)
        self.plc.publish_registers({self.settings.registers.manual_trigger: 1})
        self._last_cooling_state = turn_on
        action = "打开散热" if turn_on else "关闭散热"
        reason = "已写入 MW21=0，并按 MW20 -> MW22 的顺序写入"
        if not turn_on:
            reason = "已写入 MW21=0，先置 MW22=0，再按 MW20 -> MW22 的顺序关闭"
        return AgentDecision(action=action, reason=reason, changed=True)

    def enable_auto_mode(self) -> AgentDecision:
        self.plc.publish_registers({self.settings.registers.auto_mode: 1})
        return AgentDecision(action="进入自动模式", reason="已写入 MW21=1", changed=True)

    def disable_auto_mode(self) -> AgentDecision:
        self.plc.publish_registers({self.settings.registers.auto_mode: 0})
        return AgentDecision(action="进入手动模式", reason="已写入 MW21=0", changed=True)

    def auto_set_cooling(self, turn_on: bool) -> AgentDecision:
        self.plc.publish_registers(
            {
                self.settings.registers.cooling: 1 if turn_on else 0,
                self.settings.registers.auto_mode: 1,
            }
        )
        self._last_cooling_state = turn_on
        action = "打开散热" if turn_on else "关闭散热"
        return AgentDecision(action=action, reason="自动模式按温度决策写入 MW21 和 MW20", changed=True)

    def decide_auto_action(self, temperature_c: float) -> AgentDecision:
        if temperature_c >= self.settings.temp_on_c:
            if self._last_cooling_state is True:
                return AgentDecision("保持散热开启", f"温度 {temperature_c:.2f} C 仍高于开启阈值", False)
            return AgentDecision("打开散热", f"温度 {temperature_c:.2f} C >= {self.settings.temp_on_c:.2f} C", True)

        if temperature_c <= self.settings.temp_off_c:
            if self._last_cooling_state is False:
                return AgentDecision("保持散热关闭", f"温度 {temperature_c:.2f} C 仍低于关闭阈值", False)
            return AgentDecision("关闭散热", f"温度 {temperature_c:.2f} C <= {self.settings.temp_off_c:.2f} C", True)

        state = "开启" if self._last_cooling_state else "关闭"
        return AgentDecision("保持当前状态", f"温度 {temperature_c:.2f} C 位于回差区间，散热保持{state}", False)

    def auto_control_once(self) -> AgentDecision:
        self.enable_auto_mode()
        status = self.read_status()
        decision = self.decide_auto_action(status.temperature_c)
        if decision.action == "打开散热":
            return self.auto_set_cooling(True)
        if decision.action == "关闭散热":
            return self.auto_set_cooling(False)
        return decision

    def run_auto_loop(self) -> None:
        self.enable_auto_mode()
        while True:
            status = self.read_status()
            decision = self.decide_auto_action(status.temperature_c)
            if decision.action == "打开散热":
                decision = self.auto_set_cooling(True)
            elif decision.action == "关闭散热":
                decision = self.auto_set_cooling(False)
            print(
                f"[auto] temperature={status.temperature_c:.2f} C, "
                f"action={decision.action}, reason={decision.reason}",
                flush=True,
            )
            time.sleep(self.settings.control_interval_seconds)

    def handle_text_command(self, text: str) -> str:
        command = text.strip().lower()
        if not command:
            return "请输入命令，例如：温度、打开散热、关闭散热、自动、退出"

        if any(keyword in command for keyword in ("退出", "quit", "exit", "q")):
            return "__EXIT__"

        if any(keyword in command for keyword in ("温度", "状态", "status", "temp")):
            status = self.read_status()
            cooling = "未知" if status.cooling_on is None else ("开启" if status.cooling_on else "关闭")
            return f"当前温度 {status.temperature_c:.2f} C，散热状态：{cooling}"

        if any(keyword in command for keyword in ("自动", "auto")):
            decision = self.auto_control_once()
            return f"{decision.action}：{decision.reason}"

        if (
            any(keyword in command for keyword in ("开", "打开", "启动", "on"))
            and any(keyword in command for keyword in ("散热", "风扇", "fan", "cool"))
        ):
            decision = self.manual_cooling(True)
            return f"{decision.action}：{decision.reason}"

        if (
            any(keyword in command for keyword in ("关", "关闭", "停止", "off"))
            and any(keyword in command for keyword in ("散热", "风扇", "fan", "cool"))
        ):
            decision = self.manual_cooling(False)
            return f"{decision.action}：{decision.reason}"

        return "没有识别到控制意图。可输入：温度、打开散热、关闭散热、自动、退出"

    @staticmethod
    def parse_temperature_payload(payload: str) -> float:
        return float(payload) / 100.0

    @staticmethod
    def _to_bool(payload: str) -> bool:
        return str(payload).strip().lower() in {"1", "true", "on", "yes"}
