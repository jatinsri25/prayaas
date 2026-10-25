"""Offline SDK-boundary fixtures. Valid shape, deliberately NOT model predictions."""
import json
import math
import sys
import time
from types import SimpleNamespace

FIXTURE_VERSION = "valid-report-v1"
network_attempts = 0


def disable_network():
    def guard(event, args):
        global network_attempts
        if event == "socket.connect":
            network_attempts += 1
            raise RuntimeError("Networking is disabled in provider-stub mode")
    sys.addaudithook(guard)


def make_client(latency_ms, embedding_dim):
    if not math.isfinite(latency_ms) or not 0 <= latency_ms <= 10000:
        raise ValueError("Stub latency must be finite and between 0 and 10000 ms")
    solutions = [{"action": "Ask a qualified maintenance professional to inspect the reported issue. Review the findings before arranging work.",
                  "responsible_party": "Maintenance committee", "timeline": "After committee review", "priority": priority}
                 for priority in (1, 2, 3)]
    description = "The resident has reported a maintenance issue in a shared area. A qualified professional should inspect it. The committee should review the findings before arranging work. This is a synthetic fixture for pipeline testing."

    def generate_content(*, model, contents, config=None, **kwargs):
        # A synchronous sleep at the exact same SDK boundary exposes whether
        # each checkout runs blocking provider work on or off the event loop.
        time.sleep(latency_ms / 1000)
        prompt = str(contents)
        if "Return a JSON array" in prompt:
            payload = solutions
        else:
            payload = {"title": "Inspect the reported maintenance issue in the shared area",
                       "category": "Maintenance", "severity": "High", "location": "Shared area",
                       "affected_residents": "Residents using the shared area"}
            if "description_en" in prompt:
                payload.update(description_en=description,
                    description_hi="निवासी ने साझा क्षेत्र में रखरखाव की समस्या बताई है। योग्य विशेषज्ञ से जांच कराएं। काम तय करने से पहले समिति जांच के निष्कर्ष की समीक्षा करे। यह केवल पाइपलाइन परीक्षण का कृत्रिम उदाहरण है।",
                    solutions=solutions)
            else:
                payload["formatted_description"] = description
        return SimpleNamespace(text=json.dumps(payload, ensure_ascii=False), usage_metadata=None)

    def embed_content(**kwargs):
        # Embeddings are a separate zero-delay fixture, not semantic retrieval.
        return SimpleNamespace(embeddings=[SimpleNamespace(values=[1.0] + [0.0] * (embedding_dim - 1))])

    return SimpleNamespace(models=SimpleNamespace(generate_content=generate_content, embed_content=embed_content))
