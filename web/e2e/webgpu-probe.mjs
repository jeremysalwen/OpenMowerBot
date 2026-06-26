// Probe whether the installed Edge/Chrome can provide real WebGPU under
// Playwright automation, including the `shader-f16` feature that the q4f16
// WebLLM models require. Run: `node web/e2e/webgpu-probe.mjs`
import { chromium } from "playwright-core";

const channel = process.env.E2E_CHANNEL || "msedge";

// Several flag combinations; report which (if any) exposes navigator.gpu.
const attempts = [
  {
    name: "unsafe-webgpu+vulkan",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
    ignoreDefaultArgs: ["--disable-gpu"],
  },
  {
    name: "swiftshader-fallback",
    args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    ignoreDefaultArgs: ["--disable-gpu"],
  },
  {
    name: "explicit-webgpu-feature",
    args: ["--enable-features=WebGPU,Vulkan", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--no-sandbox"],
    ignoreDefaultArgs: ["--disable-gpu", "--disable-software-rasterizer"],
  },
];

for (const headless of [false]) {
  for (const attempt of attempts) {
    const browser = await chromium.launch({ channel, headless, args: attempt.args, ignoreDefaultArgs: attempt.ignoreDefaultArgs });
    const page = await browser.newPage();
    const info = await page.evaluate(async () => {
      const out = { hasGpuProp: "gpu" in navigator, gpuType: typeof navigator.gpu };
      if (!navigator.gpu) return out;
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          const fb = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
          out.adapter = false;
          out.fallbackAdapter = Boolean(fb);
          return out;
        }
        const i = adapter.info || {};
        out.adapter = true;
        out.shaderF16 = adapter.features.has("shader-f16");
        out.vendor = i.vendor;
        out.architecture = i.architecture;
        out.description = i.description;
      } catch (e) {
        out.error = String(e);
      }
      return out;
    });
    console.log(`[${attempt.name}] headless=${headless}:`, JSON.stringify(info));
    await browser.close();
  }
}
