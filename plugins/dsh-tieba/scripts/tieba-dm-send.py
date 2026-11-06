#!/usr/bin/env python3
"""tieba-dm-send.py — 用贴吧账号发私信，并可选拉一次该会话消息。

贴吧私信走 IM WebSocket（CMD 205001 发送、202003 拉消息），公开 HTTP 接口拿不到。
用法：python3 tieba-dm-send.py --user-id 16129383 --text "内容" [--pull]
输出一行 JSON。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import aiotieba
from aiotieba.api.send_msg._api import request as send_request
from aiotieba.const import CHAT_VERSION


def load_cred(path: str) -> dict:
    return json.loads(Path(path).read_text())


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--pull", action="store_true", help="发送后拉一次该会话的消息")
    parser.add_argument(
        "--credential",
        default=str(Path.home() / "AI_develop/chat_bot/data/secrets/tieba_credential.json"),
    )
    args = parser.parse_args()

    cred = load_cred(args.credential)
    if not cred.get("bduss"):
        print(json.dumps({"ok": False, "error": "没有登录凭据"}, ensure_ascii=False))
        return

    try:
        async with aiotieba.Client(cred["bduss"], cred.get("stoken") or "") as client:
            ok = await client.init_websocket()
            if not ok:
                print(json.dumps({"ok": False, "error": "IM WebSocket 连不上"}, ensure_ascii=False))
                return
            ws_core = client._ws_cores.get(CHAT_VERSION)
            if ws_core is None:
                print(json.dumps({"ok": False, "error": "CHAT WebSocket 未就绪"}, ensure_ascii=False))
                return
            # local_msg_id 用时间戳：每次新进程从 1 开始会被服务端判重复（msgId is 0）。
            ws_core.mid_manager.update_local_msg_id(args.user_id, int(time.time() * 1000) % 10**12)
            result = await send_request(ws_core, args.user_id, args.text)
            out = {
                "ok": True,
                "group_id": getattr(result, "group_id", 0),
                "to_uid": getattr(result, "to_uid", 0),
                "local_msg_id": getattr(result, "local_msg_id", 0),
                "msg_id": getattr(result, "msg_id", 0),
            }
            if args.pull and out["group_id"]:
                groups = await client.get_group_msg([out["group_id"]], get_type=1)
                messages = []
                for group in groups:
                    for message in group.messages:
                        user = getattr(message, "user", None)
                        messages.append(
                            {
                                "msg_id": getattr(message, "msg_id", 0),
                                "type": str(getattr(message, "msg_type", "")),
                                "text": str(getattr(message, "text", "")),
                                "user_id": getattr(user, "user_id", 0) if user else 0,
                                "user_name": getattr(user, "name", "") if user else "",
                            }
                        )
                out["messages"] = messages
            print(json.dumps(out, ensure_ascii=False))
    except Exception as error:  # noqa: BLE001 - 把失败原因交给调用方
        print(json.dumps({"ok": False, "error": str(error)[:300]}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
