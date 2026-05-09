"""
Prayaas Password Hashing — Production

Uses Argon2id (GPU-hostile, memory-hard) with transparent bcrypt fallback
for migrating existing users.
"""

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError
import bcrypt

# Argon2id parameters — GPU-hostile
ph = PasswordHasher(
    time_cost=3,           # iterations
    memory_cost=65536,     # 64 MB RAM per hash
    parallelism=4,
    hash_len=32,
    salt_len=16,
)


def hash_password(plain: str) -> str:
    """Hash a password using Argon2id."""
    return ph.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify a password against a hash.
    Supports both Argon2id and legacy bcrypt hashes for migration.
    """
    if hashed.startswith("$argon2"):
        # Argon2id hash
        try:
            return ph.verify(hashed, plain)
        except (VerifyMismatchError, VerificationError):
            return False
    elif hashed.startswith("$2b$") or hashed.startswith("$2a$"):
        # Legacy bcrypt hash — verify with bcrypt
        try:
            return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
        except Exception:
            return False
    else:
        return False


def needs_rehash(hashed: str) -> bool:
    """
    Check if a password hash needs to be upgraded to Argon2id.
    Returns True for bcrypt hashes or Argon2id hashes with outdated params.
    """
    if not hashed.startswith("$argon2"):
        return True  # bcrypt or unknown → needs rehash
    try:
        return ph.check_needs_rehash(hashed)
    except Exception:
        return True
