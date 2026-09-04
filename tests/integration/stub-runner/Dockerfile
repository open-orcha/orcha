# tests/integration/stub-runner/Dockerfile — fake runtime for lifecycle tests
FROM alpine:3.20
RUN printf '#!/bin/sh\necho "{\\"type\\":\\"result\\",\\"result\\":\\"stub done\\"}"\nsleep "${STUB_SLEEP:-0}"\n' \
      > /usr/local/bin/claude && chmod +x /usr/local/bin/claude
# No baked WORKDIR: the spawner mounts the workspace path-identically and
# always passes -w <real spawn cwd> (mirrors templates/runner/Dockerfile).
