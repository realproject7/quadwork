'use strict';

// This identity is process-local, non-serializable, and intentionally absent
// from configuration and HTTP. Only the fixed #1117 runner imports it before
// invoking the ordinary V2 admission API.
const capability = Object.freeze({});
function internalReviewedExecutionCapability() { return capability; }
function isInternalReviewedExecutionCapability(value) { return value === capability; }
module.exports = Object.freeze({ internalReviewedExecutionCapability, isInternalReviewedExecutionCapability });
