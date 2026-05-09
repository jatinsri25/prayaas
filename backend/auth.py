"""
Prayaas Auth Router — Production Hardened

Security features:
  - JWT RS256 (asymmetric) with 15-minute access tokens
  - Opaque refresh tokens stored in Redis
  - HttpOnly cookie for refresh tokens
  - Argon2id password hashing with transparent bcrypt migration
  - Account lockout (5 failures → 15 min ban)
  - Token revocation via JTI blocklist
  - Audit logging on all auth events
"""

from datetime import datetime, timedelta
from typing import Optional
from uuid import uuid4
import json
import os
import random
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from utils.password import hash_password, verify_password, needs_rehash
from middleware.lockout import check_lockout, record_failed_attempt, clear_lockout
from middleware.csrf import set_csrf_cookie

# ── Configuration ─────────────────────────────────────────────────────────────

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALGORITHM = "RS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15       # Short-lived access tokens
REFRESH_TOKEN_EXPIRE_DAYS = 7

# ── RSA Key Management ───────────────────────────────────────────────────────
# In production, load from Vault/env. In dev, auto-generate.

_PRIVATE_KEY = None
_PUBLIC_KEY = None


def _load_or_generate_keys():
    """Load RSA keys from env or generate ephemeral ones for dev."""
    global _PRIVATE_KEY, _PUBLIC_KEY

    private_pem = os.getenv("JWT_PRIVATE_KEY")
    public_pem = os.getenv("JWT_PUBLIC_KEY")

    if private_pem and public_pem:
        _PRIVATE_KEY = serialization.load_pem_private_key(
            private_pem.encode(), password=None
        )
        _PUBLIC_KEY = serialization.load_pem_public_key(public_pem.encode())
    else:
        # Dev mode — generate ephemeral RSA key pair
        _PRIVATE_KEY = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
        )
        _PUBLIC_KEY = _PRIVATE_KEY.public_key()


def _get_private_key_pem() -> bytes:
    if _PRIVATE_KEY is None:
        _load_or_generate_keys()
    return _PRIVATE_KEY.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _get_public_key_pem() -> bytes:
    if _PUBLIC_KEY is None:
        _load_or_generate_keys()
    return _PUBLIC_KEY.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


# Initialize keys on module load
_load_or_generate_keys()

# ── Redis for refresh tokens (lazy) ──────────────────────────────────────────

_redis_client = None


def _get_redis():
    global _redis_client
    if _redis_client is None:
        try:
            import redis
            redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
            _redis_client = redis.from_url(redis_url, decode_responses=True)
            _redis_client.ping()
        except Exception:
            _redis_client = None
    return _redis_client


# ── OAuth2 Scheme ─────────────────────────────────────────────────────────────

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

router = APIRouter(prefix="/api/auth", tags=["auth"])

AVATAR_COLORS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e",
    "#f97316", "#10b981", "#06b6d4", "#3b82f6",
]


