import { useEffect, useRef } from "react";
import { useResolvedTheme } from "./theme.ts";

// A slowly turning spiral of stars that drift away from the cursor and settle back. One canvas, no dependencies.
// It draws a single still frame for people who ask for reduced motion, and stops while the tab is hidden.

type Star = { radius: number; angle: number; depth: number; size: number; color: string; phase: number; bright: boolean; x: number; y: number; vx: number; vy: number };
type Glow = { x: number; y: number; radius: number; color: string; drift: number };

const SKY = {
  dark: {
    stars: ["#dfe7f5", "#a9c1ea", "#8fb0e6", "#c8d6ee"],
    dust: ["#e8a15c", "#d98a45"],
    glow: "rgba(160,190,235,0.028)",
    core: ["rgba(205,220,255,0.3)", "rgba(130,160,235,0.1)", "rgba(90,120,210,0)"],
    strength: 1,
  },
  // White stars vanish on a pale page, so here they're the logo's blue and teal, and softer, so they never compete with the text.
  light: {
    stars: ["#2f5bea", "#5b7ff0", "#11a39c", "#7d93d8"],
    dust: ["#d98a45", "#c27803"],
    glow: "rgba(47,91,234,0.035)",
    core: ["rgba(47,91,234,0.14)", "rgba(17,163,156,0.06)", "rgba(47,91,234,0)"],
    strength: 0.6,
  },
};
const ARMS = 3;
const PUSH_RADIUS = 170;

const gaussian = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function makeStars(count: number, reach: number, sky: (typeof SKY)["dark"]): Star[] {
  return Array.from({ length: count }, (_, i) => {
    const depth = Math.pow(Math.random(), 1.25);
    const dust = Math.random() < 0.16 && depth > 0.18 && depth < 0.6;
    const arm = (i % ARMS) * ((Math.PI * 2) / ARMS);
    return {
      radius: (0.02 + depth) * reach * (1 + gaussian() * 0.06),
      angle: arm + depth * 5.2 + gaussian() * (0.42 - depth * 0.14),
      depth,
      size: Math.random() < 0.06 ? 2.4 : Math.random() < 0.35 ? 1.7 : 1.2,
      color: dust ? sky.dust[i % sky.dust.length] : sky.stars[i % sky.stars.length],
      phase: Math.random() * Math.PI * 2,
      bright: Math.random() < 0.05,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    };
  });
}

export function Galaxy() {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const sky = SKY[theme];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0, height = 0, centerX = 0, centerY = 0;
    let stars: Star[] = [];
    let glows: Glow[] = [];
    let core: CanvasGradient | null = null;
    let turn = 0;
    let last = 0;
    let raf = 0;
    const pointer = { x: -9999, y: -9999, active: false };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const narrow = width < 860;
      centerX = narrow ? width * 0.5 : width * 0.66;
      centerY = narrow ? height * 0.34 : height * 0.46;
      const reach = narrow ? width * 0.95 : width * 0.46;
      stars = makeStars(Math.min(2600, Math.floor((width * height) / 480)), reach, sky);
      glows = Array.from({ length: narrow ? 3 : 6 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 8 + Math.random() * 14,
        color: sky.glow,
        drift: 0.004 + Math.random() * 0.008,
      }));
      core = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, reach * 0.42);
      core.addColorStop(0, sky.core[0]);
      core.addColorStop(0.28, sky.core[1]);
      core.addColorStop(1, sky.core[2]);
    };

    const draw = (time: number) => {
      const dt = Math.min(time - last, 50);
      last = time;
      ctx.clearRect(0, 0, width, height);
      turn += dt * 0.00005;

      if (core) {
        // The bright centre, squashed to the same tilt as the spiral.
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.scale(1, 0.48);
        ctx.translate(-centerX, -centerY);
        ctx.fillStyle = core;
        ctx.fillRect(0, centerY - height * 1.5, width, height * 3);
        ctx.restore();
      }

      for (const g of glows) {
        const y = (g.y - time * g.drift * 0.1 + height * 4) % height;
        ctx.fillStyle = g.color;
        ctx.beginPath();
        ctx.arc(g.x, y, g.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const s of stars) {
        // Inner stars turn faster, which keeps the spiral looking alive.
        const a = s.angle + turn * (2.2 - s.depth * 1.4);
        const homeX = centerX + Math.cos(a) * s.radius;
        const homeY = centerY + Math.sin(a) * s.radius * 0.48;

        if (pointer.active) {
          const dx = homeX + s.x - pointer.x;
          const dy = homeY + s.y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance < PUSH_RADIUS && distance > 0.01) {
            // Pushed outward, with a sideways part so stars swirl around the cursor.
            const force = ((PUSH_RADIUS - distance) / PUSH_RADIUS) * 0.55;
            s.vx += (dx / distance) * force - (dy / distance) * force * 0.45;
            s.vy += (dy / distance) * force + (dx / distance) * force * 0.45;
          }
        }
        s.vx = (s.vx - s.x * 0.012) * 0.9;
        s.vy = (s.vy - s.y * 0.012) * 0.9;
        s.x += s.vx;
        s.y += s.vy;

        const x = homeX + s.x;
        const y = homeY + s.y;
        if (x < -4 || y < -4 || x > width + 4 || y > height + 4) continue;
        const twinkle = 0.72 + 0.28 * Math.sin(time * 0.0012 + s.phase);
        const fade = 1 - s.depth * 0.5;
        ctx.globalAlpha = Math.max(0.3, fade * twinkle) * sky.strength;
        ctx.fillStyle = s.color;
        ctx.fillRect(x, y, s.size, s.size);
        if (s.bright) {
          ctx.globalAlpha = 0.22 * twinkle * sky.strength;
          ctx.beginPath();
          ctx.arc(x + s.size / 2, y + s.size / 2, 3.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = (time: number) => {
      draw(time);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
    };
    const onLeave = () => {
      pointer.active = false;
    };
    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!reduced) start();
    };
    const onResize = () => {
      resize();
      if (reduced) draw(performance.now());
    };

    resize();
    if (reduced) draw(performance.now());
    else start();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    if (!reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onLeave);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [theme]);

  return <canvas ref={ref} className="galaxy" aria-hidden="true" />;
}
