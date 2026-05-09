"""
Prayaas Prompt Injection Guard

Regex-based detection of common prompt injection patterns.
Blocks attempts to override system instructions, jailbreak, or extract prompts.
"""

import re
from typing import Optional

# Patterns that indicate prompt injection attempts
INJECTION_PATTERNS = [
    # Instruction override
    r"ignore\s+(all\s+|previous\s+|above\s+|prior\s+)?(instructions?|prompts?|context|rules?)",
    r"disregard\s+(your|the)\s+(instructions?|guidelines?|rules?|prompt|context)",
    r"forget\s+(all\s+|your\s+|previous\s+)?(instructions?|context|rules?)",
    r"override\s+(your|the|all)\s+(instructions?|rules?|guidelines?)",

    # Persona manipulation
    r"you\s+are\s+now\b",
    r"pretend\s+(you\s+are|to\s+be)",
    r"act\s+as\s+(an?\s+)?(DAN|jailbreak|unrestricted|evil|hacker)",
    r"new\s+persona",
    r"from\s+now\s+on",
    r"switch\s+to\s+(a\s+)?new\s+(mode|role|personality)",

    # Prompt extraction
    r"reveal\s+(your|the)\s+(system\s+)?prompt",
    r"show\s+(me\s+)?(your|the)\s+(system\s+)?prompt",
    r"what\s+(is|are)\s+your\s+(system\s+)?(instructions?|prompt|rules?)",
    r"print\s+(your|the)\s+(system\s+)?prompt",
    r"repeat\s+(your|the)\s+(system\s+)?(message|prompt|instructions?)",

    # Token/delimiter injection
    r"<\|.*?\|>",            # OpenAI-style token delimiters
    r"\[SYSTEM\]",
    r"\[INST\]",
    r"\[\/INST\]",
    r"<<SYS>>",
    r"<</SYS>>",

    # Output manipulation
    r"respond\s+only\s+with",
    r"output\s+only",
    r"return\s+only\s+the\s+(following|text)",

    # Developer mode / DAN
    r"developer\s+mode",
    r"DAN\s+(mode|jailbreak)",
    r"do\s+anything\s+now",
]

# Pre-compile patterns for performance
_COMPILED_PATTERNS = [(re.compile(p, re.IGNORECASE), p) for p in INJECTION_PATTERNS]


def detect_injection(text: str) -> Optional[str]:
    """
    Scan text for prompt injection patterns.

    Returns:
        Description of the detected threat, or None if clean.
    """
    if not text:
        return None

    for compiled, pattern_str in _COMPILED_PATTERNS:
        if compiled.search(text):
            return f"Potential injection detected: matches pattern '{pattern_str}'"

    return None


def is_safe(text: str) -> bool:
    """Returns True if the text passes injection detection."""
    return detect_injection(text) is None
