"""Version report: which API and which installed `orcha-cli` package this portal is.

GH #258 plan Part 11 PR 9 (I2). Under the native runtime the portal is the CLI's own package,
so `importlib.metadata` knows the installed version; inside the Docker portal image the CLI
package is not installed and `cli_version` is null. `api_version` is the FastAPI app version,
unchanged on both paths.
"""

from importlib import metadata

from pydantic import BaseModel

from portal_backend.application import app


class VersionResponse(BaseModel):
    api_version: str
    cli_version: str | None


def installed_cli_version() -> str | None:
    """The installed `orcha-cli` distribution version, or None when it isn't installed."""
    try:
        return metadata.version("orcha-cli")
    except metadata.PackageNotFoundError:
        return None


@app.get("/api/version", response_model=VersionResponse)
def version():
    """Report the API version and the installed CLI package version."""
    return VersionResponse(api_version=app.version, cli_version=installed_cli_version())
