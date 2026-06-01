from pathlib import Path


def replace_once(path: str, needle: str, replacement: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if replacement in text:
        return
    if needle not in text:
        raise SystemExit(f"Patch target not found in {path}")
    target.write_text(text.replace(needle, replacement, 1), encoding="utf-8")


replace_once(
    "core/middleware.py",
    "img-src 'self' data: blob:; ",
    "img-src 'self' data: blob: https: http:; ",
)

replace_once(
    "static/app.js",
    "const UI_VIS_DEFAULT_OFF = new Set(['models-section', 'rag-toggle-btn']);",
    "const UI_VIS_DEFAULT_OFF = new Set(['models-section', 'rag-toggle-btn', 'text-emojis']);",
)

replace_once(
    "static/app.js",
    "    applyTextEmojis(state['text-emojis'] !== false);",
    "    applyTextEmojis(state['text-emojis'] === true);",
)

replace_once(
    "static/js/emailLibrary/utils.js",
    """  const isDangerousUrl = (val) => {
    if (!val) return false;
    const v = val.trim().toLowerCase();
    return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:');
  };
""",
    """  const isDangerousUrl = (val, attrName, tagName) => {
    if (!val) return false;
    const v = val.trim().toLowerCase();
    if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return true;
    if (v.startsWith('data:')) {
      return !(tagName === 'IMG' && attrName === 'src' && /^data:image\\/(png|gif|jpe?g|webp|svg\\+xml);/i.test(v));
    }
    return false;
  };
""",
)

replace_once(
    "static/js/emailLibrary/utils.js",
    """      if (URL_ATTRS.includes(name) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
""",
    """      if (URL_ATTRS.includes(name) && isDangerousUrl(attr.value, name, el.tagName)) {
        el.removeAttribute(attr.name);
        continue;
      }
""",
)

replace_once(
    "static/js/emailLibrary/utils.js",
    """    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
""",
    """    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
      el.style.maxWidth = '100%';
      el.style.height = 'auto';
    }
""",
)

replace_once(
    "src/llm_core.py",
    "import httpx\nimport asyncio\n",
    "import httpx\nimport asyncio\nimport os\n",
)

replace_once(
    "src/llm_core.py",
    """class LLMConfig:
    """ + '"""' + """Configuration constants for LLM operations.""" + '"""' + """
    DEFAULT_TIMEOUT = 30
    DEFAULT_TEMPERATURE = 1.0
    DEFAULT_MAX_TOKENS = 0
    MAX_RETRIES = 3
    RETRY_DELAY = 0.5
    STREAM_TIMEOUT = 300
""",
    """def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


class LLMConfig:
    """ + '"""' + """Configuration constants for LLM operations.""" + '"""' + """
    DEFAULT_TIMEOUT = _env_int("LLM_DEFAULT_TIMEOUT", 60)
    DEFAULT_TEMPERATURE = 1.0
    DEFAULT_MAX_TOKENS = 0
    MAX_RETRIES = 3
    RETRY_DELAY = 0.5
    STREAM_TIMEOUT = _env_int("LLM_STREAM_TIMEOUT", 900)
""",
)

replace_once(
    "src/llm_core.py",
    """def _provider_label(url: str) -> str:
    """ + '"""' + """Human-friendly provider name for error messages.""" + '"""' + """
""",
    """def _provider_label(url: str) -> str:
    """ + '"""' + """Human-friendly provider name for error messages.""" + '"""' + """
""",
)

replace_once(
    "src/llm_core.py",
    """    except Exception:
        return "provider"


def _format_upstream_error(status: int, body: bytes | str, url: str) -> str:
""",
    """    except Exception:
        return "provider"


def _effective_llm_timeout(url: str, timeout: int | float | None) -> int:
    base = int(timeout or LLMConfig.DEFAULT_TIMEOUT)
    label = _provider_label(url).lower()
    if "ollama" in label or "local endpoint" in label or ":11434" in (url or ""):
        return max(base, _env_int("LLM_LOCAL_TIMEOUT", 180))
    return max(base, _env_int("LLM_DEFAULT_TIMEOUT", base))


def _format_upstream_error(status: int, body: bytes | str, url: str) -> str:
""",
)

replace_once(
    "src/llm_core.py",
    """        note_model_activity(target_url, model)
        r = httpx.post(target_url, headers=h, json=payload, timeout=timeout)
""",
    """        note_model_activity(target_url, model)
        r = httpx.post(target_url, headers=h, json=payload, timeout=_effective_llm_timeout(target_url, timeout))
""",
)

replace_once(
    "src/llm_core.py",
    """    call_timeout = httpx.Timeout(connect=3.0, read=float(timeout), write=10.0, pool=5.0)
""",
    """    effective_timeout = _effective_llm_timeout(target_url, timeout)
    call_timeout = httpx.Timeout(connect=3.0, read=float(effective_timeout), write=10.0, pool=5.0)
""",
)

replace_once(
    "src/settings.py",
    "import logging\nfrom typing import Any\n",
    "import logging\nimport os\nfrom typing import Any\n",
)

replace_once(
    "src/settings.py",
    '''    "agent_max_tool_calls": 0,
    "agent_input_token_budget": 6000,
    "agent_stream_timeout_seconds": 300,
''',
    '''    "agent_max_tool_calls": int(os.environ.get("AGENT_MAX_TOOL_CALLS", "0")),
    "agent_input_token_budget": int(os.environ.get("AGENT_INPUT_TOKEN_BUDGET", "12000")),
    "agent_stream_timeout_seconds": int(os.environ.get("AGENT_STREAM_TIMEOUT_SECONDS", "900")),
''',
)
