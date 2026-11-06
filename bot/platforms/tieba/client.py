from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime
from urllib.parse import urlencode

import httpx

from platforms.tieba import config

BASE = "https://c.tieba.baidu.com"
WEB_BASE = "https://tieba.baidu.com"


def _sign(params: dict) -> str:
    raw = "".join(
        f"{k}={v}"
        for k, v in sorted(params.items(), key=lambda kv: kv[0])
        if v is not None and v != ""
    )
    return hashlib.md5((raw + config.APP_SECRET).encode()).hexdigest()


def _text_of(content) -> str:
    if not content:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(
            str(block.get("text", "")) if isinstance(block, dict) else str(block) for block in content
        ).strip()
    if isinstance(content, dict):
        return str(content.get("text", "")).strip()
    return str(content).strip()


def _n(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _cookie(cred: dict) -> str:
    if not cred.get("bduss"):
        return ""
    parts = [f"BDUSS={cred['bduss']}", f"BDUSS_BFESS={cred.get('bduss_bfess') or cred['bduss']}"]
    if cred.get("stoken"):
        parts.append(f"STOKEN={cred['stoken']}")
    if cred.get("baiduid"):
        parts.extend([f"BAIDUID={cred['baiduid']}", f"BAIDUID_BFESS={cred['baiduid']}"])
    parts.append("ka=open")
    return "; ".join(parts)


def _api_error(data: dict) -> str:
    code = str(data.get("error_code", data.get("errorCode", "")))
    if code in ("", "0"):
        return ""
    return f"{data.get('error_msg') or data.get('errorMsg') or '贴吧返回错误'}（code {code}）"


class TiebaClient:
    def __init__(self, timeout: float = 15.0):
        self.timeout = timeout
        self._last_call = 0.0
        # 读接口之间至少 3 秒：贴吧对短时间内的连续请求很敏感。
        self._min_interval = 3.0
        self._tbs = ""
        self._tbs_at = 0.0

    # ---------- 基础 ----------

    @property
    def credential(self) -> dict:
        return config.load_credential()

    @property
    def logged_in(self) -> bool:
        return bool(self.credential.get("bduss"))

    async def _throttle(self) -> None:
        now = time.monotonic()
        wait = self._min_interval - (now - self._last_call)
        if wait > 0:
            import asyncio

            await asyncio.sleep(wait)
        self._last_call = time.monotonic()

    async def _api(self, path: str, params: dict) -> dict:
        await self._throttle()
        payload = {
            "_client_version": config.CLIENT_VERSION,
            "_client_type": "2",
            "from": "tieba",
            "timestamp": str(int(time.time() * 1000)),
            **{k: v for k, v in params.items() if v is not None},
        }
        payload["sign"] = _sign(payload)
        headers = {
            "User-Agent": config.UA,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }
        cookie = _cookie(self.credential)
        if cookie:
            headers["Cookie"] = cookie
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                BASE + path, content=urlencode(payload), headers=headers
            )
            try:
                return resp.json()
            except ValueError as error:
                raise RuntimeError(f"贴吧返回不是 JSON（HTTP {resp.status_code}）") from error

    async def login_status(self) -> dict:
        if not self.logged_in:
            return {"logged_in": False, "detail": "没有登录凭据"}
        try:
            # 走 c.tieba.baidu.com 的客户端接口（tieba.baidu.com 对 Python TLS 指纹常超时）。
            data = await self._api(
                "/c/f/frs/page",
                {
                    "kw": "摸鱼",
                    "pn": "1",
                    "rn": "1",
                    "sort_type": "0",
                    "st_type": "tb_forumlist",
                    "with_group": "0",
                    "q_type": "2",
                },
            )
            user = data.get("user") or {}
            return {
                "logged_in": bool(user.get("is_login")),
                "detail": "已登录" if user.get("is_login") else "BDUSS 已失效",
                "user_id": str(user.get("id") or ""),
                "name": str(user.get("name_show") or user.get("name") or ""),
            }
        except Exception as error:  # noqa: BLE001 - 巡检需要把失败原因带出去
            return {"logged_in": False, "detail": f"查询失败：{error}"}

    async def _mobile_tbs(self) -> str:
        """写接口要的 24 位 tbs 在移动版首页里；newmoindex 的 16 位不行。"""
        cookie = _cookie(self.credential)
        if not cookie:
            raise RuntimeError("没有登录凭据")
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(
                WEB_BASE + "/mo/q/m?kw=%E6%91%B8%E9%B1%BC",
                headers={"User-Agent": config.MOBILE_UA, "Cookie": cookie, "Referer": WEB_BASE + "/"},
            )
            html = resp.text
        tbs = re.search(r'"tbs":"([^"]+)"', html)
        if not tbs or '"is_login":true' not in html:
            raise RuntimeError("登录态失效，拿不到 tbs")
        return tbs.group(1)

    # ---------- 读 ----------

    async def forum_page(self, kw: str, pn: int = 1, rn: int = 20) -> dict:
        data = await self._api(
            "/c/f/frs/page",
            {
                "kw": kw,
                "pn": str(pn),
                "rn": str(rn),
                "sort_type": "0",
                "st_type": "tb_forumlist",
                "with_group": "0",
                "q_type": "2",
                "scr_dip": "1",
                "scr_h": "1080",
                "scr_w": "1080",
            },
        )
        err = _api_error(data)
        if err:
            raise RuntimeError(err)
        threads = data.get("thread_list") or []
        return {
            "forum": data.get("forum") or {},
            "threads": [
                {
                    "tid": str(t.get("id", "")),
                    "title": str(t.get("title", "")).strip(),
                    "author": (t.get("author") or {}).get("name_show")
                    or (t.get("author") or {}).get("name", ""),
                    "author_id": str((t.get("author") or {}).get("id", "")),
                    "reply_num": _n(t.get("reply_num")),
                    "view_num": _n(t.get("view_num")),
                    "time": _n(t.get("last_reply_time") or t.get("create_time")),
                    "is_top": _n(t.get("is_top")),
                }
                for t in threads
            ],
            "page": data.get("page") or {},
        }

    async def thread_page(self, tid: str, pn: int = 1, rn: int = 30, floor_rn: int = 3) -> dict:
        data = await self._api(
            "/c/f/pb/page",
            {
                "kz": str(tid),
                "pn": str(pn),
                "rn": str(rn),
                "with_floor": "1",
                "floor_rn": str(floor_rn),
                "st_type": "tb_frslist",
                "back": "0",
                "mark": "0",
                "scr_dip": "1",
                "scr_h": "1080",
                "scr_w": "1080",
            },
        )
        err = _api_error(data)
        if err:
            raise RuntimeError(err)
        users = {
            str(u.get("id")): str(u.get("name_show") or u.get("name") or "")
            for u in (data.get("user_list") or [])
            if u.get("id")
        }
        posts = []
        for p in data.get("post_list") or []:
            subs = (p.get("sub_post_list") or {}).get("post_list") or []
            posts.append(
                {
                    "pid": str(p.get("id", "")),
                    "floor": _n(p.get("floor")),
                    "author_id": str(p.get("author_id", "")),
                    "author": users.get(str(p.get("author_id")), ""),
                    "content": _text_of(p.get("content")),
                    "time": _n(p.get("time")),
                    "agree": _n((p.get("agree") or {}).get("agree_num")),
                    "sub_number": _n(p.get("sub_post_number")),
                    "subs": [
                        {
                            "spid": str(s.get("id", "")),
                            "author_id": str(s.get("author_id", "")),
                            "author": users.get(str(s.get("author_id")), "")
                            or str((s.get("author") or {}).get("name_show", "")),
                            "content": _text_of(s.get("content")),
                            "time": _n(s.get("time")),
                        }
                        for s in subs
                    ],
                }
            )
        thread = data.get("thread") or {}
        forum = data.get("forum") or {}
        return {
            "tid": str(tid),
            "title": str(thread.get("title", "")),
            "forum_id": str(forum.get("id", "")),
            "forum_name": str(forum.get("name", "")),
            "reply_num": _n(thread.get("reply_num")),
            "collect_status": _n(thread.get("collect_status")),
            "page": _n((data.get("page") or {}).get("current_page", pn)),
            "total_page": _n((data.get("page") or {}).get("total_page")),
            "posts": posts,
        }

    async def sub_posts(self, tid: str, pid: str, pn: int = 1, rn: int = 20) -> dict:
        data = await self._api(
            "/c/f/pb/floor",
            {"kz": str(tid), "pid": str(pid), "pn": str(pn), "rn": str(rn)},
        )
        err = _api_error(data)
        if err:
            raise RuntimeError(err)
        sub = data.get("sub_post_list") or {}
        items = sub.get("post_list") if isinstance(sub, dict) else sub
        return {
            "tid": str(tid),
            "pid": str(pid),
            "items": [
                {
                    "spid": str(s.get("id", "")),
                    "author_id": str(s.get("author_id", "")),
                    "author": (s.get("author") or {}).get("name_show", ""),
                    "content": _text_of(s.get("content")),
                    "time": _n(s.get("time")),
                }
                for s in (items or [])
            ],
        }

    # ---------- 写 ----------

    async def _tbs(self) -> str:
        if self._tbs and time.monotonic() - self._tbs_at < 600:
            return self._tbs
        cookie = _cookie(self.credential)
        if not cookie:
            raise RuntimeError("没有登录凭据，写操作需要 BDUSS")
        self._tbs = await self._mobile_tbs()
        self._tbs_at = time.monotonic()
        return self._tbs

    async def like(self, tid: str, pid: str, target: str = "thread", action: str = "like") -> dict:
        tbs = await self._tbs()
        data = await self._api(
            "/c/c/agree/opAgree",
            {
                "thread_id": str(tid),
                "post_id": str(pid),
                "obj_type": "2" if target == "subpost" else "3",
                "agree_type": "2",
                "op_type": "0" if action == "like" else "1",
                "tbs": tbs,
                "stoken": self.credential.get("stoken", ""),
                "cuid_gid": "",
            },
        )
        err = _api_error(data)
        if err:
            raise RuntimeError(err)
        return {"ok": True, "tid": str(tid), "pid": str(pid), "target": target, "action": action}

    async def favorite(self, tid: str, action: str = "add", pid: str = "0") -> dict:
        tbs = await self._tbs()
        data = await self._api(
            "/c/c/post/addstore",
            {
                "data": json.dumps(
                    {"tid": str(tid), "pid": str(pid), "status": 1 if action == "add" else 0}
                ),
                "stoken": self.credential.get("stoken", ""),
                "tbs": tbs,
            },
        )
        err = _api_error(data)
        if err:
            raise RuntimeError(err)
        return {"ok": True, "tid": str(tid), "action": action}

    async def comment(
        self,
        tid: str,
        content: str,
        *,
        pid: str = "",
        spid: str = "",
        fid: str = "",
        kw: str = "",
        reply_uid: str = "",
    ) -> dict:
        tbs = await self._tbs()
        if not fid:
            page = await self.thread_page(tid, rn=1)
            fid = page["forum_id"]
            kw = page["forum_name"]
        target = "subpost" if spid else ("post" if pid else "thread")
        params = {
            "content": content,
            "fid": fid,
            "kw": kw,
            "tid": str(tid),
            "tbs": tbs,
            "stoken": self.credential.get("stoken", ""),
            "is_ad": "0",
            "is_feedback": "0",
            "is_barrage": "0",
            "new_vcode": "1",
            "vcode_tag": "12",
            "anonymous": "1",
            "post_from": "3" if target == "thread" else "0",
        }
        if target != "thread":
            params["quote_id"] = pid or "0"
            params["repostid"] = pid or "0"
            if spid:
                params["sub_post_id"] = spid
            if reply_uid:
                params["reply_uid"] = reply_uid
        data = await self._api("/c/c/post/add", params)
        err = _api_error(data)
        if err:
            raise RuntimeError(err)
        payload = data.get("data") or {}
        return {
            "ok": True,
            "tid": str(tid),
            "target": target,
            "pid": str(payload.get("pid") or payload.get("post_id") or ""),
            "content": content,
        }
