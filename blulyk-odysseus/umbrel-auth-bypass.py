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
    "src/auth_helpers.py",
    "from typing import Optional\nfrom fastapi import Request, HTTPException\n",
    "from typing import Optional\nimport os\nfrom fastapi import Request, HTTPException\n",
)

replace_once(
    "src/auth_helpers.py",
    """def get_current_user(request: Request) -> Optional[str]:
    """ + '"""' + """Get current username from request state (set by auth middleware).""" + '"""' + """
    return getattr(request.state, 'current_user', None)
""",
    """def get_current_user(request: Request) -> Optional[str]:
    """ + '"""' + """Get current username from request state (set by auth middleware).""" + '"""' + """
    u = getattr(request.state, 'current_user', None)
    if u:
        return u
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        auth_mgr = getattr(request.app.state, "auth_manager", None)
        try:
            users = getattr(auth_mgr, "users", {}) if auth_mgr is not None else {}
            for username, data in users.items():
                if data.get("is_admin") is True:
                    return username
            return next(iter(users), None)
        except Exception:
            return None
    return None
""",
)

replace_once(
    "src/auth_helpers.py",
    """    u = get_current_user(request)
    if u:
        return u
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if auth_mgr is not None and getattr(auth_mgr, "is_configured", False):
        raise HTTPException(401, "Not authenticated")
""",
    """    u = get_current_user(request)
    if u:
        return u
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if os.getenv("AUTH_ENABLED", "true").lower() == "false":
        try:
            users = getattr(auth_mgr, "users", {}) if auth_mgr is not None else {}
            for username, data in users.items():
                if data.get("is_admin") is True:
                    return username
            return next(iter(users), "")
        except Exception:
            return ""
    if auth_mgr is not None and getattr(auth_mgr, "is_configured", False):
        raise HTTPException(401, "Not authenticated")
""",
)

replace_once(
    "routes/auth_routes.py",
    """    def _get_current_user(request: Request) -> Optional[str]:
        token = request.cookies.get(SESSION_COOKIE)
        return auth_manager.get_username_for_token(token)
""",
    """    def _get_current_user(request: Request) -> Optional[str]:
        if os.getenv("AUTH_ENABLED", "true").lower() == "false":
            try:
                for username, data in auth_manager.users.items():
                    if data.get("is_admin") is True:
                        return username
                return next(iter(auth_manager.users), None)
            except Exception:
                return None
        token = request.cookies.get(SESSION_COOKIE)
        return auth_manager.get_username_for_token(token)
""",
)

replace_once(
    "routes/auth_routes.py",
    """    @router.get("/status")
    async def auth_status(request: Request):
        token = request.cookies.get(SESSION_COOKIE)
        result = auth_manager.status(token)
        result["signup_enabled"] = auth_manager.signup_enabled
""",
    """    @router.get("/status")
    async def auth_status(request: Request):
        if os.getenv("AUTH_ENABLED", "true").lower() == "false":
            username = _get_current_user(request)
            result = {
                "configured": True,
                "authenticated": True,
                "username": username,
                "is_admin": bool(username and auth_manager.is_admin(username)),
                "signup_enabled": False,
                "auth_enabled": False,
            }
        else:
            token = request.cookies.get(SESSION_COOKIE)
            result = auth_manager.status(token)
            result["signup_enabled"] = auth_manager.signup_enabled
            result["auth_enabled"] = True
""",
)
