"use strict";

// Closed action-time TOCTOU guard shared by private nonce issuance and native
// receipt admission. It accepts no caller contract revision: #1033's live
// normalizer plus a post-read current-cycle reload must agree.
async function verifyActionContract(cycle, reloadCurrent, fetchRevision) {
  if (!cycle || typeof reloadCurrent !== "function" || typeof fetchRevision !== "function") return null;
  let revision;
  try { revision = await fetchRevision({ repo: cycle.target?.repo, issue: cycle.target?.work_item?.number }); }
  catch { return null; }
  let after;
  try { after = reloadCurrent(); }
  catch { return null; }
  if (!after || after.cycle_id !== cycle.cycle_id || after.target_identity_digest !== cycle.target_identity_digest ||
      revision?.contract_revision !== after.target?.contract_revision) return null;
  return after;
}

module.exports = { verifyActionContract };
