"""Turn Seedance masters into signed-ready Harness store payloads.

This is deterministic post-processing only: it never calls a paid model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import imageio_ffmpeg
import imageio.v3 as iio
import cv2
import numpy as np
from PIL import Image


SKINS = [
    ("aurora-library", "极光藏书阁", "极光与书页缓慢流动的未来图书馆", ["nature", "cyber"], ["极光", "图书馆", "静心"]),
    ("neon-rain-studio", "霓虹雨夜工坊", "雨滴与远城灯光呼吸的创作空间", ["cyber"], ["雨夜", "霓虹", "工作室"]),
    ("cloud-sea-sunrise", "云海晨光台", "云层与晨光缓慢变化的高空观景台", ["nature", "minimal"], ["云海", "日出", "明亮"]),
    ("deep-ocean-city", "深海数据城", "鲸影穿过水下光束的静谧数据城市", ["nature", "cyber"], ["深海", "鲸影", "蓝色"]),
    ("ink-mountain-rain", "水墨烟雨山", "云雾穿山、细雨入水的新中式远景", ["nature", "minimal"], ["水墨", "山水", "雨"]),
    ("desert-stars", "沙海星穹站", "银河掠过沙漠研究站的安静长夜", ["realistic", "nature"], ["星空", "沙漠", "研究站"]),
    ("forest-fireflies", "萤火森语屋", "雨后森林与萤火虫围绕的玻璃小屋", ["nature"], ["森林", "萤火虫", "治愈"]),
    ("crystal-cavern", "水晶回声洞", "晶体光泽与水面倒影缓慢流动", ["cyber", "nature"], ["水晶", "洞穴", "蓝紫"]),
    ("orbital-earth", "近地轨道窗", "地球云层从安静舷窗外缓慢转动", ["cyber", "minimal"], ["太空", "地球", "深蓝"]),
    ("lantern-river-town", "灯河古镇夜", "灯笼倒影随河面轻轻流动的东方夜景", ["realistic", "nature"], ["古镇", "灯笼", "河流"]),
    ("moonlit-dance-studio", "月镜舞台", "原创成年舞者在月光水镜舞台舒展起舞，远景构图不干扰阅读", ["realistic", "minimal"], ["舞蹈", "月光", "东方美学"]),
]

PET_ROWS = [
    [
        ("cloud-cat-luna", "云朵猫·露娜", "cat", ["cute", "calm"]),
        ("corgi-engineer-luban", "工程柯基·鲁班", "dog", ["playful"]),
        ("blue-whale-bubble", "蓝鲸·泡泡", "whale", ["cute", "calm"]),
        ("fox-explorer-lan", "探险狐·小岚", "fantasy", ["playful"]),
        ("halo-robot-core", "光环机器人·小核", "robot", ["cyber", "cute"]),
        ("star-slime-jelly", "星星史莱姆·果冻", "fantasy", ["cute", "playful"]),
        ("red-panda-reader-momo", "书卷小熊猫·墨墨", "other", ["calm", "cute"]),
        ("moon-rabbit-xianyue", "月兔·弦月", "fantasy", ["calm", "cute"]),
        ("cyber-axolotl-nini", "赛博六角龙·霓霓", "other", ["cyber", "playful"]),
        ("ember-dragon-tuanhuo", "赤焰幼龙·团火", "fantasy", ["playful"]),
    ],
    [
        ("tuxedo-astronomer", "礼服猫·星野", "cat", ["calm"]),
        ("husky-courier", "哈士奇·快递风", "dog", ["playful"]),
        ("manta-navigator", "蝠鲼·小航", "other", ["calm", "cute"]),
        ("raccoon-mechanic", "浣熊机械师·扳手", "other", ["playful"]),
        ("tea-robot", "茶壶机器人·沏沏", "robot", ["cute", "calm"]),
        ("mushroom-sprite", "蘑菇精灵·伞伞", "fantasy", ["cute"]),
        ("capybara-musician", "水豚乐手·慢慢", "other", ["calm"]),
        ("snow-owl-scholar", "雪鸮学者·知知", "other", ["calm"]),
        ("jelly-space-traveler", "水母旅者·星漂", "fantasy", ["cyber", "cute"]),
        ("baby-griffin", "幼年狮鹫·翼团", "fantasy", ["playful"]),
    ],
    [
        ("code-cat", "代码猫·黑糖", "cat", ["cyber", "calm"]),
        ("retriever-chef", "金毛厨师·小焙", "dog", ["playful"]),
        ("koi-spirit", "锦鲤灵·绯绯", "fantasy", ["calm"]),
        ("otter-inventor", "水獭发明家·齿轮", "other", ["playful"]),
        ("blue-cube-robot", "方糖机器人·蓝蓝", "robot", ["cyber", "cute"]),
        ("cactus-sprite", "仙人掌精灵·刺梨", "fantasy", ["cute"]),
        ("alpaca-traveler", "羊驼旅者·绒云", "other", ["calm"]),
        ("penguin-pilot", "企鹅飞行员·小翼", "other", ["playful"]),
        ("moon-jelly", "月光水母·柔光", "fantasy", ["calm", "cute"]),
        ("baby-phoenix", "幼凤·暖羽", "fantasy", ["playful"]),
    ],
    [
        ("tabby-detective", "银虎斑侦探·寻迹", "cat", ["calm"]),
        ("shiba-gardener", "柴犬园丁·花豆", "dog", ["cute"]),
        ("turtle-cartographer", "海龟绘图师·小岛", "other", ["calm"]),
        ("beaver-architect", "河狸建筑师·木尺", "other", ["playful"]),
        ("retro-tv-robot", "电视机器人·频道", "robot", ["pixel", "cute"]),
        ("acorn-guardian", "橡果守卫·小栎", "fantasy", ["calm"]),
        ("yak-tea-merchant", "牦牛茶商·暖壶", "other", ["calm"]),
        ("puffin-photographer", "海鹦摄影师·咔嚓", "other", ["playful"]),
        ("comet-ghost", "彗星幽灵·尾光", "fantasy", ["cute", "calm"]),
        ("jade-qilin", "碧玉小麟·青团", "fantasy", ["cute"]),
    ],
    [
        ("calico-painter", "三花画家·彩点", "cat", ["playful"]),
        ("samoyed-cloudkeeper", "萨摩耶·云守", "dog", ["cute", "calm"]),
        ("seahorse-magician", "海马魔法师·旋星", "fantasy", ["playful"]),
        ("mole-geologist", "鼹鼠地质家·岩岩", "other", ["calm"]),
        ("lantern-robot", "灯塔机器人·明明", "robot", ["cyber", "calm"]),
        ("lotus-sprite", "莲叶精灵·荷露", "fantasy", ["calm", "cute"]),
        ("fennec-stargazer", "耳廓狐·望星", "fantasy", ["calm"]),
        ("seal-medic", "海豹医师·小蓝", "other", ["cute"]),
        ("crystal-bat", "水晶蝠·紫晶", "fantasy", ["cyber", "playful"]),
        ("jade-lion", "翡翠小狮·镇镇", "fantasy", ["playful"]),
    ],
]

SPEECH = [
    ["今天先完成最重要的一小步。", "我在旁边陪你。", "别忘了休息一下眼睛。"],
    ["需要我帮你守住专注吗？", "进度正在变好。", "点我一下，换个心情。"],
    ["慢一点也没关系。", "我会记住这个工作位置。", "继续，我们快完成了。"],
]


def run(command: list[str]) -> None:
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if completed.returncode:
        raise RuntimeError(completed.stderr[-3000:])


def digest(path: Path) -> tuple[str, int]:
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest(), len(data)


def asset(path: Path, url: str, mime: str) -> dict[str, Any]:
    sha, size = digest(path)
    return {"url": url, "sha256": sha, "size": size, "mime": mime}


def gitee(repo: str, folder: str, filename: str) -> str:
    return f"https://gitee.com/wanggp123/{repo}/raw/master/{folder}/{filename}"


def keep_existing(payload_path: Path, prefix: str) -> list[dict[str, Any]]:
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    return [item for item in payload.get("items", []) if not str(item.get("id", "")).startswith(prefix)]


def build_skins(ffmpeg: str, source: Path, root: Path) -> list[dict[str, Any]]:
    assets = root / "skin-store" / "assets"
    thumbs = root / "skin-store" / "thumbnails"
    assets.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    filters = ["hue=h=18:s=1.08", "eq=contrast=1.05:saturation=.92:brightness=-.03"]
    variants = [
        ("motion", "动态原景", "video", None, 0.72),
        ("motion-alt", "动态异色", "video", filters[0], 0.74),
        ("still-focus", "专注定格", "image", None, 0.78),
        ("still-soft", "柔光定格", "image", filters[1], 0.8),
        ("still-vivid", "鲜明定格", "image", "eq=contrast=1.08:saturation=1.12", 0.76),
    ]
    times = ["0.8", "2.4", "4.2"]
    for base_id, name, description, styles, tags in SKINS:
        master = source / "skin" / f"{base_id}.mp4"
        if not master.is_file():
            raise FileNotFoundError(master)
        poster_name = f"sd2-{base_id}-poster.webp"
        poster_path = assets / poster_name
        run([ffmpeg, "-y", "-ss", "1.0", "-i", str(master), "-frames:v", "1", "-vf", "scale=1920:1080", "-c:v", "libwebp", "-q:v", "82", str(poster_path)])
        poster_asset = asset(poster_path, gitee("deepseek-harness-skins", "assets", poster_name), "image/webp")
        for index, (suffix, label, kind, color_filter, opacity) in enumerate(variants):
            item_id = f"sd2-{base_id}-{suffix}"
            thumb_name = f"{item_id}.webp"
            thumb_path = thumbs / thumb_name
            seek = times[min(max(index - 2, 0), 2)]
            thumb_filter = "scale=640:360" + (f",{color_filter}" if color_filter else "")
            run([ffmpeg, "-y", "-ss", seek, "-i", str(master), "-frames:v", "1", "-vf", thumb_filter, "-c:v", "libwebp", "-q:v", "78", str(thumb_path)])
            if kind == "video":
                media_name = f"{item_id}.mp4"
                media_path = assets / media_name
                if color_filter:
                    run([ffmpeg, "-y", "-i", str(master), "-an", "-vf", f"{color_filter},scale=1920:1080,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-movflags", "+faststart", str(media_path)])
                else:
                    media_path.write_bytes(master.read_bytes())
                media_kind, mime = "video", "video/mp4"
            else:
                media_name = f"{item_id}.webp"
                media_path = assets / media_name
                full_filter = "scale=1920:1080" + (f",{color_filter}" if color_filter else "")
                run([ffmpeg, "-y", "-ss", seek, "-i", str(master), "-frames:v", "1", "-vf", full_filter, "-c:v", "libwebp", "-q:v", "84", str(media_path)])
                media_kind, mime = "image", "image/webp"
            items.append({
                "id": item_id,
                "name": f"{name} · {label}",
                "description": description + ("，适合作为低干扰动态壁纸。" if kind == "video" else "，保留1080P清晰细节。"),
                "mediaKind": media_kind,
                "styles": styles,
                "tags": tags + (["动态壁纸", "1080P"] if kind == "video" else ["1080P", "静态壁纸"]),
                "featured": suffix == "motion",
                "contentRating": "everyone",
                "thumbnail": asset(thumb_path, gitee("deepseek-harness-skins", "thumbnails", thumb_name), "image/webp"),
                "media": asset(media_path, gitee("deepseek-harness-skins", "assets", media_name), mime),
                **({"poster": poster_asset} if kind == "video" else {}),
                "license": {"name": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/", "author": "DeepSeekHarness 原创 AI 视觉实验室", "sourceUrl": "https://gitee.com/wanggp123/deepseek-harness-skins", "attribution": "原创生成素材；禁止冒充真人或第三方IP。"},
                "presentation": {"position": "50% 50%", "overlay": "rgba(2, 9, 20, 0.34)", "blurPx": 0, "surfaceOpacity": opacity},
            })
    return items


def transparent_pet_frame(frame: np.ndarray, pet_index: int) -> Image.Image:
    """Extract one grid cell and remove only the connected magenta backdrop.

    Seedance's H.264 output introduces several shades around the chroma edge.
    A simple FFmpeg chromakey leaves blocks behind or erases purple details, so
    the mask uses magenta dominance, keeps the largest foreground component,
    and neutralizes colour spill only on semi-transparent edge pixels.
    """
    height, width = frame.shape[:2]
    cell_width, cell_height = width // 5, height // 2
    col, row = pet_index % 5, pet_index // 5
    crop = frame[row * cell_height:(row + 1) * cell_height, col * cell_width:(col + 1) * cell_width].copy()
    rgb = crop.astype(np.float32)
    magenta_score = (rgb[:, :, 0] + rgb[:, :, 2]) / 2 - rgb[:, :, 1]
    alpha = np.clip((130 - magenta_score) / 75 * 255, 0, 255).astype(np.uint8)
    # Use a confident core to separate a pet from any neighbour crossing the
    # fixed grid boundary, then expand back into the soft antialiased edge.
    component_source = (alpha > 96).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(component_source, 8)
    candidates = [label for label in range(1, count) if stats[label, cv2.CC_STAT_AREA] > 40]
    if not candidates:
        raise RuntimeError(f"No pet foreground found for grid cell {pet_index}")
    foreground = max(candidates, key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
    keep = cv2.dilate((labels == foreground).astype(np.uint8), np.ones((7, 7), np.uint8), iterations=1) > 0
    alpha = np.where(keep, alpha, 0).astype(np.uint8)
    edge = alpha < 250
    green_cap = np.minimum(255, crop[:, :, 1].astype(np.int16) + 18).astype(np.uint8)
    crop[:, :, 0] = np.where(edge, np.minimum(crop[:, :, 0], green_cap), crop[:, :, 0])
    crop[:, :, 2] = np.where(edge, np.minimum(crop[:, :, 2], green_cap), crop[:, :, 2])
    pet = Image.fromarray(np.dstack([crop, alpha]), "RGBA")
    pet.thumbnail((320, 320), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (360, 360))
    canvas.alpha_composite(pet, ((360 - pet.width) // 2, (360 - pet.height) // 2))
    return canvas


def build_pets(ffmpeg: str, source: Path, root: Path) -> list[dict[str, Any]]:
    assets = root / "pet-store" / "assets"
    thumbs = root / "pet-store" / "thumbnails"
    assets.mkdir(parents=True, exist_ok=True)
    thumbs.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    for group_index, pets in enumerate(PET_ROWS, start=1):
        master = source / "pet-sheet" / f"pets-group-{group_index}.mp4"
        if not master.is_file():
            raise FileNotFoundError(master)
        # Eight frames per second is smooth for subtle idle motion while
        # keeping each transparent pet comfortably below the 12 MiB limit.
        frames = [frame for index, frame in enumerate(iio.imiter(master, plugin="FFMPEG")) if index % 3 == 0]
        if len(frames) < 40:
            raise RuntimeError(f"Pet motion sheet is too short: {master}")
        for pet_index, (pet_id, name, species, styles) in enumerate(pets):
            item_id = f"sd2-{pet_id}"
            media_name = f"{item_id}.webp"
            thumb_name = f"{item_id}.webp"
            media_path, thumb_path = assets / media_name, thumbs / thumb_name
            pet_frames = [transparent_pet_frame(frame, pet_index) for frame in frames]
            pet_frames[0].save(
                media_path,
                "WEBP",
                save_all=True,
                append_images=pet_frames[1:],
                duration=125,
                loop=0,
                quality=72,
                method=4,
                lossless=False,
            )
            pet_frames[len(pet_frames) // 2].save(thumb_path, "WEBP", quality=82, method=4)
            items.append({
                "id": item_id,
                "name": name,
                "description": "Seedance 2.0 原创透明帧动画宠物，可拖动、点击互动并主动陪伴。",
                "mediaKind": "animated",
                "species": species,
                "styles": styles,
                "tags": ["帧动画", "透明", "可拖动", "会说话"],
                "featured": pet_index in {0, 2, 4, 7, 9},
                "contentRating": "everyone",
                "thumbnail": asset(thumb_path, gitee("deepseek-harness-pets", "thumbnails", thumb_name), "image/webp"),
                "media": asset(media_path, gitee("deepseek-harness-pets", "assets", media_name), "image/webp"),
                "license": {"name": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/", "author": "DeepSeekHarness 原创 AI 视觉实验室", "sourceUrl": "https://gitee.com/wanggp123/deepseek-harness-pets", "attribution": "原创生成角色；禁止冒充第三方IP。"},
                "behavior": {
                    "widthPx": 176 + (pet_index % 3) * 12,
                    "idleMotion": ["float", "bounce", "float"][pet_index % 3],
                    "clickMotion": ["hop", "heart", "spin"][pet_index % 3],
                    "speechLines": SPEECH[(group_index + pet_index) % len(SPEECH)],
                    "autoSpeakIntervalSec": 72 + (pet_index % 4) * 12,
                    "hoverMotion": "perk",
                },
            })
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--project-root", required=True, type=Path)
    args = parser.parse_args()
    root = args.project_root.resolve()
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    skin_payload = root / "skin-store" / "catalog.payload.json"
    pet_payload = root / "pet-store" / "catalog.payload.json"
    skins = keep_existing(skin_payload, "sd2-") + build_skins(ffmpeg, args.source_root, root)
    pets = keep_existing(pet_payload, "sd2-") + build_pets(ffmpeg, args.source_root, root)
    now = datetime.now(timezone.utc).isoformat()
    skin_payload.write_text(json.dumps({"schemaVersion": 1, "generatedAt": now, "pageSize": 20, "items": skins}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pet_payload.write_text(json.dumps({"schemaVersion": 1, "generatedAt": now, "pageSize": 20, "items": pets}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "skins": len(skins), "pets": len(pets)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
