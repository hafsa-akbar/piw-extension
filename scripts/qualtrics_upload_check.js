// Paste into the Qualtrics File Upload question's JavaScript editor (Question Behavior → JavaScript).
// Blocks Next until the upload is this respondent's unedited PIW export: parses the JSON, verifies the HMAC
// signature, and matches participant_id against the PROLIFIC_PID embedded data (rename the pipe below if your
// field differs). Advisory only — page JS can be bypassed — so scripts/verify.js at analysis stays authoritative.
// Also set the question's own allowed extensions to .json. SIG_KEY and canon must match sidepanel.js; written
// without template literals because Qualtrics' piped-text replacement mangles "${...}" inside question JS.

var SIG_KEY = "0f4d3a579a13ac7277591e41c8bc7f6c6e20a62e81f402036f00da6c93c563b5";
var NOT_OURS = "This doesn't look like the study file. Please upload the piw_… .json file the PIW Study Helper saved (normally in your Downloads folder).";
var EDITED = "This file was changed after it was downloaded. Please upload the original, unedited file.";
var WRONG_PID = "This file belongs to a different Prolific ID. Please upload the file you downloaded yourself.";

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(function (x) { return canon(x === undefined ? null : x); }).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
    .map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  return JSON.stringify(v);
}
function hmac(text) {
  var enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(SIG_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then(function (key) { return crypto.subtle.sign("HMAC", key, enc.encode(text)); })
    .then(function (buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); });
}
function problem(file, pid) { // resolves to an error message, or "" if the file is good
  return file.text().then(function (text) {
    var data; try { data = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { data = null; }
    if (!data || !data.integrity) return NOT_OURS;
    var rest = Object.assign({}, data); delete rest.integrity;
    return hmac(canon(rest)).then(function (sig) {
      if (sig !== data.integrity) return EDITED;
      var fpid = String(data.participant_id || "").trim(); // optional in the extension: only enforce the match when present
      if (pid && fpid && fpid !== pid) return WRONG_PID;
      return "";
    });
  });
}

Qualtrics.SurveyEngine.addOnReady(function () {
  var q = this;
  var pid = "${e://Field/PROLIFIC_PID}".trim();
  if (pid.charAt(0) === "$") pid = ""; // pipe not replaced (e.g. previewing outside the Prolific flow): skip the ID match
  var box = jQuery("#" + q.questionId);
  var err = jQuery('<div style="color:#b00;font-weight:600;margin-top:8px"></div>').appendTo(box.find(".QuestionBody"));
  q.disableNextButton();
  box.on("change", "input[type=file]", function (e) {
    var file = e.target.files[0];
    err.text(""); q.disableNextButton();
    if (!file) return;
    problem(file, pid).then(function (msg) {
      if (msg) { err.text(msg); e.target.value = ""; } else q.enableNextButton();
    }, function () { err.text("Couldn't read that file. Please try again."); });
  });
});
