from __future__ import annotations

import hmac
from datetime import datetime

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request

from platforms.tieba import config
from platforms.tieba.client import TiebaClient


def _auth(request: Request) -> None:
    token = getattr(request.app.state, "token", None)
    if not token:
        return
    header = request.headers.get("authorization", "")
    if not hmac.compare_digest(header, f"Bearer {token}"):
        raise HTTPException(401, "unauthorized")


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def create_app(token: str | None = None, client: TiebaClient | None = None) -> FastAPI:
    app = FastAPI(title="tieba gateway", version="0.1.0")
    app.state.client = client or TiebaClient()
    app.state.token = token

    @app.get("/health")
    async def health() -> dict:
        # 只报进程存活：登录检查要请求外部站点，放进 /status，别把探活拖成 10 秒。
        return {"ok": True, "service": "tieba-gateway", "version": "0.1.0"}

    @app.get("/status", dependencies=[Depends(_auth)])
    async def status() -> dict:
        login = await app.state.client.login_status()
        state = config.read_state()
        daily = state.get("daily") or {}
        return {
            "logged_in": login.get("logged_in", False),
            "detail": login.get("detail", ""),
            "user_id": login.get("user_id", ""),
            "daily": daily if daily.get("date") == _today() else {"date": _today(), "comments": 0, "likes": 0, "favorites": 0},
            "seen": len(state.get("seen") or {}),
        }

    @app.get("/feed", dependencies=[Depends(_auth)])
    async def feed(
        forums: str = Query("", description="吧名，逗号或空格分隔；空=默认兴趣"),
        count: int = Query(6, ge=1, le=10),
    ) -> dict:
        names = [s for s in forums.replace("，", ",").replace(" ", ",").split(",") if s]
        names = names[:8] or ["摸鱼", "职场", "生活", "心理", "科技", "电影"]
        client = app.state.client
        seen = config.read_state().get("seen") or {}
        items = []
        failed = []
        for name in names:
            try:
                page = await client.forum_page(name)
                for t in page["threads"]:
                    if not t["tid"] or not t["title"] or t["is_top"] or t["tid"] in seen:
                        continue
                    items.append({**t, "forum": name})
            except Exception as error:  # noqa: BLE001 - 失败的吧带出去，不影响其它
                failed.append(f"{name}: {error}")
        items.sort(key=lambda x: (x["reply_num"], x["time"]), reverse=True)
        return {"ok": True, "items": items[:count], "failed": failed}

    @app.get("/read", dependencies=[Depends(_auth)])
    async def read(
        tid: str = Query(..., description="帖子 id"),
        pn: int = Query(1, ge=1),
        rn: int = Query(30, ge=1, le=50),
    ) -> dict:
        if not tid.isdigit():
            raise HTTPException(400, "tid 必须是数字")
        try:
            return {"ok": True, **(await app.state.client.thread_page(tid, pn=pn, rn=rn))}
        except Exception as error:  # noqa: BLE001
            raise HTTPException(502, str(error)) from error

    @app.get("/comments", dependencies=[Depends(_auth)])
    async def comments(
        tid: str = Query(...),
        pid: str = Query(...),
        pn: int = Query(1, ge=1),
        rn: int = Query(20, ge=1, le=50),
    ) -> dict:
        if not tid.isdigit() or not pid.isdigit():
            raise HTTPException(400, "tid 和 pid 必须是数字")
        try:
            return {"ok": True, **(await app.state.client.sub_posts(tid, pid, pn=pn, rn=rn))}
        except Exception as error:  # noqa: BLE001
            raise HTTPException(502, str(error)) from error

    return app


def main() -> None:
    config.ensure_dirs()
    app = create_app(token=config.ensure_token())
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()
