"""
Prayaas PII Redaction

Lightweight regex-based PII detection and redaction.
Covers Indian PII: Aadhaar, PAN, phone numbers, emails.
No heavy dependencies (no spaCy/Presidio).
"""

import re
from typing import List, Tuple
from dataclasses import dataclass


@dataclass
class RedactedEntity:
    entity_type: str
    start: int
    end: int
    original_length: int


# ── PII Patterns (India-specific + universal) ────────────────────────────────

PII_PATTERNS = [
    # Aadhaar number: 12 digits, often formatted as XXXX XXXX XXXX
    ("AADHAAR", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),

    # PAN card: ABCDE1234F
    ("PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),

    # Indian phone: +91, 0-prefixed, or 10-digit
    ("PHONE", re.compile(r"(?:\+91[\s-]?|0)?[6-9]\d{9}\b")),

    # Email addresses
    ("EMAIL", re.compile(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b")),

    # Credit/debit card (basic: 16 digits with optional separators)
    ("CARD", re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b")),

    # Indian PIN code
    ("PINCODE", re.compile(r"\b[1-9]\d{5}\b")),

    # IFSC code
    ("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),

    # Bank account numbers (8-18 digits)
    ("BANK_ACCOUNT", re.compile(r"\b\d{8,18}\b")),
]

# Higher priority patterns checked first (order matters for overlapping matches)
_PRIORITY_ORDER = ["AADHAAR", "PAN", "CARD", "IFSC", "EMAIL", "PHONE", "BANK_ACCOUNT", "PINCODE"]


def redact_pii(text: str) -> Tuple[str, List[dict]]:
    """
    Redact PII from text, replacing with [REDACTED_TYPE] placeholders.

    Args:
        text: Input text that may contain PII.

    Returns:
        Tuple of (redacted_text, list_of_entities)
        Each entity has: type, start, end, original_length
    """
    if not text:
        return text, []

    entities: List[dict] = []
    redacted = text

    # Sort patterns by priority
    sorted_patterns = sorted(
        PII_PATTERNS,
        key=lambda x: _PRIORITY_ORDER.index(x[0]) if x[0] in _PRIORITY_ORDER else len(_PRIORITY_ORDER)
    )

    # Track already-redacted regions to avoid double-redaction
    redacted_regions = set()

    for entity_type, pattern in sorted_patterns:
        # Skip PINCODE and BANK_ACCOUNT for now — too many false positives
        # They match general numbers. Only enable when context suggests financial data.
        if entity_type in ("PINCODE", "BANK_ACCOUNT"):
            continue

        matches = list(pattern.finditer(redacted))
        offset = 0

        for match in matches:
            start = match.start() + offset
            end = match.end() + offset
            original = match.group()

            # Skip if this region was already redacted
            if any(start < r_end and end > r_start for r_start, r_end in redacted_regions):
                continue

            replacement = f"[REDACTED_{entity_type}]"
            redacted = redacted[:start] + replacement + redacted[end:]

            entities.append({
                "type": entity_type,
                "start": match.start(),
                "end": match.end(),
                "original_length": len(original),
            })

            redacted_regions.add((start, start + len(replacement)))
            offset += len(replacement) - len(original)

    return redacted, entities


def has_pii(text: str) -> bool:
    """Quick check if text contains any detectable PII."""
    _, entities = redact_pii(text)
    return len(entities) > 0
