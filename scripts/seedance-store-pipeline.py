"""Budget-capped Seedance pipeline for premium Harness skin and pet stores.

The script deliberately reads credentials from the existing local Seedance
quickstart project and never prints them. It creates 1080P looping wallpaper
videos and 720P multi-pet motion sheets while enforcing a hard duration/cost
ceiling before any paid request is submitted.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


RATES = {"1080p": 2.0, "720p": 1.2, "480p": 0.8}
HARD_MAX_SECONDS = 200
HARD_MAX_CNY = 400.0
MODEL_ID = "doubao-seedance-2-0-260128"


@dataclass(frozen=True)
class Job:
    id: str
    kind: str
    prompt: str
    resolution: str
    duration: int
    ratio: str = "16:9"
    reference_image: str | None = None

    @property
    def cost_cny(self) -> float:
        return self.duration * RATES[self.resolution]


WALLPAPER_PROMPTS = [
    ("aurora-library", "原创未来图书馆临窗夜景，远处极光缓慢流动，书页与微尘轻轻漂浮，镜头完全固定，首尾无缝循环，中央与左侧保留低干扰阅读区，深蓝青绿配色，无文字无标志无人像"),
    ("neon-rain-studio", "原创赛博创作工作室雨夜窗景，玻璃雨滴缓慢滑落，远处霓虹轻微呼吸，桌面光线稳定，镜头完全固定，首尾无缝循环，深蓝紫色，无文字无标志无人像"),
    ("cloud-sea-sunrise", "原创云海日出高空观景台，云层缓慢流动，暖光轻微变化，镜头完全固定，首尾无缝循环，右侧保留清晰界面阅读区，无文字无标志无人像"),
    ("deep-ocean-city", "原创深海数据城市与远处鲸影，水下光束缓慢摆动，微小气泡上升，镜头完全固定，首尾无缝循环，深蓝青色，无文字无标志"),
    ("ink-mountain-rain", "原创新中式水墨山谷细雨，云雾缓慢穿山，水面只有细微涟漪，镜头完全固定，首尾无缝循环，留出大面积浅灰蓝阅读区，无题字无印章无人像"),
    ("desert-stars", "原创沙漠星空研究站，银河缓慢移动，远处风沙极轻，室内暖光稳定，镜头完全固定，首尾无缝循环，无文字无标志无人像"),
    ("forest-fireflies", "原创雨后森林玻璃小屋，萤火虫缓慢游走，叶片轻摆，镜头完全固定，首尾无缝循环，绿色与深蓝，无文字无标志无人像"),
    ("crystal-cavern", "原创蓝紫水晶洞穴工作空间，晶体光泽缓慢流动，水面柔和反射，镜头完全固定，首尾无缝循环，无文字无标志无人像"),
    ("orbital-earth", "原创近地轨道安静舷窗，地球云层缓慢转动，仪表仅作抽象光点且没有可读文字，镜头完全固定，首尾无缝循环，深蓝黑配色"),
    ("lantern-river-town", "原创东方河畔古镇夜景，灯笼倒影与水面缓慢流动，镜头完全固定，首尾无缝循环，画面克制安静，无人物无文字无标志"),
    ("moonlit-dance-studio", "原创成年东方舞者在月光水镜舞台做舒展的现代舞循环，人物完整着装、动作优雅克制、不突出身体部位、不模仿任何真人，远景构图，面部不是视觉焦点，镜头完全固定，首尾姿态衔接，左侧保留低干扰阅读区，无文字无标志"),
]


def load_key(seedance_root: Path) -> str:
    cfg = seedance_root / "python" / "app_config.local.json"
    data = json.loads(cfg.read_text(encoding="utf-8"))
    key = str(data.get("api_key") or "").strip()
    if not key:
        raise RuntimeError("Seedance local API key is not configured")
    return key


def load_modules(seedance_root: Path) -> tuple[Any, Any]:
    sys.path.insert(0, str(seedance_root / "python"))
    from volcenginesdkarkruntime import Ark  # type: ignore
    from tos_storage import upload_media_file  # type: ignore
    return Ark, upload_media_file


def build_jobs(anchor_dir: Path) -> list[Job]:
    jobs = [
        Job(id=job_id, kind="skin", prompt=prompt, resolution="1080p", duration=5)
        for job_id, prompt in WALLPAPER_PROMPTS
    ]
    for index in range(1, 6):
        motion_safe = anchor_dir / "motion-safe" / f"pets-group-{index}.png"
        anchor = motion_safe if motion_safe.is_file() else anchor_dir / f"pets-group-{index}.png"
        if not anchor.is_file():
            raise FileNotFoundError(anchor)
        jobs.append(Job(
            id=f"pets-group-{index}",
            kind="pet-sheet",
            resolution="720p",
            duration=5,
            ratio="adaptive",
            reference_image=str(anchor),
            prompt=(
                "保持图中十个原创宠物的身份、服装、颜色、五列两行位置和纯洋红背景完全不变。"
                "十个宠物分别只做很轻的循环待机动作：自然眨眼、呼吸、耳朵或尾巴轻摆；"
                "不得换位、不得靠近边界、不得增加物体、粒子、阴影、文字或镜头运动。"
                "第一帧与最后一帧姿态一致，适合切成透明桌面宠物帧动画。"
            ),
        ))
    return jobs


def budget_summary(jobs: list[Job]) -> dict[str, float]:
    seconds = sum(job.duration for job in jobs)
    cost = sum(job.cost_cny for job in jobs)
    if seconds > HARD_MAX_SECONDS or cost > HARD_MAX_CNY:
        raise RuntimeError(f"Budget blocked: {seconds}s / CNY {cost:.2f}")
    return {"seconds": seconds, "estimatedCostCny": round(cost, 2)}


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".partial")
    with urllib.request.urlopen(url, timeout=120) as response, temp.open("wb") as out:
        shutil.copyfileobj(response, out)
    temp.replace(target)


def submit(client: Any, upload_media_file: Any, job: Job, output_dir: Path) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "text", "text": job.prompt}]
    upload_info = None
    if job.reference_image:
        image_path = Path(job.reference_image)
        upload_info = upload_media_file(image_path, image_path.name, "image", "image/png")
        content.append({
            "type": "image_url",
            "image_url": {"url": upload_info["url"]},
            "role": "first_frame",
        })
        content.append({
            "type": "image_url",
            "image_url": {"url": upload_info["url"]},
            "role": "last_frame",
        })
    result = client.content_generation.tasks.create(
        model=MODEL_ID,
        content=content,
        generate_audio=False,
        ratio=job.ratio,
        duration=job.duration,
        resolution=job.resolution,
        watermark=False,
    )
    task_id = result.id
    while True:
        task = client.content_generation.tasks.get(task_id=task_id)
        status = str(task.status)
        if status == "succeeded":
            video_url = task.content.video_url
            target = output_dir / job.kind / f"{job.id}.mp4"
            download(video_url, target)
            return {
                "id": job.id,
                "taskId": task_id,
                "status": "succeeded",
                "output": str(target),
                "duration": job.duration,
                "resolution": job.resolution,
                "costCny": job.cost_cny,
                "referenceObjectKey": (upload_info or {}).get("object_key"),
            }
        if status == "failed":
            raise RuntimeError(f"Seedance job {job.id} failed: {task.error}")
        time.sleep(20)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seedance-root", required=True, type=Path)
    parser.add_argument("--anchor-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--force", action="store_true", help="Regenerate selected jobs while still enforcing cumulative spend limits")
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()

    jobs = build_jobs(args.anchor_dir)
    if args.only:
        wanted = set(args.only)
        jobs = [job for job in jobs if job.id in wanted]
    summary = budget_summary(jobs)
    plan = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "hardLimits": {"seconds": HARD_MAX_SECONDS, "costCny": HARD_MAX_CNY},
        "planned": summary,
        "jobs": [{**asdict(job), "costCny": job.cost_cny} for job in jobs],
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "budget-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "execute": args.execute, **summary, "jobs": len(jobs)}, ensure_ascii=False))
    if not args.execute:
        return 0

    Ark, upload_media_file = load_modules(args.seedance_root)
    client = Ark(api_key=load_key(args.seedance_root))
    ledger_path = args.output_dir / "generation-ledger.json"
    ledger: list[dict[str, Any]] = []
    if ledger_path.is_file():
        try:
            previous = json.loads(ledger_path.read_text(encoding="utf-8"))
            ledger = list(previous.get("completed") or [])
        except (OSError, json.JSONDecodeError, TypeError):
            ledger = []
    completed_ids = {str(item.get("id")) for item in ledger if item.get("status") == "succeeded"}
    payable_jobs = [job for job in jobs if args.force or job.id not in completed_ids]
    cumulative_seconds = sum(int(item.get("duration") or 0) for item in ledger) + sum(job.duration for job in payable_jobs)
    cumulative_cost = sum(float(item.get("costCny") or 0) for item in ledger) + sum(job.cost_cny for job in payable_jobs)
    if cumulative_seconds > HARD_MAX_SECONDS or cumulative_cost > HARD_MAX_CNY:
        raise RuntimeError(f"Cumulative budget blocked: {cumulative_seconds}s / CNY {cumulative_cost:.2f}")
    for job in jobs:
        target = args.output_dir / job.kind / f"{job.id}.mp4"
        if not args.force and job.id in completed_ids and target.is_file() and target.stat().st_size > 0:
            print(json.dumps({"id": job.id, "status": "already-complete"}, ensure_ascii=False))
            continue
        ledger.append(submit(client, upload_media_file, job, args.output_dir))
        ledger_path.write_text(
            json.dumps({"planned": summary, "completed": ledger}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
