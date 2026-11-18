import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { slug } from "github-slugger";

const welcomeFile = "00-welcome.md";
const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceDirectories = { root: "docs/zh-CN/lite", en: "docs/lite" };
const routePrefixes = { root: "/", en: "/en/" };
const upstreamFiles = "https://github.com/BabylonJS/Babylon-Lite/blob/master/";

type Locale = keyof typeof sourceDirectories;

function markdownLinks(locale: Locale, directory: "" | "architecture/") {
    const source = new URL(`../../../${sourceDirectories[locale]}/${directory}`, import.meta.url);
    const prefix = routePrefixes[locale];
    return readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort()
        .map((file) => {
            const markdown = readFileSync(new URL(file, source), "utf8");
            const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.slice(0, -3);
            const link = file === welcomeFile && directory === "" ? prefix : `${prefix}${directory}${file.slice(0, -3)}.html`;
            return { text: title, link };
        });
}

export default defineConfig({
    srcDir: "..",
    srcExclude: ["*.md", "!(lite|zh-CN)/**", "zh-CN/*.md", "zh-CN/!(lite)/**"],
    title: "Babylon Lite",
    vite: {
        plugins: [
            {
                name: "exclude-lite-gl-docs",
                configureServer(server) {
                    // VitePress's srcExclude filters the build list, but dev can serve an excluded Markdown path directly.
                    server.middlewares.use((request, response, next) => {
                        if (request.url && /^\/gl(?:[/?:#]|$)/.test(request.url)) {
                            response.statusCode = 404;
                            response.end("Not Found");
                            return;
                        }
                        next();
                    });
                },
            },
        ],
        resolve: {
            // Markdown sits outside this package, so its generated Vue imports need local resolution.
            alias: [
                { find: /^vue$/, replacement: require.resolve("vue/dist/vue.runtime.esm-bundler.js") },
                { find: "vue/server-renderer", replacement: require.resolve("vue/server-renderer") },
            ],
        },
    },
    rewrites: {
        [`zh-CN/lite/${welcomeFile}`]: "index.md",
        [`lite/${welcomeFile}`]: "en/index.md",
        "zh-CN/lite/:page*": ":page*",
        "lite/:page*": "en/:page*",
    },
    markdown: {
        anchor: { slugify: slug },
        config(markdown) {
            markdown.core.ruler.after("inline", "repository-links", (state) => {
                const sourceFile: unknown = state.env.realPath;
                if (typeof sourceFile !== "string") {
                    return;
                }
                const locale: Locale = state.env.localeIndex === "en" ? "en" : "root";
                const sourceDirectory = relative(repositoryRoot, dirname(sourceFile)).replaceAll("\\", "/");
                const localeDirectory = sourceDirectories[locale];
                for (const block of state.tokens) {
                    for (const token of block.children ?? []) {
                        // Unquoted generic types in upstream prose look like tags to Markdown-it.
                        if (token.type === "html_inline" && /^<(?:[fiu]\d+|GPU[A-Za-z]+)>$/.test(token.content)) {
                            token.type = "text";
                        }
                        const href = token.type === "link_open" ? token.attrGet("href") : null;
                        if (!href || /^(?:[a-z][a-z0-9+.-]*:|[/?#])/i.test(href)) {
                            continue;
                        }
                        const suffixStart = href.search(/[?#]/);
                        const path = suffixStart === -1 ? href : href.slice(0, suffixStart);
                        const suffix = suffixStart === -1 ? "" : href.slice(suffixStart);
                        const repoPath = posix.normalize(posix.join(sourceDirectory, path));
                        if (repoPath === `${localeDirectory}/${welcomeFile}`) {
                            token.attrSet("href", routePrefixes[locale] + suffix);
                        } else if (path.startsWith("../") && !repoPath.startsWith("../") && !repoPath.startsWith(`${localeDirectory}/`)) {
                            // Repository files outside the site use their upstream GitHub URLs.
                            token.attrSet("href", upstreamFiles + repoPath + suffix);
                        }
                    }
                }
            });
        },
    },
    locales: {
        root: {
            label: "简体中文",
            lang: "zh-CN",
            title: "Babylon Lite 中文文档",
            description: "Babylon Lite 的使用指南和架构文档",
            themeConfig: {
                sidebar: [
                    { text: "使用指南", items: markdownLinks("root", "") },
                    { text: "引擎架构", collapsed: true, items: markdownLinks("root", "architecture/") },
                ],
                outline: { label: "本页目录" },
                docFooter: { prev: "上一篇", next: "下一篇" },
                sidebarMenuLabel: "文档导航",
                returnToTopLabel: "返回顶部",
                darkModeSwitchLabel: "外观",
            },
        },
        en: {
            label: "English",
            lang: "en",
            title: "Babylon Lite Documentation",
            description: "Babylon Lite guides and architecture documentation",
            themeConfig: {
                sidebar: [
                    { text: "Guides", items: markdownLinks("en", "") },
                    { text: "Architecture", collapsed: true, items: markdownLinks("en", "architecture/") },
                ],
            },
        },
    },
});
