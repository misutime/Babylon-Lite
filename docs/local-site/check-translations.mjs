import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const englishPath = "docs/lite";
const chinesePath = "docs/zh-CN/lite";
const baseline = readFileSync(new URL("./translation-base.txt", import.meta.url), "utf8").trim();

function git(...args) {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

function markdownFiles(directory) {
    const root = join(repositoryRoot, directory);
    return new Set(
        readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
            .sort()
    );
}

if (!/^[a-f0-9]{40}$/.test(baseline)) {
    throw new Error("translation-base.txt must contain the full Git SHA of the translated English source.");
}

const trackedChanges = git("diff", "--name-status", "--no-renames", baseline, "--", englishPath).trimEnd();
const untrackedChanges = git("ls-files", "--others", "--exclude-standard", "--", englishPath).trimEnd();
const englishFiles = markdownFiles(englishPath);
const chineseFiles = markdownFiles(chinesePath);
const missing = [...englishFiles].filter((file) => !chineseFiles.has(file));
const orphaned = [...chineseFiles].filter((file) => !englishFiles.has(file));

if (trackedChanges || untrackedChanges || missing.length || orphaned.length) {
    console.log("English source changes since " + baseline);
    if (trackedChanges) {
        console.log(trackedChanges);
    }
    if (untrackedChanges) {
        console.log(
            untrackedChanges
                .split("\n")
                .map((file) => "?\t" + file)
                .join("\n")
        );
    }
    if (missing.length) {
        console.log("Missing Chinese pages:\n" + missing.join("\n"));
    }
    if (orphaned.length) {
        console.log("Chinese pages without an English source:\n" + orphaned.join("\n"));
    }
    process.exitCode = 1;
} else {
    console.log("English source matches the translation baseline. " + chineseFiles.size + " Chinese pages have matching English filenames.");
}
