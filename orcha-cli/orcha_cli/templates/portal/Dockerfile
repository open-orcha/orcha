FROM python:3.12-slim
WORKDIR /app
# Local-or-GitHub code source (Addendum 2): the `git` binary itself, for the
# portal_backend.local_git wrapper (`git -C $ORCHA_LOCAL_REPO_DIR ...`) that serves
# the "local" repo-binding sentinel. --no-install-recommends + apt list cleanup keeps
# the image lean (no extra build tooling, no lingering apt cache layer).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# --proxy-headers: behind the cloud reverse proxy (Caddy), honor
# X-Forwarded-Proto/Host so generated URLs (pairing QR!) say https — Foundation
# strips Authorization on http->https redirects, so an http QR breaks iOS auth.
# forwarded-allow-ips "*" is safe: the portal port is loopback/compose-bound.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
