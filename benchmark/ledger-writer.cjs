'use strict';

// #1182. Durable, append-only benchmark ledger writer: one ledger per run,
// holding only records that evidence.cjs accepts. Each record references a
// closed, secret-free observation payload by a content address the writer
// generates itself. It never launches a provider, contacts a remote service,
// or writes outside a marked root it created. ledgerStore() is the marked-root
// and ledger persistence moved unchanged from calibration-executor.cjs, which
// imports it with its own error class and code prefix.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { appendRecord, validateLedger, digest: evidenceDigest, MAX_BYTES } = require('./evidence.cjs');

const EVIDENCE_LEDGER = 'ledger.json';
const EVIDENCE_OBSERVATIONS = 'observations';
const EVIDENCE_LOCK = '.ledger.lock';
const TEMPORARY = /^\.ledger-[a-f0-9]{64}\.tmp$/;
const RUN_MARKER = '.quadwork-benchmark-ledger-v1';
const RUN_MARKER_BODY = 'quadwork-benchmark-ledger-v1\n';
const RUN_ROOT = new Set([RUN_MARKER, EVIDENCE_LEDGER, EVIDENCE_OBSERVATIONS, EVIDENCE_LOCK]);
const GENERATED = ['sequence', 'prior_record_digest', 'evidence_ref'];
const COUNTERS = ['remote_pushes', 'pull_requests', 'merges', 'validation_attempts', 'role_wakes', 'chat_bytes', 'no_ops', 'recovery_events'];
const WAIT_CATEGORIES = new Set(['provider_rate_limit', 'git_remote', 'github_api']);
const MEMORY_PRESSURE = new Set(['normal', 'warn', 'critical']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function uid() { return typeof process.getuid === 'function' ? process.getuid() : null; }
function mode(stat) { return stat.mode & 0o777; }
function safeText(value, limit = 1024) { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000\r\n]/.test(value); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function ledgerStore(ErrorClass, scope) {
  function required(value, code) { if (!value) throw new ErrorClass(code); }
  function markerRoot(directory, marker, body, allowed, code, temporaries = false) {
    required(typeof directory === 'string' && path.isAbsolute(directory) && safeText(directory), code);
    let stat, root, names;
    try { stat = fs.lstatSync(directory); root = fs.realpathSync(directory); names = fs.readdirSync(root); } catch { throw new ErrorClass(code); }
    required(!stat.isSymbolicLink() && stat.isDirectory() && mode(stat) === 0o700 && (uid() === null || stat.uid === uid()) && names.every(name => allowed.has(name) || (temporaries && TEMPORARY.test(name))) && names.includes(marker), code);
    const markerPath = path.join(root, marker); let markerStat;
    try { markerStat = fs.lstatSync(markerPath); } catch { throw new ErrorClass(code); }
    required(!markerStat.isSymbolicLink() && markerStat.isFile() && mode(markerStat) === 0o600 && (uid() === null || markerStat.uid === uid()) && fs.readFileSync(markerPath, 'utf8') === body, code);
    return root;
  }
  function createMarkedRoot(parent_dir, prefix, marker, body, code) {
    required(typeof parent_dir === 'string' && path.isAbsolute(parent_dir) && safeText(parent_dir), code);
    const parent = fs.realpathSync(parent_dir), parentStat = fs.lstatSync(parent); required(parentStat.isDirectory() && !parentStat.isSymbolicLink(), code);
    const root = fs.mkdtempSync(path.join(parent, prefix)); fs.chmodSync(root, 0o700); fs.writeFileSync(path.join(root, marker), body, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.chmodSync(path.join(root, marker), 0o600); return root;
  }
  function readLedger(root, supplied) { const filename = path.join(root, EVIDENCE_LEDGER); if (!fs.existsSync(filename)) { required(supplied.records.length === 0, `${scope}_evidence_prefix`); return; } const stat = fs.lstatSync(filename); required(!stat.isSymbolicLink() && stat.isFile() && mode(stat) === 0o600 && stat.size <= 512 * 1024, `${scope}_evidence_ledger`); let parsed; try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new ErrorClass(`${scope}_evidence_ledger`); } const normalized = validateLedger(parsed).ledger; required(evidenceDigest(normalized) === evidenceDigest(supplied), `${scope}_evidence_prefix`); for (const item of normalized.records) { const hash = item.evidence_ref.split('/').at(-1), observation = path.join(root, EVIDENCE_OBSERVATIONS, `${hash}.json`); required(/^[a-f0-9]{64}$/.test(hash) && fs.existsSync(observation) && sha256(fs.readFileSync(observation)) === hash, `${scope}_observation_missing`); } }
  function withLock(root, callback) { const lock = path.join(root, EVIDENCE_LOCK); let fd; try { if (fs.existsSync(lock)) { const raw = fs.readFileSync(lock, 'utf8'); if (!/^\d{1,12}\n$/.test(raw)) throw new ErrorClass(`${scope}_evidence_lock`); const pid = Number(raw.trim()); let active = true; try { process.kill(pid, 0); } catch (error) { active = error?.code !== 'ESRCH'; } if (active) throw new ErrorClass(`${scope}_evidence_lock`); fs.unlinkSync(lock); } for (const name of fs.readdirSync(root)) if (TEMPORARY.test(name)) fs.unlinkSync(path.join(root, name)); fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); fs.writeSync(fd, `${process.pid}\n`); fs.fsyncSync(fd); return callback(); } catch (error) { if (error instanceof ErrorClass) throw error; throw new ErrorClass(`${scope}_evidence_lock`); } finally { try { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } } catch {} } }
  function persistAppend(root, supplied, next, bytes, hash) { return withLock(root, () => { readLedger(root, supplied); const filename = path.join(root, EVIDENCE_LEDGER), directory = path.join(root, EVIDENCE_OBSERVATIONS), observation = path.join(directory, `${hash}.json`), temporary = path.join(root, `.ledger-${crypto.randomBytes(32).toString('hex')}.tmp`); let fd; try { if (!fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); } const directoryStat = fs.lstatSync(directory); required(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && mode(directoryStat) === 0o700 && (uid() === null || directoryStat.uid === uid()), `${scope}_evidence_persist`); if (!fs.existsSync(observation)) { fs.writeFileSync(observation, bytes, { mode: 0o600, flag: 'wx' }); fs.chmodSync(observation, 0o600); fd = fs.openSync(observation, fs.constants.O_RDONLY); fs.fsyncSync(fd); fs.closeSync(fd); fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; } const observationStat = fs.lstatSync(observation); required(observationStat.isFile() && !observationStat.isSymbolicLink() && mode(observationStat) === 0o600 && (uid() === null || observationStat.uid === uid()) && observationStat.size <= 512 * 1024 && sha256(fs.readFileSync(observation)) === hash, `${scope}_evidence_persist`); fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); fs.writeFileSync(fd, JSON.stringify(next) + '\n', 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, filename); fs.chmodSync(filename, 0o600); fd = fs.openSync(root, fs.constants.O_RDONLY); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; return next; } catch { try { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {} throw new ErrorClass(`${scope}_evidence_persist`); } }); }
  return Object.freeze({ markerRoot, createMarkedRoot, persistAppend });
}

