"""Recompose pet contact sheets into a 16:9 motion-safe grid.

Seedance may crop a 3:2 reference when the generated video is 16:9. This
script extracts each original character and places it inside its own 256x360
cell with explicit gutters, so no outer character can be lost.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def isolate(cell: np.ndarray) -> Image.Image:
    rgb = cell.astype(np.float32)
    magenta_score = (rgb[:, :, 0] + rgb[:, :, 2]) / 2 - rgb[:, :, 1]
    alpha = np.clip((135 - magenta_score) / 70 * 255, 0, 255).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 96).astype(np.uint8), 8)
    candidates = [label for label in range(1, count) if stats[label, cv2.CC_STAT_AREA] > 80]
    if not candidates:
        raise RuntimeError("Unable to find character foreground")
    foreground = max(candidates, key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
    keep = cv2.dilate((labels == foreground).astype(np.uint8), np.ones((7, 7), np.uint8), iterations=1) > 0
    alpha = np.where(keep, alpha, 0).astype(np.uint8)
    ys, xs = np.nonzero(alpha > 4)
    rgba = Image.fromarray(np.dstack([cell, alpha]), "RGBA")
    return rgba.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def prepare(source: Path, target: Path) -> None:
    image = np.array(Image.open(source).convert("RGB"))
    height, width = image.shape[:2]
    source_cell_width, source_cell_height = width // 5, height // 2
    canvas = Image.new("RGB", (1280, 720), (255, 0, 255))
    for index in range(10):
        col, row = index % 5, index // 5
        cell = image[
            row * source_cell_height:(row + 1) * source_cell_height,
            col * source_cell_width:(col + 1) * source_cell_width,
        ]
        pet = isolate(cell)
        pet.thumbnail((196, 296), Image.Resampling.LANCZOS)
        x = col * 256 + (256 - pet.width) // 2
        y = row * 360 + (360 - pet.height) // 2
        canvas.paste(pet.convert("RGB"), (x, y), pet.getchannel("A"))
    target.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(target, "PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--anchor-dir", required=True, type=Path)
    args = parser.parse_args()
    target_dir = args.anchor_dir / "motion-safe"
    for index in range(1, 6):
        prepare(args.anchor_dir / f"pets-group-{index}.png", target_dir / f"pets-group-{index}.png")
    print(f"Prepared five motion-safe contact sheets in {target_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
