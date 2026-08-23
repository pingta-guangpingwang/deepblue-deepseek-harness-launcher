"""Release gate for the generated DeepSeekHarness skin and pet stores."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import imageio.v3 as iio
from PIL import Image


def check(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_assets(root: Path, folder: str, items: list[dict]) -> None:
    for item in items:
        for key in ("thumbnail", "media", "poster"):
            asset = item.get(key)
            if not asset:
                continue
            name = Path(asset["url"].split("?", 1)[0]).name
            local = root / folder / ("thumbnails" if key == "thumbnail" else "assets") / name
            check(local.is_file(), f"Missing {folder} asset: {local}")
            check(local.stat().st_size == asset["size"], f"Size mismatch: {local}")
            check(sha256(local) == asset["sha256"], f"SHA-256 mismatch: {local}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("--generation-root", required=True, type=Path)
    args = parser.parse_args()
    root = args.project_root.resolve()
    generated = args.generation_root.resolve()

    ledger = json.loads((generated / "generation-ledger.json").read_text(encoding="utf-8"))
    seconds = sum(int(item["duration"]) for item in ledger["completed"])
    cost = sum(float(item["costCny"]) for item in ledger["completed"])
    check(seconds <= 200, f"Paid duration exceeds 200 seconds: {seconds}")
    check(cost <= 400, f"Paid generation exceeds CNY 400: {cost}")

    skin_masters = sorted((generated / "skin").glob("*.mp4"))
    check(len(skin_masters) == 11, f"Expected 11 skin masters, got {len(skin_masters)}")
    for master in skin_masters:
        meta = iio.immeta(master, plugin="FFMPEG")
        check(tuple(meta.get("size") or ()) == (1920, 1080), f"Skin is not 1080P: {master}")
        check(4.8 <= float(meta.get("duration") or 0) <= 5.3, f"Unexpected skin duration: {master}")

    skin_payload = json.loads((root / "skin-store" / "catalog.payload.json").read_text(encoding="utf-8"))
    pet_payload = json.loads((root / "pet-store" / "catalog.payload.json").read_text(encoding="utf-8"))
    skins, pets = skin_payload["items"], pet_payload["items"]
    check(len(skins) >= 63, f"Expected at least 63 skins, got {len(skins)}")
    check(len(pets) >= 50, f"Expected at least 50 pets, got {len(pets)}")
    check(len({item["id"] for item in skins}) == len(skins), "Duplicate skin id")
    check(len({item["id"] for item in pets}) == len(pets), "Duplicate pet id")
    check(sum(item["mediaKind"] == "video" for item in skins) >= 22, "Expected at least 22 video skins")

    new_pets = [item for item in pets if item["id"].startswith("sd2-")]
    check(len(new_pets) == 50, f"Expected 50 generated pets, got {len(new_pets)}")
    check(len(new_pets) == len(pets), "Pet catalog must not contain legacy static pets")
    for item in new_pets:
        check(item.get("mediaKind") == "animated", f"Pet is not declared animated: {item['id']}")
        local = root / "pet-store" / "assets" / Path(item["media"]["url"]).name
        with Image.open(local) as image:
            check(image.size == (360, 360), f"Unexpected pet canvas: {local}")
            check(getattr(image, "n_frames", 1) >= 40, f"Pet is not animated: {local}")
            image.seek(min(10, image.n_frames - 1))
            check("A" in image.mode and image.getchannel("A").getextrema()[0] == 0, f"Pet has no transparency: {local}")
        check(local.stat().st_size <= 12 * 1024 * 1024, f"Pet exceeds 12 MiB: {local}")
        behavior = item.get("behavior") or {}
        check(30 <= int(behavior.get("autoSpeakIntervalSec") or 0) <= 600, f"Invalid active greeting: {item['id']}")
        check(behavior.get("hoverMotion") == "perk", f"Missing hover reaction: {item['id']}")

    verify_assets(root, "skin-store", skins)
    verify_assets(root, "pet-store", pets)
    print(json.dumps({"ok": True, "seconds": seconds, "costCny": cost, "skins": len(skins), "pets": len(pets)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
