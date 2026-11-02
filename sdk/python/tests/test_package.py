"""Package metadata acceptance, independent of importing an installed wheel."""

import tomllib
from pathlib import Path

import krun._runtime as runtime


def test_dependency_free_build_metadata() -> None:
    path = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with path.open("rb") as source:
        metadata = tomllib.load(source)
    assert metadata["project"]["name"] == "krun"
    assert metadata["project"]["requires-python"] == ">=3.11"
    assert metadata["project"]["dependencies"] == []
    assert metadata["project"]["version"] == runtime._VERSION
    assert metadata["build-system"]["requires"] == ["uv_build==0.13.1"]
    assert metadata["build-system"]["build-backend"] == "uv_build"
    assert metadata["tool"]["uv"]["build-backend"]["module-root"] == ""
    assert (path.parent / "krun" / "py.typed").is_file()
