"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compareGitTreePaths, compareGitTreeRecords } = require("./git-tree-order");

function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).trim();
}
function locale(names) { return [...names].sort((left, right) => left.localeCompare(right)); }
function reversed(values) { return [...values].reverse(); }

// Cases where byte order and a locale order genuinely disagree.  Each one
// asserts the divergence itself, so a case can never silently stop testing.
{
  for (const [names, expected] of [
    [["bin", "README.md"], ["README.md", "bin"]],
    [["a", "Z"], ["Z", "a"]],
    [["a_b", "a-b", "a.b"], ["a-b", "a.b", "a_b"]],
    [["src", "package.json", "README.md", "bin", ".gitignore", "docs", "LICENSE"], [".gitignore", "LICENSE", "README.md", "bin", "docs", "package.json", "src"]],
    [["server/b.js", "server/README.md", "server/a.js"], ["server/README.md", "server/a.js", "server/b.js"]],
  ]) {
    assert.deepEqual([...names].sort(compareGitTreePaths), expected);
    assert.deepEqual(reversed(names).sort(compareGitTreePaths), expected, "order is independent of input order");
    assert.notDeepEqual(locale(names), expected, `${names.join(",")} is a genuine locale/byte divergence`);
  }
  console.log("  PASS: flattened paths compare by byte value where a locale order disagrees");
}

// A tree record compares as if its name ended in `/`: the blob `foo-bar`
// (0x2D) and `foo.bar` (0x2E) precede the tree `foo`, the blob `foo0` (0x30)
// follows it, and a name-only comparison of either kind gets this wrong.
{
  const records = [
    { name: "foo0", type: "blob" }, { name: "foo", type: "tree" }, { name: "foo.bar", type: "blob" },
    { name: "foo-bar", type: "blob" }, { name: "bin", type: "tree" }, { name: "README.md", type: "blob" },
  ];
  const expected = ["README.md", "bin", "foo-bar", "foo.bar", "foo", "foo0"];
  assert.deepEqual([...records].sort(compareGitTreeRecords).map((entry) => entry.name), expected);
  assert.deepEqual(reversed(records).sort(compareGitTreeRecords).map((entry) => entry.name), expected);
  assert.notDeepEqual(locale(records.map((entry) => entry.name)), expected, "a locale order of the names diverges");
  assert.notDeepEqual([...records].map((entry) => entry.name).sort(compareGitTreePaths), expected, "a plain byte order of the names diverges: the tree slash matters");
  assert.ok(compareGitTreeRecords({ name: "foo", type: "blob" }, { name: "foo0", type: "blob" }) < 0, "a blob prefix precedes its extension");
  assert.ok(compareGitTreeRecords({ name: "foo0", type: "blob" }, { name: "foo", type: "tree" }) > 0, "a tree precedes a blob whose next byte exceeds `/`");
  console.log("  PASS: immediate records follow Git's base_name_compare, a directory name compared as if followed by a slash");
}

// Native Git is the oracle: the comparator reproduces `git ls-tree` order for
// both shapes, and a raw tree object serialized in comparator order hashes to
// the native tree SHA, while Git refuses the same bytes in locale order.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-git-tree-order-"));
  try {
    git(directory, ["init", "-q", "-b", "main"]);
    for (const [relative, content] of [
      ["README.md", "readme\n"], ["bin/cli.js", "cli\n"], ["foo-bar", "dash\n"], ["foo.bar", "dot\n"],
      ["foo/inner", "inner\n"], ["foo0", "zero\n"], ["package.json", "{}\n"], ["src/index.js", "index\n"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      fs.writeFileSync(path.join(directory, relative), content, "utf8");
    }
    git(directory, ["add", "."]);
    git(directory, ["-c", "user.email=quadwork@example.test", "-c", "user.name=QuadWork Test", "commit", "-q", "-m", "root"]);
    const nativeTree = git(directory, ["rev-parse", "HEAD^{tree}"]);
    const nativePaths = git(directory, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    assert.deepEqual(reversed(nativePaths).sort(compareGitTreePaths), nativePaths, "flattened comparator order is native `git ls-tree -r` order");
    assert.notDeepEqual(locale(nativePaths), nativePaths);

    const records = git(directory, ["ls-tree", "HEAD"]).split("\n").map((line) => {
      const match = line.match(/^(\d+) (blob|tree) ([0-9a-f]{40})\t(.+)$/);
      return { mode: match[1], type: match[2], sha: match[3], name: match[4] };
    });
    const nativeNames = records.map((entry) => entry.name);
    assert.deepEqual(nativeNames, ["README.md", "bin", "foo-bar", "foo.bar", "foo", "foo0", "package.json", "src"]);
    assert.deepEqual(reversed(records).sort(compareGitTreeRecords).map((entry) => entry.name), nativeNames, "record comparator order is native `git ls-tree` order");

    const rawTree = (ordered) => Buffer.concat(ordered.flatMap((entry) => [Buffer.from(`${entry.mode.replace(/^0+/, "")} ${entry.name}\0`, "utf8"), Buffer.from(entry.sha, "hex")]));
    const hashTree = (ordered) => execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { cwd: directory, input: rawTree(ordered), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    assert.equal(hashTree(reversed(records).sort(compareGitTreeRecords)), nativeTree, "a tree serialized in comparator order is the native tree object");
    assert.throws(() => hashTree([...records].sort((left, right) => left.name.localeCompare(right.name))), /not properly sorted/, "Git refuses the same records in locale order");
    assert.throws(() => hashTree([...records].sort((left, right) => compareGitTreePaths(left.name, right.name))), /not properly sorted/, "Git refuses records ordered by name bytes without the tree slash");
    console.log("  PASS: comparator order reproduces native git ls-tree order and the native tree SHA; locale order is refused by git");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

{
  const source = fs.readFileSync(path.join(__dirname, "git-tree-order.js"), "utf8");
  assert.doesNotMatch(source, /localeCompare|Intl\.|toLocale/);
  console.log("  PASS: the comparator never consults a locale");
}

console.log("git-tree-order.test.js: all assertions passed");
