"""Brand configuration helpers for the graph explorer."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from urllib.parse import quote


_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

DEFAULT_BRAND = {
    "name": "Teradata",
    "logo_uri": None,
    "logo_text": "t.",
    "colors": {
        "accent": "#FF5F02",
        "background": "#00233C",
        "background_light": "#0D3654",
        "background_lighter": "#154868",
        "panel": "rgba(13, 54, 84, 0.92)",
        "panel_solid": "#0D3654",
        "border": "#1F5478",
        "border_light": "#154868",
        "text": "#FFFFFF",
        "text_dim": "rgba(255, 255, 255, 0.65)",
        "muted": "rgba(255, 255, 255, 0.5)",
    },
    "palette": [
        "#FF5F02", "#4A90E2", "#7ED321", "#D8BFD8",
        "#FFD93D", "#22D3EE", "#F472B6", "#FBBF24",
    ],
}

CSS_VAR_MAP = {
    "accent": ["--td-orange", "--accent"],
    "background": ["--td-navy", "--bg"],
    "background_light": ["--td-navy-light"],
    "background_lighter": ["--td-navy-lighter"],
    "panel": ["--panel"],
    "panel_solid": ["--panel-solid"],
    "border": ["--border"],
    "border_light": ["--border-light"],
    "text": ["--text", "--td-white"],
    "text_dim": ["--text-dim"],
    "muted": ["--muted"],
}


def load_brand_config(path: str | None) -> dict:
    """Load and validate a brand config, or return the default brand."""
    if not path:
        return normalise_brand(DEFAULT_BRAND, None)
    config_path = Path(path).expanduser().resolve()
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"could not read brand config {config_path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"brand config is not valid JSON: {exc}") from exc
    return normalise_brand(raw, config_path.parent)


def normalise_brand(raw: dict | None, base_dir: Path | None = None) -> dict:
    """Merge a user brand with defaults and validate key fields."""
    merged = json.loads(json.dumps(DEFAULT_BRAND))
    if raw:
        merged.update({k: v for k, v in raw.items() if k not in {"colors", "palette"}})
        merged["colors"].update(raw.get("colors", {}))
        if raw.get("palette"):
            merged["palette"] = raw["palette"]

    if not merged.get("name"):
        raise ValueError("brand config requires a non-empty name")

    for key, value in merged["colors"].items():
        if value.startswith("#") and not _HEX_RE.fullmatch(value):
            raise ValueError(f"brand colour {key} must be a #RRGGBB hex value")

    palette = merged.get("palette") or []
    if not palette or any(not _HEX_RE.fullmatch(v) for v in palette):
        raise ValueError("brand palette must contain #RRGGBB hex values")

    if merged.get("logo_path"):
        if base_dir is None:
            base_dir = Path.cwd()
        logo_path = (base_dir / merged["logo_path"]).resolve()
        merged["logo_uri"] = _image_data_uri(logo_path)
    elif not merged.get("logo_uri"):
        merged["logo_uri"] = _text_logo_uri(merged.get("logo_text") or merged["name"],
                                             merged["colors"]["accent"])
    return merged


def brand_css(brand: dict) -> str:
    """Return CSS variable overrides for a configured brand."""
    lines = [":root {"]
    for key, var_names in CSS_VAR_MAP.items():
        value = brand["colors"].get(key)
        if value:
            for var_name in var_names:
                lines.append(f"  {var_name}: {value};")
    lines.append("}")
    return "\n".join(lines)


def client_brand(brand: dict) -> dict:
    """Return brand fields safe to embed in the frontend data payload."""
    return {
        "name": brand["name"],
        "accent": brand["colors"]["accent"],
        "background": brand["colors"]["background"],
        "palette": brand["palette"],
    }


def _image_data_uri(path: Path) -> str:
    mime = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
    }.get(path.suffix.lower())
    if not mime:
        raise ValueError(f"unsupported logo file type: {path.suffix}")
    try:
        data = base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError as exc:
        raise ValueError(f"could not read logo file {path}: {exc}") from exc
    return f"data:{mime};base64,{data}"


def _text_logo_uri(text: str, accent: str) -> str:
    safe_text = (text or "Brand").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='64' viewBox='0 0 180 64'>"
        f"<rect width='180' height='64' rx='6' fill='{accent}'/>"
        "<text x='18' y='40' fill='white' font-family='Inter, Arial, sans-serif' "
        "font-size='24' font-weight='700'>"
        f"{safe_text}</text></svg>"
    )
    return "data:image/svg+xml," + quote(svg)
