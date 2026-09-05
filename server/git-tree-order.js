"use strict";

// The one Git tree-order comparator.  Git orders tree entries by byte value,
// never by locale: `README.md` precedes `bin`, and a tree record compares as
// if its name ended in `/` (Git's base_name_compare), so the blob `lib-x`
// precedes the tree `lib` while the blob `lib0` follows it.  Nothing here
// consults a locale collation or the host locale.

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

// Flattened repository paths (`git ls-tree -r`): UTF-8 byte order of the
// whole path.  The `/` a tree contributes is already part of every path
// beneath it, so this is the same order Git walks.
function compareGitTreePaths(left, right) {
  return compareBytes(left, right);
}

// Immediate records of one tree object (`git ls-tree`, `git mktree` input):
// `{ name, type }` where `type` is "tree" for a directory record.
function compareGitTreeRecords(left, right) {
  return compareBytes(left.name + (left.type === "tree" ? "/" : ""), right.name + (right.type === "tree" ? "/" : ""));
}

module.exports = { compareGitTreePaths, compareGitTreeRecords };
