"""Weekly scheduler entrypoint. Idempotent; stores a draft, never sends messages.

Run from backend: python -m scripts.weekly_digest [--without-ai]
The host scheduler should invoke this on Mondays after 00:00 Asia/Kolkata.
"""
import argparse
from dotenv import load_dotenv

load_dotenv()

from database import Base, engine
import models
from utils.schema_migrate import ensure_dev_columns
from agent.digest import generate_digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--without-ai", action="store_true", help="Create a counts-only draft without calling any provider")
    args = parser.parse_args()
    Base.metadata.create_all(engine)
    ensure_dev_columns(engine)
    result = generate_digest(use_ai=not args.without_ai)
    print(f"Committee draft: week={result['week_start']} mode={result['generation_mode']}; nothing sent")


if __name__ == "__main__":
    main()
