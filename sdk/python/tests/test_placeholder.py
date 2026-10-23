"""Acceptance for the SDK package skeleton, not its future run contract."""

import krun


def test_placeholder_package_is_importable() -> None:
    assert (
        krun.__doc__ == "krun function SDK package; runtime implementation is pending."
    )
    assert not hasattr(krun, "run")
