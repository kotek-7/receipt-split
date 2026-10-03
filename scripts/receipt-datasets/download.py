#!/usr/bin/env python3
"""Fetch the pinned, small receipt evaluation corpus; never select by model output."""
import argparse
import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_yen(value):
    """Accept integer yen and genuine three-digit grouping, never decimal yen."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFKC", value).strip()
    text = re.sub(r"^[¥￥]", "", text)
    text = re.sub(r"円$", "", text).strip()
    text = text.replace("−", "-").replace("△", "-").replace("▲", "-")
    if re.fullmatch(r"-?\d{1,3}(?:,\d{3})+", text):
        text = text.replace(",", "")
    elif re.fullmatch(r"-?\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    if not re.fullmatch(r"-?\d+", text):
        return None
    return int(text)


def normalize_quantity(value):
    # Absence denotes a single purchase. A present but unreadable value is not guessed.
    if value is None or value == "":
        return 1
    if isinstance(value, int) and not isinstance(value, bool):
        return value if value > 0 else None
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFKC", value).strip()
    match = re.fullmatch(r"(?:[×xX]\s*)?(\d+)(?:\s*(?:点|コ|個|杯|本|枚|箱|皿|人|名))?(?:\s*[×xX])?", text)
    return int(match[1]) if match and int(match[1]) > 0 else None


def normalize_ground_truth(kind, source, fixture_id):
    if kind == "jawildtext":
        fields = source["fields"]
        total_value = fields["total_amount"]["value"]
        rows = [{"name": row["item_name"]["value"], "amount": row["item_price"]["value"], "quantity": row["item_quantity"]["value"]} for row in fields["line_items"]]
    else:
        total_value = source["totals"].get("total_yen")
        rows = [{"name": row.get("name"), "amount": row.get("amount_yen"), "quantity": row.get("quantity")} for row in source["items"]]
    total = normalize_yen(total_value)
    skipped = []
    counts = {"zeroAmountItems": 0, "negativeAmountItems": 0, "unreadableItems": 0, "defaultedQuantities": 0}
    if total is None or total < 0:
        return None, counts, [{"id": fixture_id, "scope": "receipt", "reason": "missing_or_unreadable_total"}]
    items = []
    for index, row in enumerate(rows):
        amount = normalize_yen(row["amount"])
        if amount == 0:
            counts["zeroAmountItems"] += 1
            continue
        if amount is not None and amount < 0:
            counts["negativeAmountItems"] += 1
            continue
        name = row["name"]
        quantity = normalize_quantity(row["quantity"])
        reason = "missing_or_unreadable_amount" if amount is None else "missing_or_unreadable_name" if not isinstance(name, str) or not name.strip() else "unreadable_quantity" if quantity is None else None
        if reason:
            counts["unreadableItems"] += 1
            skipped.append({"id": fixture_id, "scope": "item", "row": index, "reason": reason})
            continue
        if row["quantity"] is None or row["quantity"] == "":
            counts["defaultedQuantities"] += 1
        items.append({"name": unicodedata.normalize("NFKC", name).strip(), "amount": amount, "quantity": quantity})
    if counts["unreadableItems"]:
        skipped.append({"id": fixture_id, "scope": "receipt", "reason": "incomplete_line_item_ground_truth"})
        return None, counts, skipped
    if not items:
        skipped.append({"id": fixture_id, "scope": "receipt", "reason": "no_positive_readable_items"})
        return None, counts, skipped
    return {"total": total, "items": items}, counts, skipped


def curl(url, target, headers=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    command = ["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "2", "--max-time", "60", "--max-filesize", "15000000"]
    if headers is not None:
        command += ["--dump-header", str(headers)]
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        subprocess.run(command + [url, "--output", str(temporary_path)], check=True)
        temporary_path.replace(target)
    finally:
        temporary_path.unlink(missing_ok=True)


def verify(path, expected):
    actual = sha256(path)
    if actual != expected:
        raise ValueError(f"SHA-256 mismatch: {path} (expected {expected}, got {actual})")


def fetch_dataset(dataset, output, cache):
    root = output / dataset["key"]
    root.mkdir(parents=True, exist_ok=True)
    by_path = {entry["path"]: entry for entry in dataset["files"]}
    missing = []
    for entry in dataset["files"]:
        target = root / entry["path"]
        if target.exists():
            verify(target, entry["sha256"])
        elif cache and (cache / entry["cachePath"]).exists():
            cached = cache / entry["cachePath"]
            verify(cached, entry["sha256"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cached, target)
        else:
            missing.append(entry)
    rows = {}
    if dataset["key"] == "jawildtext" and any(entry.get("rowIndex") is not None for entry in missing):
        # The viewer API serves the current dataset. Refuse drift; the recorded revision is mandatory.
        with tempfile.TemporaryDirectory() as temporary:
            body, headers = Path(temporary) / "rows.json", Path(temporary) / "headers.txt"
            curl(dataset["rowsUrl"], body, headers)
            revisions = re.findall(r"^x-revision:\s*(\S+)", headers.read_text(), re.MULTILINE | re.IGNORECASE)
            if dataset["revision"] not in revisions:
                raise ValueError("JaWildText viewer revision changed. Use an existing SHA-verified cache or explicitly prepare a new dataset lock; do not silently replace this benchmark.")
            rows = {entry["row_idx"]: entry["row"] for entry in json.loads(body.read_text())["rows"]}
    def download(entry):
        target = root / entry["path"]
        index = entry.get("rowIndex")
        if index is not None and entry["kind"] == "ground_truth":
            source = {key: value for key, value in rows[index].items() if key != "image"}
            # Preserve the canonical download serialization used to pin these original annotations.
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(source, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            url = rows[index]["image"]["src"] if index is not None else entry["sourceUrl"]
            curl(url, target)
        verify(target, entry["sha256"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(download, missing))
    fixtures, skipped = [], []
    for record in dataset["records"]:
        source = json.loads((root / record["groundTruth"]).read_text())
        expected, excluded, issues = normalize_ground_truth(dataset["key"], source, record["id"])
        skipped.extend(issues)
        if expected is None:
            continue
        fixtures.append({"id": record["id"], "image": record["image"], "split": record["split"], "expected": expected, "excluded": excluded, "sourceUrl": record["sourceUrl"], "groundTruth": record["groundTruth"], "imageSha256": by_path[record["image"]]["sha256"], "groundTruthSha256": by_path[record["groundTruth"]]["sha256"]})
    write_json(root / "manifest.json", {"dataset": dataset["dataset"], "revision": dataset["revision"], "license": dataset["license"], "synthetic": dataset["synthetic"], "sourceUrl": dataset["sourceUrl"], "fixtures": fixtures, "skipped": skipped})
    write_json(root / "source-lock.json", dataset)
    print(f"{dataset['key']}: {len(fixtures)} fixtures, {len(skipped)} annotation exclusions; {root / 'manifest.json'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/receipt-datasets"))
    parser.add_argument("--cache", type=Path, help="Optional previously downloaded /tmp/receipt-ocr-datasets directory")
    parser.add_argument("--dataset", choices=["all", "jawildtext", "jomb-alpha10"], default="all")
    args = parser.parse_args()
    lock = json.loads((HERE / "sources.lock.json").read_text())
    for dataset in lock["datasets"]:
        if args.dataset in ("all", dataset["key"]):
            fetch_dataset(dataset, args.output, args.cache)


if __name__ == "__main__":
    main()