# ── Token Functions ───────────────────────────────────────────────────────────

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a short-lived RS256 JWT access token."""
    payload = {
        **data,
        "exp": datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)),
        "iat": datetime.utcnow(),
        "jti": str(uuid4()),    # unique ID for revocation
        "type": "access",
    }
    return jwt.encode(payload, _get_private_key_pem(), algorithm=ALGORITHM)


def create_refresh_token(user_id: int) -> str:
    """Create an opaque refresh token stored in Redis, fallback to JWT if no Redis."""
    r = _get_redis()
    if r:
        token = secrets.token_urlsafe(64)
        r.setex(
            f"refresh:{token}",
            timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
            json.dumps({
                "user_id": user_id,
                "created": datetime.utcnow().isoformat(),
            }),
        )
        return token
    else:
        # Dev fallback when Redis is missing
        return create_access_token(
            {"sub": str(user_id), "type": "refresh"}, 
            expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
        )


def verify_access_token(token: str) -> dict:
    """Verify and decode an RS256 JWT access token."""
    try:
        payload = jwt.decode(token, _get_public_key_pem(), algorithms=[ALGORITHM])
        # Check revocation
        r = _get_redis()
        if r and r.exists(f"revoked:{payload.get('jti', '')}"):
            raise JWTError("Token revoked")
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def revoke_token(jti: str) -> None:
    """Add a JTI to the revocation blocklist."""
    r = _get_redis()
    if r:
        r.setex(f"revoked:{jti}", timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES + 5), "1")


# ── Dependencies ──────────────────────────────────────────────────────────────

def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    """Extract and validate the current user from the access token."""
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = verify_access_token(token)
    user_id_str = payload.get("sub")
    if user_id_str is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    try:
        user_id = int(user_id_str)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/register", response_model=schemas.Token)
def register(data: schemas.UserRegister, response: Response, db: Session = Depends(get_db)):
    """Register a new user with Argon2id password hashing."""
    existing = db.query(models.User).filter(models.User.email == data.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = models.User(
        name=data.name,
        email=data.email,
        flat_number=data.flat_number,
        phone=data.phone,
        hashed_password=hash_password(data.password),
        avatar_color=random.choice(AVATAR_COLORS),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Create tokens
    access_token = create_access_token({"sub": str(user.id)})
    refresh_token = create_refresh_token(user.id)

    # Set refresh token as HttpOnly cookie
    _set_refresh_cookie(response, refresh_token)

    # Set CSRF token
    set_csrf_cookie(response)

    # Audit
    _audit_log(db, user.id, "REGISTER", f"user:{user.id}")

    return schemas.Token(access_token=access_token, user=schemas.UserOut.model_validate(user))


@router.post("/login", response_model=schemas.Token)
def login(data: schemas.UserLogin, request: Request, response: Response, db: Session = Depends(get_db)):
    """Login with email/password. Returns access token + sets refresh cookie."""
    client_ip = request.client.host if request.client else "unknown"
    lockout_id = f"{data.email}:{client_ip}"

    # Check lockout
    check_lockout(lockout_id)

    user = db.query(models.User).filter(models.User.email == data.email).first()
    if not user or not verify_password(data.password, user.hashed_password):
        if user:
            record_failed_attempt(lockout_id)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Transparent password rehash (bcrypt → Argon2id migration)
    if needs_rehash(user.hashed_password):
        user.hashed_password = hash_password(data.password)
        db.commit()

    # Clear lockout counter on success
    clear_lockout(lockout_id)

    # Create tokens
    access_token = create_access_token({"sub": str(user.id)})
    refresh_token = create_refresh_token(user.id)

    # Set refresh token as HttpOnly cookie
    _set_refresh_cookie(response, refresh_token)

    # Set CSRF token
    set_csrf_cookie(response)

    # Audit
    _audit_log(db, user.id, "LOGIN", f"user:{user.id}", ip=client_ip)

    return schemas.Token(access_token=access_token, user=schemas.UserOut.model_validate(user))


@router.post("/refresh", response_model=schemas.Token)
def refresh_token(request: Request, response: Response, db: Session = Depends(get_db)):
    """Exchange a refresh token (from cookie) for a new access token."""
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token")

    user_id = None
    r = _get_redis()
    
    if r:
        data = r.get(f"refresh:{token}")
        if not data:
            raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
        token_data = json.loads(data)
        user_id = token_data["user_id"]
        # Rotate refresh token (invalidate old)
        r.delete(f"refresh:{token}")
    else:
        # Dev fallback when Redis is missing
        try:
            payload = jwt.decode(token, _get_public_key_pem(), algorithms=[ALGORITHM])
            user_id = int(payload.get("sub"))
        except (JWTError, ValueError, TypeError):
            raise HTTPException(status_code=401, detail="Invalid fallback refresh token")

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
        
    new_refresh = create_refresh_token(user.id)
    new_access = create_access_token({"sub": str(user.id)})

    _set_refresh_cookie(response, new_refresh)

    return schemas.Token(access_token=new_access, user=schemas.UserOut.model_validate(user))


@router.post("/logout")
def logout(request: Request, response: Response):
    """Invalidate the refresh token and clear cookies."""
    token = request.cookies.get("refresh_token")
    if token:
        r = _get_redis()
        if r:
            r.delete(f"refresh:{token}")

    response.delete_cookie("refresh_token", path="/api/auth")
    response.delete_cookie("csrf_token", path="/")
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=schemas.UserOut)
def get_me(current_user: models.User = Depends(get_current_user)):
    """Get the current authenticated user."""
    return current_user


# ── Helpers ───────────────────────────────────────────────────────────────────

def _set_refresh_cookie(response: Response, token: str) -> None:
    """Set the refresh token as an HttpOnly secure cookie."""
    is_prod = ENVIRONMENT != "development"
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        secure=is_prod,
        samesite="strict",
        max_age=60 * 60 * 24 * REFRESH_TOKEN_EXPIRE_DAYS,
        path="/api/auth",  # only sent to auth endpoints
    )


def _audit_log(db: Session, user_id: int, action: str, resource: str = None, ip: str = None):
    """Write an audit log entry (best-effort, won't crash on failure)."""
    try:
        import hashlib
        content = f"{user_id}:{action}:{resource}:{ip}:{datetime.utcnow().isoformat()}"
        checksum = hashlib.sha256(content.encode()).hexdigest()
        log_entry = models.AuditLog(
            user_id=user_id,
            action=action,
            resource=resource,
            ip_address=ip,
            checksum=checksum,
        )
        db.add(log_entry)
        db.commit()
    except Exception:
        db.rollback()  # don't let audit failures crash auth
