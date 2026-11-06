from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "tieba"
SECRETS_DIR = ROOT / "data" / "secrets"
CREDENTIAL_FILE = SECRETS_DIR / "tieba_credential.json"
TOKEN_FILE = SECRETS_DIR / "tieba_token"
STATE_FILE = DATA_DIR / "state.json"

HOST = "127.0.0.1"
PORT = int(os.environ.get("TIEBA_PORT", "6282"))

# 贴吧 Android 客户端的签名密钥（公开在开源客户端里，不是账号凭据）。
APP_SECRET = "tiebaclient!!!"
CLIENT_VERSION = "12.25.1.0"
UA = "bdtb for Android 12.25.1.0"
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
)


def ensure_dirs() -> None:
    for path in (DATA_DIR, SECRETS_DIR, DATA_DIR / "logs"):
        path.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass


def ensure_token() -> str:
    ensure_dirs()
    if TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text().strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(token + "\n")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    return token


def load_credential() -> dict:
    try:
        return json.loads(CREDENTIAL_FILE.read_text())
    except (OSError, ValueError):
        return {}


def read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {"seen": {}, "forums": {}, "actions": [], "daily": {}}


def write_state(state: dict) -> None:
    ensure_dirs()
    tmp = STATE_FILE.with_suffix(f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(state, ensure_ascii=False))
    os.replace(tmp, STATE_FILE)
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass
