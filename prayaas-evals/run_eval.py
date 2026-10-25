"""Quality eval for the Prayaas AI pipeline.

    python run_eval.py --dataset data/sample_labelled.jsonl --out results/eval.json --report results/eval.md

Dataset rows (JSONL, one per line):
    {"id": "r1", "text": "...", "category": "water", "severity": "high", "duplicate_of": null}
Rows are treated as arriving in file order; a duplicate_of must point at an earlier id.
"""
import argparse
import asyncio
import json
from collections import Counter
from pathlib import Path

import adapter
from common import bounded_map, load_jsonl, norm_label, norm_severity


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def is_err(pred):
    return not isinstance(pred, dict) or "_error" in pred


def eval_category(rows, preds):
    labels = sorted({norm_label(r["category"]) for r in rows})
    tp, fp, fn, confusion = Counter(), Counter(), Counter(), Counter()
    correct = 0
    for r, p in zip(rows, preds):
        truth = norm_label(r["category"])
        pred = "<error>" if is_err(p) else norm_label(p.get("category"))
        confusion[(truth, pred)] += 1
        if truth == pred:
            tp[truth] += 1
            correct += 1
        else:
            fn[truth] += 1
            fp[pred] += 1
    per = {lab: prf(tp[lab], fp[lab], fn[lab]) for lab in labels}
    return {
        "n": len(rows),
        "accuracy": correct / len(rows),
        "macro_f1": sum(v[2] for v in per.values()) / len(per),
        "per_class": {k: {"precision": v[0], "recall": v[1], "f1": v[2]} for k, v in per.items()},
        "top_confusions": [
            {"truth": t, "pred": p, "count": c}
            for (t, p), c in confusion.most_common() if t != p
        ][:5],
    }


def eval_severity(rows, preds):
    n = exact = within1 = 0
    errs = []
    for r, p in zip(rows, preds):
        truth = norm_severity(r.get("severity"))
        if truth is None:
            continue
        n += 1
        pred = None if is_err(p) else norm_severity(p.get("severity"))
        if pred is None:
            errs.append(3)
            continue
        d = abs(truth - pred)
        errs.append(d)
        exact += d == 0
        within1 += d <= 1
    return {
        "n": n,
        "exact": exact / n if n else 0,
        "within_one": within1 / n if n else 0,
        "mean_abs_error": sum(errs) / len(errs) if errs else 0,
    }


def eval_selective(rows, preds):
    """Accuracy when the pipeline only answers above a confidence threshold."""
    if not preds or any(is_err(p) or p.get("confidence") is None for p in preds):
        return None
    out = []
    for t in (0.5, 0.6, 0.7, 0.8, 0.9):
        kept = [(r, p) for r, p in zip(rows, preds) if p["confidence"] >= t]
        if not kept:
            out.append({"threshold": t, "coverage": 0.0, "accuracy": None})
            continue
        acc = sum(norm_label(r["category"]) == norm_label(p["category"]) for r, p in kept) / len(kept)
        out.append({"threshold": t, "coverage": len(kept) / len(rows), "accuracy": acc})
    return out


def eval_dedup(rows, preds):
    by_id = {r["id"]: r for r in rows}

    def root(i):
        seen = set()
        while by_id.get(i, {}).get("duplicate_of") and i not in seen:
            seen.add(i)
            i = by_id[i]["duplicate_of"]
        return i

    tp = fp = fn = tn = errors = 0
    for r, pred in zip(rows, preds):
        if isinstance(pred, dict):  # error marker
            errors += 1
            pred = None
        truth = r.get("duplicate_of")
        if truth and pred:
            if root(pred) == root(truth):
                tp += 1
            else:
                fp += 1
                fn += 1
        elif pred:
            fp += 1
        elif truth:
            fn += 1
        else:
            tn += 1
    p, rc, f = prf(tp, fp, fn)
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "errors": errors,
            "precision": p, "recall": rc, "f1": f,
            "true_duplicates": sum(1 for r in rows if r.get("duplicate_of"))}


def pct(x):
    return "n/a" if x is None else f"{x * 100:.0f}%"


def render_report(res, n):
    c, s, d = res["category"], res["severity"], res.get("dedup")
    L = ["# Prayaas pipeline eval", "", f"Labelled reports: {n}  |  adapter: {adapter.MODE}", ""]
    if adapter.MODE == "mock":
        L += ["> MOCK MODE: synthetic predictions, do not quote these numbers.", ""]
    if n < 50:
        L += ["> Small format/example dataset: not sufficient for quality claims.", ""]
    L += [f"Pipeline errors: {res.get('pipeline_errors', 0)} / {n}", ""]
    L += ["## Category", f"- accuracy {pct(c['accuracy'])}, macro-F1 {c['macro_f1']:.2f}", "",
          "| class | precision | recall | F1 |", "|---|---|---|---|"]
    for k, v in c["per_class"].items():
        L.append(f"| {k} | {pct(v['precision'])} | {pct(v['recall'])} | {v['f1']:.2f} |")
    if c["top_confusions"]:
        L += ["", "Most common mistakes:"]
        L += [f"- {x['truth']} predicted as {x['pred']}: {x['count']}" for x in c["top_confusions"]]
    L += ["", "## Severity",
          f"- exact {pct(s['exact'])}, within one level {pct(s['within_one'])}, mean abs error {s['mean_abs_error']:.2f} levels"]
    if res.get("selective"):
        L += ["", "## Confidence gate (category accuracy vs coverage)", "| threshold | coverage | accuracy |", "|---|---|---|"]
        L += [f"| {x['threshold']} | {pct(x['coverage'])} | {pct(x['accuracy'])} |" for x in res["selective"]]
    if d:
        L += ["", "## Duplicate detection",
              f"- precision {pct(d['precision'])}, recall {pct(d['recall'])}, F1 {d['f1']:.2f} "
              f"({d['true_duplicates']} true duplicates; TP {d['tp']}, FP {d['fp']}, FN {d['fn']})"]
        L += [f"- duplicate-check errors: {d['errors']}"]
    return "\n".join(L)


async def main_async(args):
    if adapter.MODE == "stub":
        raise ValueError("Provider-stub mode cannot evaluate quality; its outputs are shape-only fixtures")
    rows = load_jsonl(args.dataset)
    if not rows:
        raise ValueError("Dataset is empty")
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate IDs in dataset")
    earlier = set()
    for row in rows:
        if row.get("duplicate_of") and row["duplicate_of"] not in earlier:
            raise ValueError(f"{row['id']}: duplicate_of must reference an earlier row")
        if not isinstance(row.get("text"), str) or not row["text"].strip() or not row.get("category"):
            raise ValueError(f"{row['id']}: text and category are required")
        if norm_severity(row.get("severity")) is None:
            raise ValueError(f"{row['id']}: unrecognised severity")
        earlier.add(row["id"])
    if adapter.MODE == "real":
        unsupported = {norm_label(row["category"]) for row in rows} - adapter.CATEGORIES
        if unsupported:
            raise ValueError(f"Dataset taxonomy does not match Prayaas: {sorted(unsupported)}. "
                             f"Hand-label using {sorted(adapter.CATEGORIES)} before looking at predictions.")
    adapter.prepare()

    preds = await bounded_map(lambda r: adapter.run_pipeline(r["text"]), rows, args.concurrency)
    res = {
        "adapter_mode": adapter.MODE,
        "dataset": str(Path(args.dataset).resolve()),
        "n": len(rows),
        "category": eval_category(rows, preds),
        "severity": eval_severity(rows, preds),
        "selective": eval_selective(rows, preds),
        "pipeline_errors": sum(is_err(p) for p in preds),
    }
    if not args.skip_dedup:
        async def dedup_one(i):
            existing = [{"id": r["id"], "text": r["text"]} for r in rows[:i]]
            return await adapter.find_duplicate(rows[i]["text"], existing)
        dpreds = await bounded_map(dedup_one, range(len(rows)), args.concurrency)
        res["dedup"] = eval_dedup(rows, [None if p is None else p for p in dpreds])

    report = render_report(res, len(rows))
    print(report)
    if len(rows) < 50:
        print(f"\nWARNING: n={len(rows)} is too small to quote. Label at least 50 reports "
              "(100+ is better) before putting numbers on a resume.")
    for path, content in ((args.out, json.dumps(res, indent=2)), (args.report, report)):
        if path:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(content)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--skip-dedup", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--report")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
