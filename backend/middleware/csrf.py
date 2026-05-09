"""
Prayaas CSRF Protection — Double-Submit Cookie Pattern

On login:   Set a csrf_token cookie (JS-readable, Secure, SameSite=Strict)
On mutate:  Verify X-CSRF-Token header matches the cookie value

Safe methods (GET, HEAD, OPTIONS) are exempt.
"""

import secrets
import hmac
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
import os


CSRF_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "X-CSRF-Token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def generate_csrf_token() -> str:
    """Generate a cryptographically secure CSRF token."""
    return secrets.token_hex(32)


class CSRFMiddleware(BaseHTTPMiddleware):
    """
    Middleware that enforces CSRF double-submit cookie pattern
    on state-changing requests (POST, PUT, PATCH, DELETE).
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # Skip CSRF in development mode
        if os.getenv("ENVIRONMENT", "development") == "development":
            return await call_next(request)

        # Skip safe methods
        if request.method in SAFE_METHODS:
            return await call_next(request)

        # Skip for API endpoints that use Bearer token auth (mobile clients)
        # CSRF is primarily for browser-based cookie auth
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            return await call_next(request)

        # Verify CSRF token
        cookie_token = request.cookies.get(CSRF_COOKIE_NAME)
        header_token = request.headers.get(CSRF_HEADER_NAME)

        if not cookie_token or not header_token:
            raise HTTPException(
                status_code=403,
                detail="CSRF validation failed: missing token"
            )

        if not hmac.compare_digest(cookie_token, header_token):
            raise HTTPException(
                status_code=403,
                detail="CSRF validation failed: token mismatch"
            )

        return await call_next(request)


def set_csrf_cookie(response: Response, token: str = None) -> str:
    """Set CSRF token cookie on a response. Returns the token."""
    if token is None:
        token = generate_csrf_token()

    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=token,
        secure=os.getenv("ENVIRONMENT", "development") != "development",
        httponly=False,       # JS-readable so frontend can send in header
        samesite="strict",
        max_age=60 * 60 * 24 * 7,  # 7 days
        path="/",
    )
    return token