class LedgerWriterError extends Error {}
const store = ledgerStore(LedgerWriterError, 'ledger_writer');
function required(value, code) { if (!value) throw new LedgerWriterError(code); }
function exact(value, keys, code) { required(object(value), code); const actual = Object.keys(value).sort(), expected = [...keys].sort(); required(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code); }

// Closed observation payload: numbers and fixed enum strings only. Each object
// is copied once, so a getter cannot pass validation and persist another value.
const reject = () => { throw new LedgerWriterError('ledger_writer_observation'); };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : reject();
const tokens = value => value === 'unavailable' ? value : count(value);
const oneOf = set => value => set.has(value) ? value : reject();
const list = (max, item) => value => Array.isArray(value) && value.length <= max ? Array.from(value, entry => item(entry)) : reject();
const shape = schema => value => { const copy = object(value) ? { ...value } : reject(); exact(copy, Object.keys(schema), 'ledger_writer_observation'); return Object.fromEntries(Object.entries(schema).map(([key, normalize]) => [key, normalize(copy[key])])); };
const wait = shape({ category: oneOf(WAIT_CATEGORIES), started_monotonic_ms: count, ended_monotonic_ms: count });
const host = shape({
  sampling_interval_ms: value => count(value) > 0 ? value : reject(),
  sampler_overhead_ms: count,
  samples: list(2048, shape({ monotonic_ms: count, cpu_percent: value => typeof value === 'number' && value >= 0 && value <= 100 ? value : reject(), rss_bytes: count, swap_used_bytes: count, memory_pressure: oneOf(MEMORY_PRESSURE) })),
});
const validateObservation = shape({
  provider_turns: list(256, shape({ input_tokens: tokens, cached_input_tokens: tokens, output_tokens: tokens })),
  counters: shape(Object.fromEntries(COUNTERS.map(key => [key, count]))),
  external_waits: list(256, value => { const interval = wait(value); return interval.started_monotonic_ms <= interval.ended_monotonic_ms ? interval : reject(); }),
  host: value => value === 'unavailable' ? value : host(value),
});

function createRunLedgerRoot(value = {}) {
  exact(value, ['parent_dir'], 'ledger_writer_root_create');
  return store.markerRoot(store.createMarkedRoot(value.parent_dir, 'quadwork-benchmark-ledger-', RUN_MARKER, RUN_MARKER_BODY, 'ledger_writer_root_create'), RUN_MARKER, RUN_MARKER_BODY, new Set([RUN_MARKER]), 'ledger_writer_root_create', true);
}
// `prior` is the caller's last committed ledger (an empty ledger for the first
// event). The caller supplies every record field except the generated ones.
function appendRunEvent(root, prior, record, observation) {
  const directory = store.markerRoot(root, RUN_MARKER, RUN_MARKER_BODY, RUN_ROOT, 'ledger_writer_root', true);
  const current = validateLedger(prior).ledger, input = object(record) ? { ...record } : null;
  required(input && GENERATED.every(key => !Object.hasOwn(input, key)), 'ledger_writer_record_shape');
  required(current.records.length === 0 || input.run_id === current.records[0].run_id, 'ledger_writer_one_run');
  const bytes = Buffer.from(JSON.stringify(validateObservation(observation)) + '\n'), hash = sha256(bytes);
  const next = appendRecord(current, { ...input, sequence: current.records.length + 1, evidence_ref: `writer/${hash}` });
  required(Buffer.byteLength(JSON.stringify(next) + '\n') <= MAX_BYTES, 'ledger_writer_ledger_limit');
  return store.persistAppend(directory, current, next, bytes, hash);
}

module.exports = { LedgerWriterError, EVIDENCE_LEDGER, EVIDENCE_OBSERVATIONS, EVIDENCE_LOCK, ledgerStore, createRunLedgerRoot, appendRunEvent, validateObservation };
