/**
 * SainsTrivia — Google Apps Script Backend (Database Bank Soal di Google Drive)
 *
 * Cara Setup:
 * 1. Buka https://script.google.com -> Proyek Baru -> tempel seluruh kode ini ke Code.gs.
 * 2. (Opsional) Isi API_SECRET jika ingin menyamakan token keamanan dengan env APPS_SCRIPT_SECRET di Cloudflare.
 * 3. Klik Deploy > New deployment > Type: Web app.
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Salin URL Web App (berakhiran /exec) lalu tempel ke Environment Variable "APPS_SCRIPT_URL" di Cloudflare Dashboard.
 * 5. Saat pertama kali dijalankan, folder "SainsTrivia_Database" dan file "questions.json" otomatis dibuat di Google Drive Anda.
 */

var FOLDER_NAME = "SainsTrivia_Database";
var FILE_NAME = "questions.json";
var API_SECRET = ""; // Opsional: samakan dengan env APPS_SCRIPT_SECRET di Cloudflare Worker

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateDatabaseFile() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
  var files = folder.getFilesByName(FILE_NAME);
  if (files.hasNext()) {
    return { folder: folder, file: files.next() };
  }
  var file = folder.createFile(FILE_NAME, "[]", MimeType.PLAIN_TEXT);
  return { folder: folder, file: file };
}

function sanitizeQuestions(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item.q !== "string" || !Array.isArray(item.options) || item.options.length < 2) {
      continue;
    }
    var opts = item.options.slice(0, 4).map(function(o) { return String(o); });
    while (opts.length < 4) opts.push("-");
    var ans = Number(item.answer);
    out.push({
      id: (Number.isInteger(Number(item.id)) && Number(item.id) > 0) ? Number(item.id) : (i + 1),
      topic: String(item.topic || "Umum").trim() || "Umum",
      q: item.q.trim(),
      options: opts,
      answer: (Number.isInteger(ans) && ans >= 0 && ans < 4) ? ans : 0
    });
  }
  return out;
}

function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || "getQuestions";
    var db = getOrCreateDatabaseFile();
    var raw = db.file.getBlob().getDataAsString("UTF-8") || "[]";
    var parsed = [];
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) parsed = [];
    } catch (err) {
      parsed = [];
    }

    if (action === "ping") {
      return jsonResponse({
        ok: true,
        source: "google_drive",
        folderName: db.folder.getName(),
        fileId: db.file.getId(),
        fileUrl: db.file.getUrl(),
        count: parsed.length
      });
    }

    return jsonResponse({
      ok: true,
      source: "google_drive",
      hasCustom: parsed.length > 0,
      count: parsed.length,
      questions: parsed
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResponse({ ok: false, error: "Server sibuk, coba beberapa detik lagi." });
  }
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }

    if (API_SECRET && body.secret !== API_SECRET) {
      return jsonResponse({ ok: false, error: "Unauthorized secret" });
    }

    var action = body.action || "SAVE";
    var db = getOrCreateDatabaseFile();

    if (action === "RESET") {
      db.file.setContent("[]");
      return jsonResponse({ ok: true, reset: true, source: "google_drive" });
    }

    var incoming = sanitizeQuestions(body.questions || []);
    if (action === "APPEND") {
      var existing = [];
      try {
        existing = JSON.parse(db.file.getBlob().getDataAsString("UTF-8") || "[]");
        if (!Array.isArray(existing)) existing = [];
      } catch (err) {
        existing = [];
      }
      var seen = {};
      var maxId = 0;
      for (var i = 0; i < existing.length; i++) {
        seen[String(existing[i].q || "").trim().toLowerCase()] = true;
        if (Number(existing[i].id) > maxId) maxId = Number(existing[i].id);
      }
      var added = 0;
      for (var j = 0; j < incoming.length; j++) {
        var norm = incoming[j].q.toLowerCase();
        if (!seen[norm]) {
          maxId += 1;
          incoming[j].id = maxId;
          existing.push(incoming[j]);
          seen[norm] = true;
          added += 1;
        }
      }
      db.file.setContent(JSON.stringify(existing, null, 2));
      return jsonResponse({ ok: true, added: added, count: existing.length, source: "google_drive" });
    }

    if (incoming.length === 0) {
      return jsonResponse({ ok: false, error: "Daftar soal kosong atau tidak valid." });
    }

    db.file.setContent(JSON.stringify(incoming, null, 2));
    return jsonResponse({ ok: true, count: incoming.length, source: "google_drive" });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
