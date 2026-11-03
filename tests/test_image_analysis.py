import base64
import io

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image

from app import main


def encoded_image(size: tuple[int, int], format_name: str) -> bytes:
    image = Image.new("RGB", size, "#ffffff")
    stream = io.BytesIO()
    image.save(stream, format=format_name)
    return stream.getvalue()


def test_load_image_preserves_original_and_uses_browser_normalized_copy(tmp_path, monkeypatch) -> None:
    original = encoded_image((640, 400), "PNG")
    normalized = encoded_image((640, 400), "JPEG")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)
    preparation = {
        "mode": "browser_canvas",
        "source_width": 640,
        "source_height": 400,
        "normalized_width": 640,
        "normalized_height": 400,
        "blur_risk": "not_obvious",
        "glare_risk": "visual_stage_assessment",
    }

    filename, inference, metadata = main._load_image(
        UploadFile(filename="chart.png", file=io.BytesIO(original)),
        original,
        normalized,
        preparation,
    )

    assert (tmp_path / filename).read_bytes() == original
    assert base64.b64decode(inference["base64"]) == normalized
    assert metadata["mode"] == "browser_canvas"
    assert metadata["source_width"] == 640
    assert metadata["normalized_width"] == 640
    assert metadata["blur_risk"] == "not_obvious"


def test_load_image_rejects_normalized_images_with_stretched_dimensions(tmp_path, monkeypatch) -> None:
    original = encoded_image((640, 400), "PNG")
    normalized = encoded_image((640, 500), "JPEG")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)
    preparation = {
        "mode": "browser_canvas",
        "source_width": 640,
        "source_height": 400,
        "normalized_width": 640,
        "normalized_height": 500,
    }

    with pytest.raises(HTTPException, match="aspect ratio changed"):
        main._load_image(
            UploadFile(filename="chart.png", file=io.BytesIO(original)),
            original,
            normalized,
            preparation,
        )


def test_load_image_keeps_legacy_api_usable_but_marks_fallback_unprepared(tmp_path, monkeypatch) -> None:
    original = encoded_image((640, 400), "PNG")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)

    _, inference, metadata = main._load_image(
        UploadFile(filename="chart.png", file=io.BytesIO(original)),
        original,
    )

    assert inference["mime_type"] == "image/jpeg"
    assert metadata["mode"] == "server_fallback"
    assert "Browser-normalized" in metadata["warnings"][0]
