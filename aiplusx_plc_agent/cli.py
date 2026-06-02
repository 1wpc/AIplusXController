from __future__ import annotations

import argparse

from .agent import PlcControlAgent
from .config import Settings
from .mqtt_plc import PlcMqttClient


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI Agent for MQTT PLC control")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("chat", help="交互式自然语言控制")
    subparsers.add_parser("status", help="读取温度和散热状态")
    subparsers.add_parser("manual-on", help="手动打开散热")
    subparsers.add_parser("manual-off", help="手动关闭散热")
    subparsers.add_parser("auto-once", help="执行一次自动判断和控制")

    auto_parser = subparsers.add_parser("auto", help="持续自动控制")
    auto_parser.add_argument("--on", type=float, dest="temp_on_c", help="开启散热温度")
    auto_parser.add_argument("--off", type=float, dest="temp_off_c", help="关闭散热温度")
    auto_parser.add_argument("--interval", type=float, help="控制周期，单位秒")

    web_parser = subparsers.add_parser("web", help="启动赛博朋克 Web 中控台")
    web_parser.add_argument("--host", default="127.0.0.1", help="Web 服务监听地址")
    web_parser.add_argument("--port", type=int, default=8067, help="Web 服务端口")
    web_parser.add_argument("--debug", action="store_true", help="开启 Flask debug 模式")
    web_parser.add_argument("--mock", action="store_true", help="使用模拟温度数据，不连接 MQTT")

    return parser


def apply_overrides(settings: Settings, args: argparse.Namespace) -> Settings:
    updates = {}
    if getattr(args, "temp_on_c", None) is not None:
        updates["temp_on_c"] = args.temp_on_c
    if getattr(args, "temp_off_c", None) is not None:
        updates["temp_off_c"] = args.temp_off_c
    if getattr(args, "interval", None) is not None:
        updates["control_interval_seconds"] = args.interval
    if not updates:
        return settings
    new_settings = settings.__class__(**{**settings.__dict__, **updates})
    if new_settings.temp_off_c > new_settings.temp_on_c:
        raise ValueError("--off must be less than or equal to --on")
    return new_settings


def run_with_agent(args: argparse.Namespace) -> int:
    if args.command == "web":
        from .web_server import run_web_server

        run_web_server(host=args.host, port=args.port, debug=args.debug, mock=args.mock)
        return 0

    settings = apply_overrides(Settings.from_env(), args)
    plc = PlcMqttClient(settings)
    plc.connect()
    agent = PlcControlAgent(plc, settings)

    try:
        if args.command == "status":
            status = agent.read_status()
            cooling = "未知" if status.cooling_on is None else ("开启" if status.cooling_on else "关闭")
            print(f"当前温度: {status.temperature_c:.2f} C")
            print(f"散热状态: {cooling}")
            return 0

        if args.command == "manual-on":
            print(agent.manual_cooling(True))
            return 0

        if args.command == "manual-off":
            print(agent.manual_cooling(False))
            return 0

        if args.command == "auto-once":
            print(agent.auto_control_once())
            return 0

        if args.command == "auto":
            agent.run_auto_loop()
            return 0

        if args.command == "chat":
            print("AI Agent 已连接 MQTT。输入：温度、打开散热、关闭散热、自动、退出")
            while True:
                user_text = input("> ")
                response = agent.handle_text_command(user_text)
                if response == "__EXIT__":
                    print("已退出。")
                    return 0
                print(response)

        raise ValueError(f"Unknown command: {args.command}")
    finally:
        plc.close()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return run_with_agent(args)
