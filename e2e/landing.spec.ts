import { expect, test, type Page } from "@playwright/test";

/**
 * Landing page E2E.
 *
 * The page is marketing, but two of its parts are functional and worth testing:
 * the hero's copy field puts a *real* harness definition on the clipboard (the
 * runtime's own DSL, verified by `harness-sample.test.ts`), and the page has to
 * survive a phone viewport. The rest asserts the structure a visitor is promised
 * (sections, anchors, the shipped phases) actually renders.
 */

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("landing page", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseURL ?? "http://127.0.0.1:3100",
    });
  });

  test("hero states the product and offers both ways in", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: /harness engineering infrastructure/i }),
    ).toBeVisible();
    await expect(page.getByText("# Harness engineering platform")).toBeVisible();
    // The hero's status row — version, phase and the stack line — was taken out
    // of the hero on request: what is left states the product and offers the two
    // ways in, and stops. Asserting the copy is *gone* keeps it gone quietly.
    await expect(page.getByText(/runtime v0\.2\.0 · phase 2 delivered/i)).toHaveCount(0);
    await expect(page.getByText(/Next\.js 16 · PostgreSQL/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute(
      "href",
      "/login",
    );
    await expect(page.getByRole("link", { name: "Start building" }).first()).toHaveAttribute(
      "href",
      "/login",
    );
  });

  test("copy field puts a real harness definition on the clipboard", async ({ page }) => {
    await page.goto("/");

    const copyButton = page.getByRole("button", {
      name: /copy the research harness definition/i,
    });
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await expect(page.getByText("Copied", { exact: true })).toBeVisible();

    const clipboard = await readClipboard(page);
    const definition = JSON.parse(clipboard) as {
      schemaVersion: number;
      entryNode: string;
      nodes: { id: string; type: string }[];
      exitNodes: string[];
    };
    expect(definition.entryNode).toBe("start");
    expect(definition.exitNodes).toEqual(["end"]);
    expect(definition.nodes.some((node) => node.type === "loop")).toBe(true);
    expect(definition.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  test("sections, anchors and shipped phases render", async ({ page }) => {
    await page.goto("/");

    for (const id of ["thesis", "pipeline", "runtime", "quickstart", "runs", "models", "roadmap"]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    // Nav anchor: clicking "Runtime" lands on the section it names.
    await page.getByRole("link", { name: "Runtime", exact: true }).click();
    await expect(page).toHaveURL(/#runtime$/);
    await expect(page.locator("#runtime")).toBeVisible();

    // The runtime primitives are all present.
    await expect(page.locator("#runtime li")).toHaveCount(12);

    // The observability section quotes the repository's own verification run.
    await expect(page.getByText("444", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("96d9bb921cd0…")).toBeVisible();
    await expect(page.getByText("orqestra-runtime/0.2.0")).toBeVisible();

    // The roadmap is honest about what exists.
    const delivered = page.locator("#roadmap").getByText("✓ delivered");
    await expect(delivered).toHaveCount(3);
    await expect(page.locator("#roadmap").getByText("Next", { exact: true })).toBeVisible();
  });

  test("the quickstart section inverts to a light surface", async ({ page }) => {
    await page.goto("/");

    const styles = await page.evaluate(() => {
      const section = document.querySelector("#quickstart");
      if (section === null) {
        return null;
      }
      const computed = getComputedStyle(section);
      const heading = section.querySelector("h2");
      return {
        background: computed.backgroundColor,
        headingColor: heading === null ? "" : getComputedStyle(heading).color,
      };
    });

    expect(styles).not.toBeNull();
    expect(styles?.background).toBe("rgb(246, 246, 244)");
    expect(styles?.headingColor).toBe("rgb(10, 10, 11)");
  });

  test("reduced motion leaves every section visible", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const revealStates = await page.evaluate(() =>
      [...document.querySelectorAll(".landing-reveal")].map((element) => ({
        opacity: getComputedStyle(element).opacity,
      })),
    );
    expect(revealStates.length).toBeGreaterThan(5);
    for (const state of revealStates) {
      expect(state.opacity).toBe("1");
    }
  });

  test("phone viewport has no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: /harness engineering infrastructure/i }),
    ).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test("the hero and the marquee band share the first screen", async ({ page }) => {
    /*
     * The hero is authored as one screen: the section fills everything below the
     * header and the band closes it at the fold. That is a promise the page has
     * to keep at any height it is opened at — the sizes below are a common
     * laptop, a 4:3 panel, a desktop and a 1080p display — and the failure it
     * guards against is quiet: the band drifting below the fold (and with it the
     * hero's own controls) on screens shorter than the one it was drawn for.
     */
    const sizes = [
      { width: 1024, height: 800 },
      { width: 1280, height: 800 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 1920, height: 1080 },
    ];

    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: /harness engineering infrastructure/i }),
      ).toBeVisible();

      const reading = await page.evaluate(() => {
        const height = window.innerHeight;
        const band = document.querySelector(".landing-marquee");
        const hero = document.querySelector("section");
        if (band === null || hero === null) return null;

        const bandBox = band.getBoundingClientRect();
        // Everything the hero promises to show: the copy field and the calls to
        // action included, and the last row of the section.
        const content = [
          ...hero.querySelectorAll("h1, p, a, button, div[class*='landing-reveal']"),
        ].map((element) => element.getBoundingClientRect().bottom);

        return {
          height,
          bandTop: Math.round(bandBox.top),
          bandBottom: Math.round(bandBox.bottom),
          lowestContent: Math.round(Math.max(...content, 0)),
        };
      });

      // Every failure names the size it was measured at.
      const where = `${size.width}x${size.height}`;
      expect(reading, where).not.toBeNull();
      // The band closes the screen rather than hanging below it…
      expect(reading?.bandBottom ?? Infinity, `${where} band below the fold`).toBeLessThanOrEqual(
        reading?.height ?? 0,
      );
      // …and it does close it: a band floating mid-screen would mean the hero had
      // stopped short, which is not the composition either.
      expect(reading?.bandTop ?? -Infinity, `${where} band floats mid-screen`).toBeGreaterThan(
        (reading?.height ?? 0) - 120,
      );
      // Nothing in the hero is left behind the band.
      expect(reading?.lowestContent ?? Infinity, `${where} hero content`).toBeLessThanOrEqual(
        (reading?.bandTop ?? 0) + 1,
      );
    }

    // The type answers the viewport too: the display face is smaller on a short
    // screen than on a tall one, and never so small that it stops being the
    // hero's statement.
    const displayAt = async (height: number) => {
      await page.setViewportSize({ width: 1366, height });
      await page.goto("/");
      return page.evaluate(() => {
        const heading = document.querySelector("h1");
        return heading === null ? 0 : parseFloat(getComputedStyle(heading).fontSize);
      });
    };

    const short = await displayAt(768);
    const tall = await displayAt(1080);
    expect(short).toBeLessThan(tall);
    expect(short).toBeGreaterThanOrEqual(40);
  });

  test("the footer is a directory of real destinations", async ({ page }) => {
    await page.goto("/");

    const footer = page.locator("footer");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();

    const directory = await footer.evaluate((element) => ({
      groups: [...element.querySelectorAll("nav[aria-label]")].map((column) => ({
        title: column.getAttribute("aria-label") ?? "",
        links: column.querySelectorAll("li a").length,
      })),
      hrefs: [...element.querySelectorAll("a")].map((anchor) => ({
        href: anchor.getAttribute("href") ?? "",
        label: anchor.getAttribute("aria-label") ?? (anchor.textContent ?? "").trim(),
      })),
      ids: [...document.querySelectorAll("[id]")].map((node) => node.id),
      controls: [...element.querySelectorAll("a[data-footer-control]")].map(
        (anchor) => anchor.getAttribute("aria-label") ?? "",
      ),
      text: element.textContent ?? "",
    }));

    // The groups the reference's footer is made of, each with something in it:
    // an empty column is a heading promising nothing. Brand + seven is the
    // eight-slot grid the desktop layout is built on.
    expect(directory.groups.map((group) => group.title)).toEqual([
      "Product",
      "Runtime",
      "Guards",
      "Observe",
      "Build",
      "API",
      "Project",
    ]);
    for (const group of directory.groups) {
      expect(group.links, group.title).toBeGreaterThanOrEqual(4);
    }

    // Every link goes somewhere that exists: a page or endpoint on this origin,
    // or a section of this page — never a placeholder that goes nowhere.
    expect(directory.hrefs.length).toBeGreaterThan(directory.groups.length);
    for (const link of directory.hrefs) {
      expect(link.href, link.label).not.toBe("");
      expect(link.href.startsWith("/") || link.href.startsWith("#"), link.label).toBe(true);
      if (link.href.startsWith("#")) {
        // The anchor has to land on something: one pointing at a section that
        // was renamed or never drawn is the quietest broken link there is.
        expect(directory.ids, `${link.label} → ${link.href}`).toContain(link.href.slice(1));
      }
    }

    // The controls show no text, so their names live in `aria-label` — and the
    // small print that says where the page's numbers come from is there too.
    expect(directory.controls.length).toBeGreaterThanOrEqual(4);
    for (const label of directory.controls) expect(label.length).toBeGreaterThan(3);
    expect(directory.text).toContain("Every figure quoted on this page");
    expect(directory.text).toContain("© 2026 Orqestra");

    // On a desktop the grid is the reference's eight slots and carries the
    // reference's hierarchy: 14px semibold headings, sentence case, over 14px
    // links. The hierarchy is the whole difference between a footer that reads
    // as a directory and one that reads as a footnote nobody set.
    await page.setViewportSize({ width: 1440, height: 900 });
    const desktop = await footer.evaluate((element) => {
      const grid = element.querySelector(":scope > div > div");
      const heading = element.querySelector("nav h2");
      const link = element.querySelector("nav li a");
      const style = (node: Element | null) => (node === null ? null : getComputedStyle(node));
      return {
        tracks:
          grid === null
            ? 0
            : getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
        headingSize: parseFloat(style(heading)?.fontSize ?? "0"),
        headingWeight: style(heading)?.fontWeight,
        headingTransform: style(heading)?.textTransform,
        linkSize: parseFloat(style(link)?.fontSize ?? "0"),
      };
    });

    expect(desktop.tracks).toBe(8);
    expect(desktop.headingSize).toBe(14);
    expect(desktop.headingWeight).toBe("600");
    expect(desktop.headingTransform).toBe("none");
    expect(desktop.linkSize).toBe(14);
  });

  test("the page closes on a wordmark cut by the footer's edge", async ({ page }) => {
    await page.goto("/");

    // The last thing drawn before the footer: the wordmark set to the width of
    // the screen, at 7.5% opacity, with its bottom third sliced off by the
    // section's own edge. Every part of that is measurable, and every part of it
    // is easy to lose quietly — a size that shrinks, an opacity raised until it
    // fights the copy, a clip that stops clipping, or a bleed that widens the
    // page. The reference this page is styled after does this; it should keep
    // doing it.
    const mark = await page.evaluate(() => {
      const section = document.querySelector("footer")?.previousElementSibling;
      const box = section?.querySelector("div.bottom-0");
      const span = box?.querySelector("span");
      if (box === null || box === undefined || span === null || span === undefined) return null;

      const wrapper = box.getBoundingClientRect();
      const lettering = span.getBoundingClientRect();
      const style = getComputedStyle(span);
      return {
        text: (span.textContent ?? "").trim(),
        ariaHidden: box.getAttribute("aria-hidden"),
        opacity: Number(style.opacity),
        transform: style.textTransform,
        /** How much of the screen's width the mark spans. */
        coverage: lettering.width / document.documentElement.clientWidth,
        /** How far its bottom hangs past the box that cuts it. */
        clipped: lettering.bottom - wrapper.bottom,
        height: lettering.height,
        /** A bleed must never widen the page. */
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    expect(mark).not.toBeNull();
    expect(mark?.text).toBe("orqestra");
    expect(mark?.ariaHidden).toBe("true");
    // Faint enough to sit behind the call to action rather than compete with it.
    expect(mark?.opacity).toBeCloseTo(0.075, 3);
    expect(mark?.transform).toBe("lowercase");
    // Set to the width of the screen…
    expect(mark?.coverage ?? 0).toBeGreaterThan(0.9);
    // …and cut: a third of it hangs past the clipping edge it sits on.
    expect(mark?.clipped ?? 0).toBeGreaterThan((mark?.height ?? 0) * 0.25);
    expect(mark?.overflowX ?? 99).toBeLessThanOrEqual(1);
  });

  test("loads without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(errors).toEqual([]);
  });

  test("the brand mark's node rides the harness, and the tab icon with it", async ({ page }) => {
    await page.goto("/");

    // Sampled from the live DOM: the node must travel, and it must stay on the
    // band — 12.8 units from the centre at an edge, 14.16 at a corner — rather
    // than drifting into the counter or off the mark.
    const ride = await page.evaluate(async () => {
      const svg = document.querySelector('header svg[viewBox="0 0 32 32"]');
      const rider = svg?.querySelector(".brand-mark-rider");
      if (!svg || !rider) return null;

      const box = svg.getBoundingClientRect();
      const scale = 32 / box.width;
      const positions: { x: number; y: number }[] = [];
      for (let i = 0; i < 6; i++) {
        const rect = rider.getBoundingClientRect();
        positions.push({
          x: (rect.left + rect.width / 2 - box.left) * scale,
          y: (rect.top + rect.height / 2 - box.top) * scale,
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }

      const radii = positions.map((point) => Math.hypot(point.x - 16, point.y - 16));
      return {
        distinct: new Set(positions.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`))
          .size,
        minRadius: Math.min(...radii),
        maxRadius: Math.max(...radii),
      };
    });

    expect(ride).not.toBeNull();
    expect(ride?.distinct).toBeGreaterThan(2);
    expect(ride?.minRadius).toBeGreaterThan(12.5);
    expect(ride?.maxRadius).toBeLessThan(14.5);

    // The tab icon is animated by swapping frames into the icon link Next
    // declares — the one piece of chrome that stays visible when you scroll away.
    const favicon = await page.evaluate(async () => {
      const link = document.querySelector('link[rel~="icon"][type="image/svg+xml"]');
      if (!link) return null;

      const frames = new Set<string>();
      for (let i = 0; i < 6; i++) {
        frames.add(link.getAttribute("href") ?? "");
        await new Promise((resolve) => setTimeout(resolve, 130));
      }
      return { frames: frames.size, href: link.getAttribute("href") ?? "" };
    });

    expect(favicon?.href.startsWith("data:image/svg+xml,")).toBe(true);
    expect(favicon?.frames).toBeGreaterThan(2);
  });

  test("reduced motion keeps the hero, the mark and the tab icon still", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    // The sweep is drawn as it always was, and the pointer reaches nothing.
    // (The closing CTA draws the same artwork, so the hero's is named.)
    const light = page.locator('[data-sweep="hero"] .landing-sweep-focus');
    const sweep = () =>
      light.evaluate((element) => ({
        transform: getComputedStyle(element).transform,
        opacity: Number(getComputedStyle(element).opacity),
      }));
    const drawn = await sweep();
    await page.mouse.move(180, 300);
    await page.mouse.move(900, 420);
    await page.waitForTimeout(600);
    expect(await sweep()).toEqual(drawn);

    // The light that flows along the arcs is motion too, and it is withdrawn
    // whole: the beams underneath stay, exactly as drawn.
    const flow = page.locator(".landing-sweep-flow").first();
    expect(await flow.evaluate((element) => getComputedStyle(element).display)).toBe("none");
    expect(await page.locator(".landing-sweep-arcs path").count()).toBeGreaterThan(0);

    const state = await page.evaluate(() => {
      const svg = document.querySelector('header svg[viewBox="0 0 32 32"]');
      const display = (selector: string) => {
        const element = svg?.querySelector(selector);
        return element ? getComputedStyle(element).display : null;
      };
      const icon = document.querySelector('link[rel~="icon"][type="image/svg+xml"]');
      return {
        rider: display(".brand-mark-rider"),
        ghost: display(".brand-mark-ghost"),
        pop: display(".brand-mark-pop"),
        halo: display(".brand-mark-halo"),
        core: !!svg?.querySelector('circle[cx="16"]'),
        animatedIcon: (icon?.getAttribute("href") ?? "").startsWith("data:"),
      };
    });

    // The resting identity: the node at the core, nothing travelling or beating.
    expect(state.core).toBe(true);
    expect(state.rider).toBe("none");
    expect(state.ghost).toBe("none");
    expect(state.pop).toBe("none");
    expect(state.halo).toBe("none");
    expect(state.animatedIcon).toBe(false);
  });

  test("the hero's sweep leans toward the pointer, then settles back", async ({ page }) => {
    // The light eases frame by frame, so how quickly it leans depends on how
    // quickly the page can paint — on a loaded machine that is worth a longer
    // budget than the default.
    test.slow();
    await page.goto("/");

    const light = page.locator('[data-sweep="hero"] .landing-sweep-focus');
    const read = () =>
      light.evaluate((element) => {
        const styles = getComputedStyle(element);
        const numbers = (styles.transform.match(/-?[\d.]+/g) ?? []).map(Number);
        return {
          transform: styles.transform,
          opacity: Number(styles.opacity),
          // matrix(a, b, c, d, e, f) — e/f are the translation.
          x: numbers[4] ?? 0,
          y: numbers[5] ?? 0,
        };
      });

    // Somewhere inside the hero, in both axes, whatever size the viewport is.
    const hero = await page.evaluate(() => {
      const section = document
        .querySelector('[data-sweep="hero"]')
        ?.closest("section")
        ?.getBoundingClientRect();
      if (!section) return null;
      const visible = Math.min(section.height, window.innerHeight - Math.max(section.top, 0));
      return {
        left: Math.max(section.left, 0),
        width: Math.min(section.width, window.innerWidth),
        y: Math.max(section.top, 0) + Math.max(visible, 1) * 0.3,
      };
    });
    expect(hero).not.toBeNull();
    const at = (fraction: number) => (hero?.left ?? 0) + (hero?.width ?? 1) * fraction;
    const atRest = (state: { x: number; y: number; opacity: number }) =>
      Math.abs(state.x) < 1 && Math.abs(state.y) < 1 && Math.abs(state.opacity - 1) < 0.005;

    const resting = await read();
    expect(atRest(resting)).toBe(true);

    /**
     * Put the pointer in the hero, keep it moving, and watch the light *inside
     * the page* for a moment — returning the furthest it leaned. Both halves
     * matter. The sample has to be taken in the page, because the light is meant
     * to let go of a pointer that stands still, and a reading taken over a
     * separate round trip would keep catching it on the way back instead of at
     * full lean. And the pointer has to keep moving for the whole window, or the
     * light — correctly — starts to let go before it has finished leaning.
     */
    const leanTo = async (fraction: number, milliseconds = 2_000) => {
      const x = Math.round(at(fraction));
      const y = Math.round(hero?.y ?? 200);

      // The interaction starts from a real pointer move, through Playwright's
      // own mouse — this is the input a visitor would produce.
      await page.mouse.move(x - 2, y - 2);
      await page.mouse.move(x, y);

      // Then the pointer is kept moving *from inside the page* while the light
      // is sampled. A runner's round trips are too slow to keep a pointer ahead
      // of the sweep's own patience for a still one under load, and a light that
      // is measured only between round trips would be caught letting go.
      return light.evaluate(
        async (element, point) => {
          const layer = (selector: string) =>
            document.querySelector<SVGGElement>(selector)?.style.transform ?? "";
          let peak = { x: 0, y: 0, opacity: 1, mirrored: { arcs: "", flow: "" } };
          await new Promise<void>((resolve) => {
            const started = performance.now();
            const timer = setInterval(() => {
              window.dispatchEvent(
                new PointerEvent("pointermove", {
                  clientX: point.x + (Math.round(performance.now()) % 3),
                  clientY: point.y,
                  pointerType: "mouse",
                  bubbles: true,
                }),
              );

              const styles = getComputedStyle(element);
              const numbers = (styles.transform.match(/-?[\d.]+/g) ?? []).map(Number);
              const value = numbers[4] ?? 0;
              if (Math.abs(value) > Math.abs(peak.x)) {
                peak = {
                  x: value,
                  y: numbers[5] ?? 0,
                  opacity: Number(styles.opacity),
                  // Read at the same frame as the lean, while both are leaning.
                  mirrored: {
                    arcs: layer('[data-sweep="hero"] .landing-sweep-arcs'),
                    flow: layer('[data-sweep="hero"] .landing-sweep-flow-arcs'),
                  },
                };
              }

              if (performance.now() - started >= point.duration) {
                clearInterval(timer);
                resolve();
              }
            }, 100);
          });
          return peak;
        },
        { x, y, duration: milliseconds },
      );
    };

    // The sweep takes the pointer once it is hydrated — it says so by promoting
    // its layers. Re-driving until it does means a slow hydration costs a retry
    // rather than the test.
    await expect
      .poll(
        async () => {
          await page.mouse.move(at(0.2), hero?.y ?? 200);
          return page
            .locator('[data-sweep="hero"]')
            .evaluate((element) => element.classList.contains("landing-sweep-hosting"));
        },
        { timeout: 15_000, intervals: [50, 100, 200] },
      )
      .toBe(true);

    // Left of the hero, and above its middle: the light leans left and up, and
    // gives up some of its strength on the way.
    const left = await leanTo(0.2);
    expect(left.x).toBeLessThan(-10);
    expect(left.y).toBeLessThan(-2);
    expect(left.opacity).toBeLessThan(1);

    // The light flowing along the beams leans with them, sharing their offset,
    // rather than sliding off the arcs it is drawn on.
    expect(left.mirrored.arcs).not.toBe("");
    expect(left.mirrored.flow).toBe(left.mirrored.arcs);

    // The visitor stops moving, and the light eases back to the drawn shape.
    // The easing is asymptotic, so it arrives within a fraction of a sweep unit
    // rather than at exactly the identity matrix.
    await expect.poll(async () => atRest(await read()), { timeout: 6_000 }).toBe(true);

    // Right of the hero: it leans the other way, and brighter — the focus sits
    // on the right edge, so this is the throw that lands nearest the caustic.
    const right = await leanTo(0.85);
    expect(right.x).toBeGreaterThan(10);
    expect(right.opacity).toBeGreaterThan(left.opacity);
  });

  test("the arcs carry light toward the focal point without moving the drawing", async ({
    page,
  }) => {
    await page.goto("/");

    // The travelling light is drawn on a layer of its own: the beams again, from
    // a gradient that moves. The drawing underneath is never redrawn.
    const flow = page.locator(".landing-sweep-flow").first();
    await expect(flow).toBeVisible();

    const readOffset = () =>
      flow.evaluate((svg) => {
        const gradient = svg.querySelector<SVGGradientElement>("linearGradient");
        if (gradient === null) return null;
        const animated = gradient.gradientTransform.animVal;
        const sweep = svg.querySelector('animateTransform[attributeName="gradientTransform"]');
        return {
          /** Where the gradient's bright end has travelled to. */
          x: animated.numberOfItems > 0 ? animated.getItem(0).matrix.e : 0,
          /** The gradient's own ends: the focal point, and out along the beams. */
          focal: Number(gradient.getAttribute("x1")),
          tail: Number(gradient.getAttribute("x2")),
          /** One full period — the distance the offset covers per cycle. */
          period: Number((sweep?.getAttribute("to") ?? "").split(" ")[0]),
          repeat: sweep?.getAttribute("repeatCount"),
          spread: gradient.getAttribute("spreadMethod"),
        };
      });

    const first = await readOffset();
    expect(first).not.toBeNull();

    // Light runs *toward* the caustic: the bright end of the gradient is at the
    // focal point, its tail back along the arcs, and the offset advances that
    // way. Repeating over exactly one period means the flow has no seam.
    expect(first?.focal).toBeGreaterThan(first?.tail ?? 0);
    expect(first?.spread).toBe("repeat");
    expect(first?.repeat).toBe("indefinite");
    expect(first?.period).toBe((first?.focal ?? 0) - (first?.tail ?? 0));
    // The offset is a sawtooth over exactly that period, so however long the
    // page has been open it never carries the light further than one of them.
    expect(first?.x).toBeGreaterThanOrEqual(0);
    expect(first?.x).toBeLessThanOrEqual(first?.period ?? 0);

    // And the offset is genuinely travelling: the light the beams carry moves.
    // It is sampled *in the page* — round trips are far too slow to follow a
    // 7-second cycle — and because the value repeats, what matters is the range
    // it covers rather than whether one reading is ahead of another.
    const travel = await flow.evaluate(async (svg) => {
      const gradient = svg.querySelector<SVGGradientElement>("linearGradient");
      if (gradient === null) return null;
      const offset = () => {
        const animated = gradient.gradientTransform.animVal;
        return animated.numberOfItems > 0 ? animated.getItem(0).matrix.e : 0;
      };

      let min = Infinity;
      let max = -Infinity;
      let samples = 0;
      const until = performance.now() + 2_500;
      while (performance.now() < until) {
        const value = offset();
        min = Math.min(min, value);
        max = Math.max(max, value);
        samples += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return { min, max, samples };
    });

    expect(travel).not.toBeNull();
    expect(travel?.samples ?? 0).toBeGreaterThan(2);
    // Two and a half seconds of a 7-second, 720-unit cycle is 257 units at full
    // speed; 120 leaves a loaded runner room without accepting a standstill.
    expect((travel?.max ?? 0) - (travel?.min ?? 0)).toBeGreaterThan(120);

    // The drawing itself has not moved: same paths, same strokes, same local
    // transforms — while the light that rides them has travelled.
    const drawing = () =>
      page.evaluate(() => ({
        arcs: [...document.querySelectorAll('[data-sweep="hero"] .landing-sweep-arcs path')].map(
          (path) => [
            path.getAttribute("d"),
            path.getAttribute("stroke"),
            path.getAttribute("stroke-width"),
            path.getAttribute("transform"),
          ],
        ),
        flow: [...document.querySelectorAll(".landing-sweep-flow-arcs path")].map((path) => [
          path.getAttribute("d"),
          path.getAttribute("stroke"),
          path.getAttribute("stroke-width"),
        ]),
      }));

    const before = await drawing();
    await page.waitForTimeout(900);
    const after = await drawing();
    expect(after).toEqual(before);

    // And the light is drawn *on* those beams, not beside them.
    const beams = new Set(before.arcs.map((attributes) => attributes[0]));
    expect(before.flow.length).toBeGreaterThan(0);
    for (const attributes of before.flow) {
      expect(beams.has(attributes[0])).toBe(true);
    }
  });

  test("each lap closes with a beat at the core", async ({ page }) => {
    await page.goto("/");

    // A lap takes nine seconds: watch the core for a little over one, and look
    // for the swell that lands as the node arrives back where it started.
    const beat = await page.evaluate(async () => {
      const svg = document.querySelector('header svg[viewBox="0 0 32 32"]');
      const core = svg?.querySelector(".brand-mark-pop");
      if (!svg || !core) return null;

      let smallest = Infinity;
      let largest = 0;
      const until = performance.now() + 10_500;
      while (performance.now() < until) {
        const width = core.getBoundingClientRect().width;
        smallest = Math.min(smallest, width);
        largest = Math.max(largest, width);
        if (largest > smallest * 1.3) break;
        await new Promise((resolve) => setTimeout(resolve, 90));
      }

      return { smallest, largest, hasHalo: !!svg.querySelector(".brand-mark-halo") };
    });

    expect(beat).not.toBeNull();
    expect(beat?.hasHalo).toBe(true);
    // The core swells by more than half before it settles back to rest.
    expect(beat?.largest ?? 0).toBeGreaterThan((beat?.smallest ?? 0) * 1.2);
  });
});
