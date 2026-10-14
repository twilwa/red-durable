/** Bound untrusted facet output and wall time; do not give it supervisor bindings. */
export async function facetJson(
  facet: Fetcher,
  path: string,
  input?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const response = await facet.fetch("https://facet.internal" + path, {
      method: input === undefined ? "GET" : "POST",
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Facet returned ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty facet response");
    let text = "",
      size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16000) throw new Error("Facet response exceeds 16KB");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
    }
    return JSON.parse(text);
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Facet timed out"));
        }, 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
