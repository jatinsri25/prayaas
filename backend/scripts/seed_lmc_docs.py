"""
Seed the KnowledgeChunk table with excerpts from public Lucknow Municipal
Corporation (LMC) bylaws and the U.P. Apartment Act.

These are paraphrased / summarized excerpts of public-domain civic rules,
written in plain English so the RAG pipeline can answer common questions
like "Who is responsible for water supply in my building?" with cited
sources.

Production extension:
  - Add a `scrape_lmc.py` companion that downloads the latest PDFs from
    https://lmc.up.nic.in/ and re-chunks them. Replace these seed entries
    with the live extracted text.
  - Swap embedding storage for pgvector and add an IVFFlat index.

Usage:
    cd backend
    source venv/bin/activate
    python -m scripts.seed_lmc_docs
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow running as `python scripts/seed_lmc_docs.py` from backend/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import SessionLocal, engine, Base  # noqa: E402
import models  # noqa: E402
from agent.embeddings import embed_text  # noqa: E402

Base.metadata.create_all(bind=engine)

LMC_URL = "https://lmc.up.nic.in/"
UP_APT_ACT_URL = "https://upgov.gov.in/upstateacts.aspx"

SEED_CHUNKS = [
    {
        "document_title": "Lucknow Municipal Corporation — Solid Waste Management Bylaws (2018)",
        "source_url": LMC_URL,
        "section_title": "Door-to-door collection and segregation",
        "page_number": 4,
        "chunk_text": (
            "Every residential apartment society in Lucknow is required to segregate "
            "wet and dry waste at source before handing it over to the municipal "
            "collection vehicle. The Lucknow Municipal Corporation (LMC) Sanitation "
            "Inspector for the relevant ward is responsible for ensuring daily "
            "door-to-door collection. Failure to segregate may attract a penalty of "
            "Rs. 100 per occurrence under the Solid Waste Management Rules, 2016."
        ),
    },
    {
        "document_title": "Lucknow Municipal Corporation — Solid Waste Management Bylaws (2018)",
        "source_url": LMC_URL,
        "section_title": "Bulk waste generators",
        "page_number": 7,
        "chunk_text": (
            "Any housing society generating more than 100 kg of waste per day is "
            "classified as a bulk waste generator and must arrange in-situ "
            "composting of organic waste. The Resident Welfare Association (RWA) "
            "is jointly responsible with the LMC ward office for compliance. "
            "Composting infrastructure must be installed within 6 months of the "
            "society receiving a bulk-generator notice from the LMC."
        ),
    },
    {
        "document_title": "U.P. Jal Nigam — Water Supply Service Rules",
        "source_url": "https://upjalnigam.gov.in/",
        "section_title": "Responsibility for internal distribution",
        "page_number": 12,
        "chunk_text": (
            "Uttar Pradesh Jal Nigam (UPJN) is responsible for water supply up to "
            "the society's main bulk meter. Internal distribution within the "
            "apartment building, including overhead tanks, pumps, and pipelines, "
            "is the responsibility of the society's Managing Committee and may be "
            "outsourced to a licensed plumbing contractor. For complaints about "
            "low pressure or no water at the bulk meter, residents should contact "
            "the UPJN Zonal Engineer for Lucknow at toll-free 1916."
        ),
    },
    {
        "document_title": "Uttar Pradesh Apartment (Promotion of Construction, Ownership and Maintenance) Act, 2010",
        "source_url": UP_APT_ACT_URL,
        "section_title": "Common areas — maintenance and dispute resolution",
        "page_number": 18,
        "chunk_text": (
            "Under Section 14 of the U.P. Apartment Act, 2010, common areas including "
            "lifts, staircases, lobbies, parking, and external walls are jointly "
            "owned by all apartment owners in proportion to their carpet area. The "
            "Apartment Owners' Association (AOA) is responsible for routine "
            "maintenance and may levy a maintenance charge approved by a majority "
            "of owners. Disputes about maintenance charges or scope of work are "
            "adjudicated by the Competent Authority appointed under Section 22 of "
            "the same Act."
        ),
    },
    {
        "document_title": "Uttar Pradesh Apartment Act, 2010 — Lift safety provisions",
        "source_url": UP_APT_ACT_URL,
        "section_title": "Lift inspection and certification",
        "page_number": 24,
        "chunk_text": (
            "Every passenger lift in a Lucknow residential building must be "
            "inspected annually by a licensed lift inspector empanelled with the "
            "U.P. Electrical Inspectorate. The inspection certificate must be "
            "displayed inside the lift cabin. The Society Secretary or building "
            "manager is the designated person responsible for arranging the "
            "annual inspection and for shutting down a lift that has failed "
            "inspection until repairs are certified."
        ),
    },
    {
        "document_title": "Lucknow Police — Society Security Guidelines (2021 Advisory)",
        "source_url": "https://lucknowpolice.up.gov.in/",
        "section_title": "Security guard verification",
        "page_number": 3,
        "chunk_text": (
            "Lucknow Police advises every Resident Welfare Association to verify "
            "the police antecedents of all security guards through the local "
            "police station before deployment. The RWA Chairperson is "
            "responsible for maintaining a register of guards including Aadhaar "
            "number, address, and verification reference. CCTV footage covering "
            "all society entrances must be retained for a minimum of 30 days."
        ),
    },
    {
        "document_title": "LMC — Building Bylaws Sanitation Section",
        "source_url": LMC_URL,
        "section_title": "Sewer line responsibility split",
        "page_number": 9,
        "chunk_text": (
            "The boundary of LMC's responsibility for sewer maintenance is the "
            "first inspection chamber inside the society compound. Beyond this "
            "chamber, all internal sewer lines, manholes, and septic tanks are "
            "the responsibility of the society. Sewer overflows inside the "
            "compound should first be reported to the society plumber; if the "
            "main external chamber is overflowing, file a complaint with the "
            "LMC Sewer Cell on the Jansunwai Samadhan portal "
            "(https://jansunwai.up.nic.in)."
        ),
    },
]


def main() -> int:
    db = SessionLocal()
    try:
        existing = db.query(models.KnowledgeChunk).count()
        if existing:
            print(f"[seed_lmc_docs] Knowledge base already has {existing} chunks. "
                  "Delete them manually if you want to reseed.")
            return 0

        added = 0
        for chunk in SEED_CHUNKS:
            embedding = embed_text(chunk["chunk_text"])
            row = models.KnowledgeChunk(
                document_title=chunk["document_title"],
                source_url=chunk["source_url"],
                section_title=chunk["section_title"],
                page_number=chunk["page_number"],
                chunk_text=chunk["chunk_text"],
                embedding_json=json.dumps(embedding),
            )
            db.add(row)
            added += 1

        db.commit()
        print(f"[seed_lmc_docs] Seeded {added} knowledge chunks.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
