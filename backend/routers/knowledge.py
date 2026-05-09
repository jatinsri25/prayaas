"""
Prayaas Knowledge Router — RAG over Lucknow Municipal Corporation bylaws

Endpoints:
  POST /api/knowledge/ask          → answer a citizen question with citations
  GET  /api/knowledge/documents    → list all sources currently indexed

Storage: KnowledgeChunk rows, each with a 768-d embedding (text-embedding-004).
At query time we retrieve top-k chunks by cosine similarity and feed them
to a confidence-gated LLM call. The output is a grounded answer with
source citations — what makes Prayaas feel like a real product, not a
student demo.

Production upgrade: swap the in-Python ranking for pgvector's `<=>`
operator for sub-100ms retrieval over millions of chunks.
"""

from __future__ import annotations

import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
import models
import schemas
from agent.embeddings import embed_text, cosine_similarity
from agent.confidence_gate import gated_call

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])

# Cosine threshold below which a chunk is too irrelevant to cite.
_MIN_CITATION_SIMILARITY = 0.45


@router.get("/documents")
def list_documents(db: Session = Depends(get_db)):
    """Distinct documents currently indexed in the knowledge base."""
    rows = (
        db.query(
            models.KnowledgeChunk.document_title,
            models.KnowledgeChunk.source_url,
        )
        .distinct()
        .all()
    )
    return [
        {"title": title, "source_url": url}
        for title, url in rows
    ]


@router.post("/ask", response_model=schemas.KnowledgeAnswer)
def ask_knowledge_base(
    payload: schemas.KnowledgeAskRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    RAG question-answering with cited sources.

    1. Embed the question.
    2. Retrieve top-k chunks by cosine similarity.
    3. Feed retrieved chunks + question into a confidence-gated LLM call.
    4. Return the answer + the citations the LLM was grounded on.
    """
    chunks = db.query(models.KnowledgeChunk).all()
    if not chunks:
        raise HTTPException(
            status_code=503,
            detail="Knowledge base is empty. Run `python scripts/seed_lmc_docs.py` first.",
        )

    query_embedding = embed_text(payload.question)
    scored: List[tuple[float, models.KnowledgeChunk]] = []
    for chunk in chunks:
        try:
            chunk_emb = json.loads(chunk.embedding_json)
        except (TypeError, json.JSONDecodeError):
            continue
        sim = cosine_similarity(query_embedding, chunk_emb)
        scored.append((sim, chunk))

    scored.sort(key=lambda x: x[0], reverse=True)
    top = [(s, c) for s, c in scored[: payload.top_k] if s >= _MIN_CITATION_SIMILARITY]

    if not top:
        return schemas.KnowledgeAnswer(
            question=payload.question,
            answer=(
                "I could not find relevant information about that in the indexed "
                "Lucknow Municipal Corporation documents. Try rephrasing or check "
                "the LMC website directly."
            ),
            citations=[],
            confidence=0.0,
            model_used="none",
            auto_resolved=False,
        )

    # Build the RAG prompt
    context_block = "\n\n".join(
        f"[Source {i + 1}: {c.document_title}"
        + (f", §{c.section_title}" if c.section_title else "")
        + (f", page {c.page_number}" if c.page_number else "")
        + f"]\n{c.chunk_text}"
        for i, (_, c) in enumerate(top)
    )

    prompt = f"""You are a civic information assistant for Lucknow residents.
Answer the user's question using ONLY the cited sources below. If the
sources don't fully answer the question, say so honestly — do NOT make
up facts. Always cite source numbers in square brackets like [1], [2].

USER QUESTION: {payload.question}

CITED SOURCES:
{context_block}

Return a JSON object:
{{
  "answer": "Your grounded answer (3-6 sentences). Cite sources inline like [1].",
  "cited_source_indices": [1, 2]
}}

Return ONLY the JSON object, no markdown."""

    result = gated_call(
        prompt=prompt,
        task_type="rag_answer",
        required_fields=["answer"],
        temperature=0.1,
        user_id=current_user.id,
    )

    parsed = result.parsed if isinstance(result.parsed, dict) else {}
    answer_text = parsed.get("answer") or result.text or "(no answer generated)"

    citations = [
        schemas.KnowledgeCitation(
            document_title=c.document_title,
            section_title=c.section_title,
            page_number=c.page_number,
            source_url=c.source_url,
            chunk_text=c.chunk_text,
            similarity=round(float(sim), 4),
        )
        for sim, c in top
    ]

    return schemas.KnowledgeAnswer(
        question=payload.question,
        answer=answer_text,
        citations=citations,
        confidence=result.confidence,
        model_used=result.model_used,
        auto_resolved=result.auto_resolved,
    )
