"""
Prayaas File Security

Audio file validation: size, MIME type (magic bytes), format checks.
Blocks malicious files before processing.
"""

import os
from typing import Set
from fastapi import HTTPException

ALLOWED_MIMES: Set[str] = {
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "audio/mp4",
    "audio/x-wav",
    "audio/x-m4a",
    "audio/aac",
    "video/webm",    # browser audio recordings sometimes report as video/webm
}

MAX_SIZE_BYTES = 25 * 1024 * 1024   # 25 MB

# Magic byte signatures for audio formats
MAGIC_SIGNATURES = {
    b"\xff\xfb": "audio/mpeg",          # MP3
    b"\xff\xf3": "audio/mpeg",          # MP3
    b"\xff\xf2": "audio/mpeg",          # MP3
    b"ID3": "audio/mpeg",               # MP3 with ID3 tag
    b"RIFF": "audio/wav",               # WAV
    b"OggS": "audio/ogg",               # OGG
    b"\x1aE\xdf\xa3": "video/webm",     # WebM/MKV
    b"ftyp": "audio/mp4",               # M4A/MP4 (after 4-byte size)
}


def validate_audio_file(data: bytes, filename: str = "audio") -> str:
    """
    Validate an audio file by checking size and magic bytes.

    Args:
        data: Raw file bytes
        filename: Original filename (for extension check)

    Returns:
        Detected MIME type string

    Raises:
        HTTPException on validation failure
    """
    # 1. Size check
    if len(data) > MAX_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file too large. Maximum size: {MAX_SIZE_BYTES // (1024*1024)} MB"
        )

    if len(data) < 4:
        raise HTTPException(status_code=400, detail="File too small to be a valid audio file")

    # 2. Magic byte check
    detected_mime = _detect_mime_from_magic(data)

    if detected_mime and detected_mime not in ALLOWED_MIMES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio format detected: {detected_mime}"
        )

    # 3. Extension check (secondary — magic bytes are authoritative)
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        allowed_extensions = {"mp3", "wav", "ogg", "webm", "m4a", "mp4", "aac", "oga"}
        if ext not in allowed_extensions:
            raise HTTPException(
                status_code=415,
                detail=f"Unsupported audio file extension: .{ext}"
            )

    return detected_mime or "application/octet-stream"


def _detect_mime_from_magic(data: bytes) -> str:
    """Detect MIME type from magic bytes."""
    # Try python-magic if available
    try:
        import magic
        mime = magic.from_buffer(data, mime=True)
        return mime
    except ImportError:
        pass

    # Fallback: manual magic byte detection
    header = data[:12]

    for sig, mime in MAGIC_SIGNATURES.items():
        if sig == b"ftyp":
            # MP4/M4A: "ftyp" appears at offset 4
            if header[4:8] == sig:
                return mime
        elif header.startswith(sig):
            return mime

    return None
