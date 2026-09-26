"use strict";

// #1188: test-only preload. server/run-tests.js loads it with NODE_OPTIONS
// --require into every test process, so every Node child that inherits the
// environment loads it too. Any fs call, process.chdir, or child_process cwd or
// argument that names a directory in QUADWORK_TEST_GUARDED_DIRS is refused with
// EACCES before it reaches the file system, and so is spawning a gh listed in
// QUADWORK_TEST_BLOCKED_GH. Each refusal is recorded in
// QUADWORK_TEST_GUARD_REPORT so the runner fails the file even when the test
// swallows the error. The check is on the path the process asks for, so an
// absent directory stays absent, and it only sees this process's own calls:
// a live QuadWork server writing the same directory can never trip it.

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const INSTALLED = Symbol.for("quadwork.realHomeGuard");

function guardedDirs() {
  try {
    const dirs = JSON.parse(process.env.QUADWORK_TEST_GUARDED_DIRS || "[]");
    return Array.isArray(dirs) ? dirs.filter((dir) => typeof dir === "string" && path.isAbsolute(dir)) : [];
  } catch {
    return [];
  }
}

function install(dirs) {
  const fold = process.platform === "darwin" || process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const roots = dirs.map((dir) => fold(path.resolve(dir)));
  const report = process.env.QUADWORK_TEST_GUARD_REPORT || "";
  const { appendFileSync, realpathSync } = fs;
  const cwd = () => { try { return process.cwd(); } catch { return path.parse(process.execPath).root; } };

  function guarded(value) {
    let p = value;
    if (Buffer.isBuffer(p)) p = p.toString();
    else if (p instanceof URL) p = p.protocol === "file:" ? fileURLToPath(p) : null;
    if (typeof p !== "string" || p === "") return null;
    const abs = path.resolve(cwd(), p);
    const key = fold(abs);
    return roots.some((root) => key === root || key.startsWith(root + path.sep)) ? abs : null;
  }

  function refuse(op, target) {
    try { if (report) appendFileSync(report, `${JSON.stringify({ op, path: target })}\n`); } catch { /* stderr still shows it */ }
    try { process.stderr.write(`[real-home-guard] refused ${op} ${target}\n`); } catch { /* no stderr */ }
    const error = new Error(`EACCES: test guard (#1188) refused ${op}: ${target}`);
    return Object.assign(error, { code: "EACCES", errno: -13, syscall: op, path: target });
  }

  function replace(owner, name, check) {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      const result = check(args);
      return result === undefined ? original.apply(this, args) : result();
    };
    for (const key of Reflect.ownKeys(original)) {
      if (key !== "prototype") Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
    }
    owner[name] = wrapped;
    return wrapped;
  }

  // Which path arguments an fs function takes. fd-only functions take none.
  const FD_ONLY = /^(close|fchmod|fchown|fdatasync|fstat|fsync|ftruncate|futimes|read|readv|write|writev)(Sync)?$/;
  function targets(name, args) {
    if (/^(rename|copyFile|cp|link)(Sync)?$/.test(name)) return [args[0], args[1]];
    // A relative symlink target is resolved against the link, not the cwd.
    if (/^symlink(Sync)?$/.test(name)) return [path.isAbsolute(String(args[0])) ? args[0] : null, args[1]];
    if (/^glob(Sync)?$/.test(name)) return [...[].concat(args[0]), args[1] && args[1].cwd];
    return [args[0]];
  }
  function firstGuarded(name, args) {
    for (const value of targets(name, args)) {
      const target = guarded(value);
      if (target) return target;
    }
    return null;
  }

  // Refuse the way each API reports an error: throw (sync and stream
  // constructors), reject (promises), or call back (callback style).
  const THROWS = /Sync$|^(createReadStream|createWriteStream|watch|watchFile|unwatchFile)$/;
  for (const name of Object.keys(fs)) {
    if (typeof fs[name] !== "function" || /^[A-Z_]/.test(name) || FD_ONLY.test(name)) continue;
    const wrapped = replace(fs, name, (args) => {
      const target = firstGuarded(name, args);
      if (!target) return undefined;
      const error = refuse(`fs.${name}`, target);
      if (name === "existsSync") return () => false;
      if (THROWS.test(name)) return () => { throw error; };
      if (name === "openAsBlob") return () => Promise.reject(error);
      const callback = args[args.length - 1];
      if (typeof callback !== "function") return () => { throw error; };
      return () => process.nextTick(callback, name === "exists" ? false : error);
    });
    if (wrapped && typeof wrapped.native === "function") {
      replace(wrapped, "native", (args) => {
        const target = firstGuarded(name, args);
        if (!target) return undefined;
        const error = refuse(`fs.${name}.native`, target);
        if (THROWS.test(name)) return () => { throw error; };
        const callback = args[args.length - 1];
        return typeof callback === "function" ? () => process.nextTick(callback, error) : () => { throw error; };
      });
    }
  }
  for (const name of Object.keys(fs.promises)) {
    if (typeof fs.promises[name] !== "function") continue;
    replace(fs.promises, name, (args) => {
      const target = firstGuarded(name, args);
      if (!target) return undefined;
      const error = refuse(`fs.promises.${name}`, target);
      // watch and glob return async iterators, not promises.
      return name === "watch" || name === "glob" ? () => { throw error; } : () => Promise.reject(error);
    });
  }

  replace(process, "chdir", (args) => {
    const target = guarded(args[0]);
    if (!target) return undefined;
    const error = refuse("process.chdir", target);
    return () => { throw error; };
  });

  // A `gh` that resolves (like the OS lookup) to the runner's stand-in or to a
  // real gh is refused at spawn time, so even a fire-and-forget call made just
  // before exit is recorded. A test's own fake gh earlier on PATH is allowed.
  let blockedGh = [];
  try { blockedGh = JSON.parse(process.env.QUADWORK_TEST_BLOCKED_GH || "[]"); } catch { blockedGh = []; }
  function ghTarget(command, options) {
    if (typeof command !== "string" || path.basename(command) !== "gh" || !Array.isArray(blockedGh)) return null;
    const env = (options && options.env) || process.env;
    const candidates = command !== "gh"
      ? [path.resolve((options && options.cwd) || cwd(), command)]
      : String(env.PATH || "").split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, "gh"));
    for (const file of candidates) {
      let real;
      try { real = realpathSync(file); } catch { continue; }
      return blockedGh.includes(real) ? file : null;
    }
    return null;
  }

  // A child process is refused when it would start inside a guarded directory
  // or is handed a guarded path, which covers the non-Node children (sh, git)
  // this preload cannot load into.
  const childProcess = require("child_process");
  const rootText = (value) => typeof value === "string" && roots.some((root) => fold(value).includes(root));
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    replace(childProcess, name, (args) => {
      const options = args.slice(1).find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
      const argv = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])];
      const gh = ghTarget(args[0], options);
      const target = (gh && [gh, ...argv.slice(1)].join(" ")) || (options && guarded(options.cwd)) || argv.find(rootText);
      if (!target) return undefined;
      const error = refuse(`child_process.${name}${gh ? " (gh)" : ""}`, target);
      return () => { throw error; };
    });
  }
}

const dirs = guardedDirs();
if (dirs.length > 0 && !globalThis[INSTALLED]) {
  Object.defineProperty(globalThis, INSTALLED, { value: true });
  install(dirs);
}
