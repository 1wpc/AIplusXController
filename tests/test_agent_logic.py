from __future__ import annotations

import unittest

from aiplusx_plc_agent.agent import PlcControlAgent
from aiplusx_plc_agent.config import Settings


class FakePlc:
    def __init__(self, values: dict[str, str] | None = None) -> None:
        self.values = values or {}
        self.published: list[tuple[str, int | float | str]] = []

    def wait_for_topic(self, topic: str, timeout: float = 5) -> str:
        if topic not in self.values:
            raise TimeoutError(topic)
        return self.values[topic]

    def wait_for_register(self, register: str, timeout: float = 5) -> str:
        if register not in self.values:
            raise TimeoutError(register)
        return self.values[register]

    def publish_registers(self, values: dict[str, int | float | str]) -> None:
        self.published.append(values)
        for key, value in values.items():
            self.values[key] = str(value)


def make_agent(fake_plc: FakePlc | None = None) -> tuple[PlcControlAgent, FakePlc, Settings]:
    settings = Settings.from_env()
    plc = fake_plc or FakePlc()
    return PlcControlAgent(plc, settings), plc, settings


class AgentLogicTest(unittest.TestCase):
    def test_temperature_payload_is_divided_by_100(self) -> None:
        self.assertEqual(PlcControlAgent.parse_temperature_payload("2650"), 26.5)

    def test_manual_on_writes_cooling_then_manual_trigger(self) -> None:
        agent, plc, settings = make_agent()

        agent.manual_cooling(True)

        self.assertEqual(
            plc.published,
            [
                {settings.registers.auto_mode: 0},
                {settings.registers.cooling: 1},
                {settings.registers.manual_trigger: 1},
            ],
        )

    def test_manual_off_resets_manual_trigger_before_closing(self) -> None:
        agent, plc, settings = make_agent()

        agent.manual_cooling(False)

        self.assertEqual(
            plc.published,
            [
                {settings.registers.auto_mode: 0},
                {settings.registers.manual_trigger: 0},
                {settings.registers.cooling: 0},
                {settings.registers.manual_trigger: 1},
            ],
        )

    def test_disable_auto_mode_writes_mw21_zero(self) -> None:
        agent, plc, settings = make_agent()

        agent.disable_auto_mode()

        self.assertEqual(plc.published, [{settings.registers.auto_mode: 0}])

    def test_auto_decision_uses_hysteresis(self) -> None:
        agent, _, _ = make_agent()

        self.assertEqual(agent.decide_auto_action(31).action, "打开散热")
        agent.manual_cooling(True)
        self.assertEqual(agent.decide_auto_action(29).action, "保持当前状态")
        self.assertEqual(agent.decide_auto_action(27).action, "关闭散热")


if __name__ == "__main__":
    unittest.main()
