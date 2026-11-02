const REGION_HOSTS = Object.freeze({
  "us-west": "console.us-west.spatius.ai",
  "ap-northeast": "console.ap-northeast.spatius.ai",
  "cn-beijing": "console.cn-beijing.spatialwalk.top",
});

function extractSessionToken(payload) {
  const body = payload?.data ?? payload;
  return body?.sessionToken ?? body?.sessionKey ?? body?.token ?? null;
}

export async function issueSpatiusSessionToken({
  appId,
  apiKey,
  region = "ap-northeast",
  ttlSeconds = 15 * 60,
  fetchImpl = globalThis.fetch,
}) {
  if (!appId || !apiKey) {
    throw new Error("Spatius server credentials are not configured.");
  }

  const host = REGION_HOSTS[region];
  if (!host) throw new Error(`Unsupported Spatius region: ${region}`);

  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(ttlSeconds, 60), 23 * 60 * 60);
  const response = await fetchImpl(`https://${host}/v1/console/session-tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({ appId, expireAt: expiresAt }),
  });

  if (!response.ok) {
    throw new Error(`Spatius Session Token request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const sessionToken = extractSessionToken(payload);
  if (!sessionToken) throw new Error("Spatius returned a response without a Session Token.");

  return { sessionToken, expiresAt };
}
