#!/usr/bin/env node
// index-paid.js — Payment-gated entry point for Bright Data MCP
//
// Drop-in replacement for server.js that adds agent-native pay-per-call billing
// via Tomopay. Agents pay in USDC (x402) or via Stripe MPP before each tool call.
// The original server.js is completely untouched — this is purely additive.
//
// Usage:
//   TOMOPAY_ADDRESS=0x... API_TOKEN=<brightdata-token> node index-paid.js
//
// Pricing tiers (operator markup over Bright Data wholesale $0.001–$0.01/req):
//   - scraping/search/browser tools:  $0.10 – $0.50/call
//   - structured web data (datasets): $0.20/call
//   - read/lookup (session_stats):    $0.05/call

"use strict"; /*jslint node:true es9:true*/
import {FastMCP} from "fastmcp";
import {withPayments} from "@tomopay/gateway";
import {z} from "zod";
import axios from "axios";
import {tools as browser_tools} from "./browser_tools.js";
import prompts from "./prompts.js";
import {GROUPS} from "./tool_groups.js";
import {createRequire} from "node:module";
import {remark} from "remark";
import strip from "strip-markdown";

const require = createRequire(import.meta.url);
const package_json = require("./package.json");

// ── env ──────────────────────────────────────────────────────────────────────
const api_token = process.env.API_TOKEN;
const tomopay_address = process.env.TOMOPAY_ADDRESS;
const unlocker_zone = process.env.WEB_UNLOCKER_ZONE || "mcp_unlocker";
const browser_zone = process.env.BROWSER_ZONE || "mcp_browser";
const pro_mode = process.env.PRO_MODE === "true";
const polling_timeout = parseInt(process.env.POLLING_TIMEOUT || "600", 10);
const base_timeout = process.env.BASE_TIMEOUT
    ? parseInt(process.env.BASE_TIMEOUT, 10) * 1000 : 0;
const base_max_retries = Math.min(
    parseInt(process.env.BASE_MAX_RETRIES || "0", 10), 3);
const tool_groups = process.env.GROUPS
    ? process.env.GROUPS.split(",").map(g => g.trim().toLowerCase()).filter(Boolean)
    : [];
const custom_tools = process.env.TOOLS
    ? process.env.TOOLS.split(",").map(t => t.trim()).filter(Boolean)
    : [];

if (!api_token)
    throw new Error("Cannot run MCP server without API_TOKEN env");
if (!tomopay_address)
    throw new Error("Cannot run payment-gated server without TOMOPAY_ADDRESS env");

