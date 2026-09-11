# -*- coding: utf-8 -*-
"""多面体 · 网页版多性格聊天机器人（Flask + DeepSeek 流式接口）。

启动：python app.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template, request

from personas import MODEL_CHOICES, build_system_prompt, persona_public

BASE_DIR = Path(__file__).resolve().parent


def load_env_file(path: Path) -> None:
    """极简 .env 读取：已存在的真实环境变量优先。"""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(BASE_DIR / ".env")

API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
API_BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
CHAT_URL = f"{API_BASE}/chat/completions"
DEFAULT_MODEL = os.environ.get("DEEPSEEK_MODEL", MODEL_CHOICES[0])

MAX_HISTORY = 24          # 每次带给模型的最大消息条数
MAX_CHARS_PER_MSG = 8000  # 单条消息字符上限

app = Flask(__name__)
try:
    app.json.ensure_ascii = False          # Flask >= 2.2
except AttributeError:                     # 老版本 Flask
    app.config["JSON_AS_ASCII"] = False


def sse(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def clean_messages(raw) -> list[dict]:
    """只保留 user / assistant 的文本消息，并做长度与条数裁剪。"""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        content = content.strip()
        if not content:
            continue
        out.append({"role": role, "content": content[:MAX_CHARS_PER_MSG]})
    # 历史必须从 user 开始，避免 assistant 开头
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out[-MAX_HISTORY:]


def upstream_error(status: int, text: str) -> str:
    detail = ""
    try:
        data = json.loads(text or "{}")
        err = data.get("error") or {}
        detail = str(err.get("message") or data.get("message") or "").strip()
    except Exception:
        detail = (text or "").strip()[:200]

    hints = {
        400: "请求被拒绝了，常见原因是上下文太长或模型名不对。",
        401: "API Key 无效或已失效，检查 .env 里的 DEEPSEEK_API_KEY。",
        402: "DeepSeek 账户余额不足，充值后再试。",
        403: "这个 Key 没有调用该模型的权限。",
        422: "请求参数不合法。",
        429: "请求太频繁了，缓几秒再发。",
        500: "DeepSeek 服务端出错了，稍后重试。",
        503: "DeepSeek 服务繁忙，稍后重试。",
    }
    hint = hints.get(status) or hints.get(status - status % 100) or "调用 DeepSeek 接口失败。"
    return f"{hint}（HTTP {status}）" + (f" 详情：{detail}" if detail else "")


@app.get("/")
def index():
    personas = persona_public()
    personas_json = json.dumps(personas, ensure_ascii=False).replace("<", "\\u003c")
    return render_template(
        "index.html",
        personas_json=personas_json,
        models=MODEL_CHOICES,
        default_model=DEFAULT_MODEL,
    )


@app.get("/api/config")
def api_config():
    return jsonify(
        {
            "key_configured": bool(API_KEY),
            "key_hint": ("已配置 " + API_KEY[:6] + "…" + API_KEY[-4:]) if API_KEY else "未配置",
            "base_url": API_BASE,
            "models": MODEL_CHOICES,
            "default_model": DEFAULT_MODEL,
        }
    )


@app.post("/api/chat")
def api_chat():
    payload = request.get_json(silent=True) or {}
    messages = clean_messages(payload.get("messages"))
    if not messages:
        return jsonify({"error": "没有可发送的消息"}), 400

    persona_id = str(payload.get("persona") or "yujie")
    custom = payload.get("custom") if isinstance(payload.get("custom"), dict) else None
    model = payload.get("model") or DEFAULT_MODEL
    if model not in MODEL_CHOICES:
        model = DEFAULT_MODEL
    try:
        temperature = float(payload.get("temperature", 0.8))
    except (TypeError, ValueError):
        temperature = 0.8
    temperature = min(max(temperature, 0.0), 1.5)

    system_prompt = build_system_prompt(persona_id, custom)
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system_prompt}, *messages],
        "temperature": temperature,
        "stream": True,
    }
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"

    def generate():
        if not API_KEY:
            yield sse(
                {
                    "type": "error",
                    "message": "还没有配置 API Key。请在项目根目录的 .env 里填好 DEEPSEEK_API_KEY，然后重启服务。",
                }
            )
            yield "data: [DONE]\n\n"
            return

        yield sse({"type": "start", "model": model, "persona": persona_id})
        try:
            with requests.post(
                CHAT_URL, headers=headers, json=body, stream=True, timeout=(15, 300)
            ) as resp:
                if resp.status_code != 200:
                    text = resp.text[:600]
                    yield sse({"type": "error", "message": upstream_error(resp.status_code, text)})
                else:
                    # 不依赖 requests 猜编码：SSE 一律按 UTF-8 解。
                    for raw in resp.iter_lines(decode_unicode=False):
                        if not raw:
                            continue
                        line = raw.decode("utf-8", "replace")
                        if not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if chunk == "[DONE]":
                            break
                        try:
                            data = json.loads(chunk)
                        except json.JSONDecodeError:
                            continue
                        choices = data.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        if delta.get("reasoning_content"):
                            yield sse({"type": "reasoning", "text": delta["reasoning_content"]})
                        if delta.get("content"):
                            yield sse({"type": "delta", "text": delta["content"]})
        except requests.exceptions.Timeout:
            yield sse({"type": "error", "message": "等 DeepSeek 响应超时了，可以再发一次或换个更短的问题。"})
        except requests.exceptions.RequestException as exc:
            yield sse({"type": "error", "message": f"连不上 DeepSeek 接口：{exc.__class__.__name__}。检查网络或代理设置。"})

        # 用户中途点"停止"时生成器会被直接关闭，下面两行不会再执行。
        yield sse({"type": "end"})
        yield "data: [DONE]\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def pick_port(preferred: int) -> int:
    import socket

    for port in range(preferred, preferred + 10):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


if __name__ == "__main__":
    preferred = int(os.environ.get("PORT", "5000") or 5000)
    port = pick_port(preferred)
    print("=" * 56)
    print("  多面体 · 网页版多性格聊天机器人")
    print(f"  打开浏览器访问：http://127.0.0.1:{port}")
    print(f"  API Key：{'已配置' if API_KEY else '未配置（请在 .env 中填写）'}")
    print("  按 Ctrl+C 停止")
    print("=" * 56)
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
