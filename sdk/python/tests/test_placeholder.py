"""Public package imports expose the runtime without executing a handler."""

import krun


def test_package_exports() -> None:
    assert krun.__all__ == ["Context", "Handler", "run"]
    assert callable(krun.run)