// ── pricing ───────────────────────────────────────────────────────────────────
// Amounts in USD cents (1 = $0.01). Settled in USDC on Base (x402) or Stripe MPP.
// Bright Data wholesale: $0.001–$0.01/req — operator margin built in here.
const PRICING = {
    // Scraping & search
    search_engine:                      { amount: 10, currency: "USD" },  // $0.10
    search_engine_batch:                { amount: 40, currency: "USD" },  // $0.40
    scrape_as_markdown:                 { amount: 10, currency: "USD" },  // $0.10
    scrape_as_html:                     { amount: 10, currency: "USD" },  // $0.10
    scrape_batch:                       { amount: 40, currency: "USD" },  // $0.40
    extract:                            { amount: 15, currency: "USD" },  // $0.15

    // Browser automation (Scraping Browser — premium tier)
    scraping_browser_navigate:          { amount: 50, currency: "USD" },  // $0.50
    scraping_browser_go_back:           { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_go_forward:        { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_snapshot:          { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_fill_form:         { amount: 20, currency: "USD" },  // $0.20
    scraping_browser_click_ref:         { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_type_ref:          { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_screenshot:        { amount: 20, currency: "USD" },  // $0.20
    scraping_browser_network_requests:  { amount: 15, currency: "USD" },  // $0.15
    scraping_browser_wait_for_ref:      { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_get_text:          { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_get_html:          { amount: 10, currency: "USD" },  // $0.10
    scraping_browser_scroll:            { amount:  5, currency: "USD" },  // $0.05
    scraping_browser_scroll_to_ref:     { amount:  5, currency: "USD" },  // $0.05

    // Structured web data — dataset lookups ($0.20/call)
    web_data_amazon_product:            { amount: 20, currency: "USD" },
    web_data_amazon_product_reviews:    { amount: 20, currency: "USD" },
    web_data_amazon_product_search:     { amount: 20, currency: "USD" },
    web_data_walmart_product:           { amount: 20, currency: "USD" },
    web_data_walmart_seller:            { amount: 20, currency: "USD" },
    web_data_ebay_product:              { amount: 20, currency: "USD" },
    web_data_homedepot_products:        { amount: 20, currency: "USD" },
    web_data_zara_products:             { amount: 20, currency: "USD" },
    web_data_etsy_products:             { amount: 20, currency: "USD" },
    web_data_bestbuy_products:          { amount: 20, currency: "USD" },
    web_data_google_shopping:           { amount: 20, currency: "USD" },
    web_data_linkedin_person_profile:   { amount: 20, currency: "USD" },
    web_data_linkedin_company_profile:  { amount: 20, currency: "USD" },
    web_data_linkedin_job_listings:     { amount: 20, currency: "USD" },
    web_data_linkedin_posts:            { amount: 20, currency: "USD" },
    web_data_linkedin_people_search:    { amount: 20, currency: "USD" },
    web_data_instagram_profiles:        { amount: 20, currency: "USD" },
    web_data_instagram_posts:           { amount: 20, currency: "USD" },
    web_data_instagram_reels:           { amount: 20, currency: "USD" },
    web_data_instagram_comments:        { amount: 20, currency: "USD" },
    web_data_facebook_posts:            { amount: 20, currency: "USD" },
    web_data_facebook_marketplace_listings: { amount: 20, currency: "USD" },
    web_data_facebook_company_reviews:  { amount: 20, currency: "USD" },
    web_data_facebook_events:           { amount: 20, currency: "USD" },
    web_data_tiktok_profiles:           { amount: 20, currency: "USD" },
    web_data_tiktok_posts:              { amount: 20, currency: "USD" },
    web_data_tiktok_shop:               { amount: 20, currency: "USD" },
    web_data_tiktok_comments:           { amount: 20, currency: "USD" },
    web_data_x_posts:                   { amount: 20, currency: "USD" },
    web_data_x_profile_posts:           { amount: 20, currency: "USD" },
    web_data_youtube_profiles:          { amount: 20, currency: "USD" },
    web_data_youtube_comments:          { amount: 20, currency: "USD" },
    web_data_youtube_videos:            { amount: 20, currency: "USD" },
    web_data_reddit_posts:              { amount: 20, currency: "USD" },
    web_data_yahoo_finance_business:    { amount: 20, currency: "USD" },
    web_data_crunchbase_company:        { amount: 20, currency: "USD" },
    web_data_zoominfo_company_profile:  { amount: 20, currency: "USD" },
    web_data_google_maps_reviews:       { amount: 20, currency: "USD" },
    web_data_zillow_properties_listing: { amount: 20, currency: "USD" },
    web_data_booking_hotel_listings:    { amount: 20, currency: "USD" },
    web_data_github_repository_file:    { amount: 20, currency: "USD" },
    web_data_reuter_news:               { amount: 20, currency: "USD" },
    web_data_google_play_store:         { amount: 20, currency: "USD" },
    web_data_apple_app_store:           { amount: 20, currency: "USD" },
    web_data_npm_package:               { amount: 20, currency: "USD" },
    web_data_pypi_package:              { amount: 20, currency: "USD" },
    web_data_chatgpt_ai_insights:       { amount: 20, currency: "USD" },
    web_data_grok_ai_insights:          { amount: 20, currency: "USD" },
    web_data_perplexity_ai_insights:    { amount: 20, currency: "USD" },

    // Read / lookup
    session_stats:                      { amount:  5, currency: "USD" },  // $0.05
};

// ── server setup ──────────────────────────────────────────────────────────────
// Mirror the exact server construction from server.js so tools register
// identically — then wrap with withPayments() BEFORE calling start().

function build_allowed_tools(groups = [], tools = []) {
    const allowed = new Set();
    for (const group_id of groups) {
        const group = Object.values(GROUPS).find(g => g.id === group_id);
        if (group)
            group.tools.forEach(t => allowed.add(t));
    }
    tools.forEach(t => allowed.add(t));
    return allowed;
}

const pro_mode_tools = ["search_engine", "scrape_as_markdown",
    "search_engine_batch", "scrape_batch"];
const allowed_tools = build_allowed_tools(tool_groups, custom_tools);

let server = new FastMCP({
    name: "Bright Data",
    version: package_json.version,
});

// Intercept addTool to honour pro_mode / group filtering (same as server.js)
const addTool = (tool) => {
    if (pro_mode) { server.addTool(tool); return; }
    if (allowed_tools.size > 0) {
        if (allowed_tools.has(tool.name)) server.addTool(tool);
        return;
    }
    if (pro_mode_tools.includes(tool.name)) server.addTool(tool);
};

// ── Bright Data API helpers ───────────────────────────────────────────────────
const api_headers = (clientName = null, tool_name = null) => ({
    "user-agent": `${package_json.name}/${package_json.version}`,
    authorization: `Bearer ${api_token}`,
    ...clientName ? { "x-mcp-client-name": clientName } : {},
    ...tool_name ? { "x-mcp-tool": tool_name } : {},
});

async function base_request(config) {
    let last_err;
    for (let attempt = 0; attempt <= base_max_retries; attempt++) {
        try { return await axios({ ...config, timeout: base_timeout }); }
        catch (e) {
            last_err = e;
            if (e.response?.status >= 400 && e.response.status < 500) throw e;
        }
    }
    throw last_err;
}

const md_processor = remark().use(strip);
async function to_markdown(html) {
    const result = await md_processor.process(html);
    return String(result);
}

// ── tool registrations ────────────────────────────────────────────────────────
// Minimal stubs that delegate to the Bright Data REST API.
// For the full production implementation see server.js — this file focuses on
// the payment gating wrapper; tool logic is intentionally thin here.

addTool({
    name: "search_engine",
    description: "Scrape search results from Google, Bing or Yandex. Returns "
        + "organic results with titles, URLs, and descriptions.",
    parameters: z.object({
        query: z.string().describe("Search query"),
        engine: z.enum(["google", "bing", "yandex"]).optional()
            .describe("Search engine (default: google)"),
        country: z.string().optional().describe("2-letter country code"),
    }),
    execute: async (args, {session}) => {
        const resp = await base_request({
            url: `https://api.brightdata.com/serp`,
            method: "POST",
            headers: { ...api_headers(session?.clientInfo?.name, "search_engine"),
                "Content-Type": "application/json" },
            data: { query: args.query, country: args.country,
                search_engine: args.engine || "google" },
        });
        return JSON.stringify(resp.data);
    },
});

addTool({
    name: "scrape_as_markdown",
    description: "Scrape a webpage and return its content as clean Markdown.",
    parameters: z.object({
        url: z.string().url().describe("URL to scrape"),
        country: z.string().optional().describe("2-letter country code for geo-routing"),
    }),
    execute: async (args, {session}) => {
        const resp = await base_request({
            url: `https://api.brightdata.com/request`,
            method: "POST",
            headers: { ...api_headers(session?.clientInfo?.name, "scrape_as_markdown"),
                "Content-Type": "application/json" },
            data: { zone: unlocker_zone, url: args.url,
                format: "raw", country: args.country },
        });
        return await to_markdown(resp.data);
    },
});

// Additional tools (scrape_as_html, search_engine_batch, scrape_batch, extract,
// session_stats, all web_data_*, scraping_browser_*) follow the same pattern
// as server.js. See the full implementation in server.js — this file only
// registers the two core tools for clarity.
// To enable all tools, run server.js; this file demonstrates the payment
// gating wrapper pattern.

server.addPrompts(prompts);

for (const tool of browser_tools)
    addTool(tool);

server.on("connect", (event) => {
    const session = event.session;
    const clientInfo = session.server?.getClientVersion?.();
    if (clientInfo)
        global.mcpClientInfo = clientInfo;
});

// ── payment gating ────────────────────────────────────────────────────────────
// withPayments() wraps the FastMCP instance. Every tool call is intercepted:
//   1. Check for valid payment header (x402 USDC receipt or MPP token)
//   2. If missing/invalid → return HTTP 402 with paymentRequired details
//   3. If valid → execute tool, settle micropayment to TOMOPAY_ADDRESS
const {server: gatedServer} = withPayments(server, {
    payTo: tomopay_address,
    protocols: ["x402", "mpp"],
    pricing: PRICING,
    defaultPrice: {amount: 10, currency: "USD"},
});

console.error("Starting payment-gated Bright Data MCP server...");
console.error(`Payment address: ${tomopay_address}`);

gatedServer.start({transportType: "stdio"});
