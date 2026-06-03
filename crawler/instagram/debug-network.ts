/**
 * Debug script: navigate to ONE reel and log every JSON response from
 * instagram.com so we can identify which URL carries the media metadata.
 */
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const COOKIE_FILE = resolve(process.cwd(), "data/instagram/cookie.json");
const DEBUG_OUT = resolve(process.cwd(), "data/instagram/debug_network.json");

// Change this to any reel ID you want to probe
const TEST_SHORTCODE = "DZFjBeEOpad";

interface Hit {
    url: string;
    status: number;
    contentType: string;
    bodySnippet: string; // first 600 chars
    hasShortcode: boolean;
    hasTakenAt: boolean;
    hasLikeCount: boolean;
    hasPlayCount: boolean;
}

async function main() {
    if (!existsSync(COOKIE_FILE)) {
        throw new Error(`Cookie file not found: ${COOKIE_FILE}`);
    }

    const cookies = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));

    const ctx = await chromium.launchPersistentContext(
        resolve(process.cwd(), "data/user_data_ig_debug"),
        {
            headless: false,
            args: ["--no-sandbox"],
            locale: "en-US",
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/125.0.0.0 Safari/537.36",
        },
    );

    await ctx.addCookies(
        cookies
            .filter((c: any) => c.domain.includes("instagram.com"))
            .map((c: any) => ({
                ...c,
                sameSite: (["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax") as any,
            })),
    );

    const page = await ctx.newPage();
    const hits: Hit[] = [];

    page.on("response", async (res) => {
        const url = res.url();
        if (!url.includes("instagram.com")) return;

        const ct = res.headers()["content-type"] ?? "";
        if (!ct.includes("json") && !ct.includes("javascript")) return;

        let body = "";
        try {
            body = await res.text();
        } catch {
            return;
        }

        const hit: Hit = {
            url,
            status: res.status(),
            contentType: ct,
            bodySnippet: body.slice(0, 600),
            hasShortcode: body.includes(TEST_SHORTCODE),
            hasTakenAt: body.includes("taken_at"),
            hasLikeCount: body.includes("like_count"),
            hasPlayCount: body.includes("play_count"),
        };

        hits.push(hit);

        const flags = [
            hit.hasShortcode && "shortcode",
            hit.hasTakenAt && "taken_at",
            hit.hasLikeCount && "like_count",
            hit.hasPlayCount && "play_count",
        ].filter(Boolean).join("+");

        console.log(`[${res.status()}] ${url.slice(0, 120)}`);
        if (flags) console.log(`    >>> FIELDS: ${flags}`);
    });

    console.log(`\nNavigating to reel: ${TEST_SHORTCODE}...`);
    await page.goto(`https://www.instagram.com/reel/${TEST_SHORTCODE}/`, {
        waitUntil: "networkidle",
        timeout: 30_000,
    });

    // Wait a bit more for deferred XHR
    await new Promise(r => setTimeout(r, 3000));

    writeFileSync(DEBUG_OUT, JSON.stringify(hits, null, 2), "utf8");
    console.log(`\n--- Summary: ${hits.length} total JSON responses ---`);

    const relevant = hits.filter(
        (h) => h.hasShortcode || h.hasTakenAt || h.hasLikeCount || h.hasPlayCount,
    );
    console.log(`Relevant hits (contain media fields): ${relevant.length}`);
    for (const h of relevant) {
        console.log(`\n  URL: ${h.url}`);
        console.log(`  Flags: shortcode=${h.hasShortcode} taken_at=${h.hasTakenAt} like_count=${h.hasLikeCount} play_count=${h.hasPlayCount}`);
        console.log(`  Body snippet: ${h.bodySnippet.slice(0, 200)}`);
    }

    console.log(`\nFull dump saved to: ${DEBUG_OUT}`);
    await ctx.close();
}

main().catch(console.error);
