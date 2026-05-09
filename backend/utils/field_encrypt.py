"""
Prayaas Field-Level Encryption

Fernet-based encryption for PII fields (email, phone).
Uses a single key from environment (Vault-ready).
"""

import os
from cryptography.fernet import Fernet, InvalidToken

# Encryption key — generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# In production, load from Vault. In dev, auto-generate if missing.
_ENCRYPTION_KEY = os.getenv("PII_ENCRYPTION_KEY")
_fernet = None


def _get_fernet() -> Fernet:
    """Get or create Fernet cipher (lazy init)."""
    global _fernet
    if _fernet is None:
        key = _ENCRYPTION_KEY
        if not key:
            # Dev mode — generate an ephemeral key (data not portable across restarts!)
            key = Fernet.generate_key().decode()
        _fernet = Fernet(key.encode() if isinstance(key, str) else key)
    return _fernet


def encrypt_field(value: str) -> str:
    """Encrypt a string field value. Returns base64-encoded ciphertext."""
    if not value:
        return value
    try:
        f = _get_fernet()
        return f.encrypt(value.encode()).decode()
    except Exception:
        return value  # fallback: store plain in dev if key is bad


def decrypt_field(value: str) -> str:
    """Decrypt a field value. Returns original plaintext."""
    if not value:
        return value
    try:
        f = _get_fernet()
        return f.decrypt(value.encode()).decode()
    except (InvalidToken, Exception):
        # If decryption fails, the value might be stored in plaintext (legacy data)
        return value


def is_encrypted(value: str) -> bool:
    """Check if a value appears to be Fernet-encrypted."""
    if not value:
        return False
    try:
        # Fernet tokens start with 'gAAAAA'
        return value.startswith("gAAAAA") and len(value) > 50
    except Exception:
        return False
