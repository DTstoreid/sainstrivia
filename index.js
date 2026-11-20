// Cloudflare Worker (Hybrid: D1 LOBBY_DB untuk Multiplayer + Apps Script/Google Drive untuk Bank Soal)
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate"
};

const QUESTIONS_CACHE_KEY = "questions_cache_v1";
const QUESTIONS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit cache di D1 agar 50 pemain tidak membebani Apps Script
const LOBBY_TTL_MS = 2 * 60 * 60 * 1000;      // 2 jam masa aktif lobby

let schemaReady = false;

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

async function ensureD1Schema(db) {
  if (schemaReady || !db) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lobbies (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  ]);
  schemaReady = true;
}

// Unified storage helpers (D1 primary, KV graceful fallback)
async function getLobbyRecord(env, code) {
  if (env.LOBBY_DB) {
    await ensureD1Schema(env.LOBBY_DB);
    const row = await env.LOBBY_DB.prepare("SELECT data, updated_at FROM lobbies WHERE code = ?").bind(code).first();
    if (!row) return null;
    if (Date.now() - Number(row.updated_at || 0) > LOBBY_TTL_MS) {
      await env.LOBBY_DB.prepare("DELETE FROM lobbies WHERE code = ?").bind(code).run();
      return null;
    }
    return JSON.parse(row.data);
  }
  if (env.LOBBY_KV) {
    const raw = await env.LOBBY_KV.get(`lobby:${code}`);
    return raw ? JSON.parse(raw) : null;
  }
  return null;
}

async function saveLobbyRecord(env, code, lobby) {
  const now = Date.now();
  lobby.updatedAt = now;
  if (env.LOBBY_DB) {
    await ensureD1Schema(env.LOBBY_DB);
    await env.LOBBY_DB
      .prepare("INSERT OR REPLACE INTO lobbies (code, data, updated_at) VALUES (?, ?, ?)")
      .bind(code, JSON.stringify(lobby), now)
      .run();
    // Bersihkan lobby kedaluwarsa secara berkala (~5% kesempatan per write)
    if (Math.random() < 0.05) {
      await env.LOBBY_DB.prepare("DELETE FROM lobbies WHERE updated_at < ?").bind(now - LOBBY_TTL_MS).run();
    }
    return;
  }
  if (env.LOBBY_KV) {
    await env.LOBBY_KV.put(`lobby:${code}`, JSON.stringify(lobby), { expirationTtl: 7200 });
  }
}

async function deleteLobbyRecord(env, code) {
  if (env.LOBBY_DB) {
    await ensureD1Schema(env.LOBBY_DB);
    await env.LOBBY_DB.prepare("DELETE FROM lobbies WHERE code = ?").bind(code).run();
    return;
  }
  if (env.LOBBY_KV) {
    await env.LOBBY_KV.delete(`lobby:${code}`);
  }
}

async function getConfigRecord(env, key) {
  if (env.LOBBY_DB) {
    await ensureD1Schema(env.LOBBY_DB);
    const row = await env.LOBBY_DB.prepare("SELECT value, updated_at FROM app_config WHERE key = ?").bind(key).first();
    if (!row) return null;
    return { value: row.value, updatedAt: Number(row.updated_at || 0) };
  }
  if (env.LOBBY_KV) {
    const raw = await env.LOBBY_KV.get(`cfg:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
  return null;
}

async function saveConfigRecord(env, key, valueStr) {
  const now = Date.now();
  if (env.LOBBY_DB) {
    await ensureD1Schema(env.LOBBY_DB);
    await env.LOBBY_DB
      .prepare("INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, valueStr, now)
      .run();
    return;
  }
  if (env.LOBBY_KV) {
    await env.LOBBY_KV.put(`cfg:${key}`, JSON.stringify({ value: valueStr, updatedAt: now }));
  }
}

async function deleteConfigRecord(env, key) {
  if (env.LOBBY_DB) {
    await ensureD1Schema(env.LOBBY_DB);
    await env.LOBBY_DB.prepare("DELETE FROM app_config WHERE key = ?").bind(key).run();
    return;
  }
  if (env.LOBBY_KV) {
    await env.LOBBY_KV.delete(`cfg:${key}`);
  }
}

function sanitizeQuestions(list) {
  if (!Array.isArray(list)) return [];
  const sanitized = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item.q !== "string" || !Array.isArray(item.options) || item.options.length < 2) {
      continue;
    }
    const opts = item.options.slice(0, 4).map(o => String(o));
    while (opts.length < 4) opts.push("-");
    const ans = Number(item.answer);
    sanitized.push({
      id: Number.isInteger(Number(item.id)) && Number(item.id) > 0 ? Number(item.id) : (i + 1),
      topic: String(item.topic || "Umum").trim() || "Umum",
      q: item.q.trim(),
      options: opts,
      answer: Number.isInteger(ans) && ans >= 0 && ans < 4 ? ans : 0
    });
  }
  return sanitized;
}

function shuffleServer(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function maybeBuildBingoBoard(lobby) {
  if (!lobby || !lobby.bingo || lobby.bingo.phase !== "ban") return false;
  const players = Array.isArray(lobby.players) ? lobby.players : [];
  if (players.length !== 2) return false;
  const bans = lobby.bingo.bans || {};
  const b0 = bans[players[0].id];
  const b1 = bans[players[1].id];
  if (!b0 || !b1) return false;

  const fallbackTopics = ["Matematika", "Kimia", "Astronomi", "Ilmu Batuan", "Geologi"];
  const allActive = (Array.isArray(lobby.bingo.activeTopics) && lobby.bingo.activeTopics.length > 0)
    ? lobby.bingo.activeTopics
    : fallbackTopics;
  const bannedSet = new Set([b0, b1]);
  let remaining = allActive.filter(t => !bannedSet.has(t));
  if (remaining.length === 0) remaining = [...allActive];

  const cellTopics = [];
  for (let i = 0; i < 9; i++) {
    cellTopics.push(remaining[i % remaining.length]);
  }
  const shuffled = shuffleServer(cellTopics);
  lobby.bingo.board = shuffled.map((t, idx) => ({ idx, topic: t, ownerId: null }));
  lobby.bingo.phase = "play";
  lobby.bingo.turnIdx = 0;
  lobby.bingo.activeCell = null;
  lobby.bingo.winnerId = null;
  lobby.bingo.winLine = null;
  lobby.bingo.rev = (lobby.bingo.rev || 0) + 1;
  return true;
}

async function handleQuestionsApi(request, env, url) {
  const hasDb = Boolean(env.LOBBY_DB || env.LOBBY_KV);
  const gasUrl = (env.APPS_SCRIPT_URL || "").trim();

  if (request.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1";

    // 1. Cek cache D1 terlebih dahulu agar 50 pemain tidak membebani kuota Apps Script
    if (hasDb && !forceRefresh) {
      const cached = await getConfigRecord(env, QUESTIONS_CACHE_KEY);
      if (cached && cached.value) {
        const isFresh = !gasUrl || (Date.now() - cached.updatedAt < QUESTIONS_CACHE_TTL_MS);
        if (isFresh) {
          try {
            const parsed = JSON.parse(cached.value);
            if (Array.isArray(parsed) && parsed.length > 0) {
              return jsonRes({ ok: true, hasCustom: true, source: gasUrl ? "d1_cache" : "d1", questions: parsed });
            }
          } catch (e) {}
        }
      }
    }

    // 2. Jika APPS_SCRIPT_URL dikonfigurasi, tarik data terbaru dari Google Drive via Apps Script
    if (gasUrl) {
      try {
        const sep = gasUrl.includes("?") ? "&" : "?";
        const res = await fetch(`${gasUrl}${sep}action=getQuestions&_t=${Date.now()}`, {
          method: "GET",
          redirect: "follow"
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && Array.isArray(data.questions) && data.questions.length > 0) {
            if (hasDb) {
              await saveConfigRecord(env, QUESTIONS_CACHE_KEY, JSON.stringify(data.questions));
            }
            return jsonRes({ ok: true, hasCustom: true, source: "google_drive", questions: data.questions });
          }
          if (data && data.ok && Array.isArray(data.questions) && data.questions.length === 0) {
            if (hasDb) await deleteConfigRecord(env, QUESTIONS_CACHE_KEY);
            return jsonRes({ ok: true, hasCustom: false, source: "google_drive", questions: [] });
          }
        }
      } catch (e) {
        // Fallback ke cache D1 lama jika Apps Script sedang lambat/sibuk
        if (hasDb) {
          const stale = await getConfigRecord(env, QUESTIONS_CACHE_KEY);
          if (stale && stale.value) {
            try {
              const parsed = JSON.parse(stale.value);
              if (Array.isArray(parsed) && parsed.length > 0) {
                return jsonRes({ ok: true, hasCustom: true, source: "d1_stale_fallback", questions: parsed });
              }
            } catch (err) {}
          }
        }
      }
    }

    return jsonRes({ ok: true, hasCustom: false, source: "default_asset", questions: [] });
  }

  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return jsonRes({ ok: false, error: "Invalid JSON" }, 400);
    }

    if (body.action === "RESET") {
      let driveSynced = false;
      if (gasUrl) {
        try {
          const gRes = await fetch(gasUrl, {
            method: "POST",
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "RESET", secret: env.APPS_SCRIPT_SECRET || "" })
          });
          if (gRes.ok) {
            const gData = await gRes.json();
            driveSynced = Boolean(gData && gData.ok);
          }
        } catch (e) {}
      }
      if (hasDb) await deleteConfigRecord(env, QUESTIONS_CACHE_KEY);
      return jsonRes({ ok: true, reset: true, driveSynced });
    }

    const sanitized = sanitizeQuestions(body.questions);
    if (sanitized.length === 0) {
      return jsonRes({ ok: false, error: "Daftar soal kosong atau tidak valid" }, 400);
    }

    let driveSynced = false;
    if (gasUrl) {
      try {
        const gRes = await fetch(gasUrl, {
          method: "POST",
          redirect: "follow",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "SAVE", questions: sanitized, secret: env.APPS_SCRIPT_SECRET || "" })
        });
        if (gRes.ok) {
          const gData = await gRes.json();
          driveSynced = Boolean(gData && gData.ok);
        }
      } catch (e) {}
    }

    if (hasDb) {
      await saveConfigRecord(env, QUESTIONS_CACHE_KEY, JSON.stringify(sanitized));
    } else if (!driveSynced) {
      return jsonRes({ ok: false, error: "LOBBY_DB atau APPS_SCRIPT_URL belum dikonfigurasi" }, 501);
    }

    return jsonRes({ ok: true, count: sanitized.length, driveSynced, d1Cached: hasDb });
  }

  return jsonRes({ ok: false, error: "Method not allowed" }, 405);
}

async function handleLobbyApi(request, env, url) {
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();

  if (!env.LOBBY_DB && !env.LOBBY_KV) {
    return jsonRes({ ok: false, error: "LOBBY_DB (D1) binding not configured" }, 501);
  }
  if (!code || code.length < 4) {
    return jsonRes({ ok: false, error: "Invalid lobby code" }, 400);
  }

  if (request.method === "GET") {
    const lobby = await getLobbyRecord(env, code);
    if (!lobby) return jsonRes({ ok: false, notFound: true }, 404);
    return jsonRes({ ok: true, lobby });
  }

  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return jsonRes({ ok: false, error: "Invalid JSON" }, 400);
    }

    let lobby = await getLobbyRecord(env, code);
    const action = body.action;

    if (action === "CREATE") {
      lobby = {
        code,
        status: "waiting",
        settings: body.settings || { duration: 20, count: 15, scoring: "fixed", topics: null, maxGuests: 10 },
        players: body.player ? [body.player] : [],
        roundsPlayed: 0,
        deck: [],
        currentQ: 0,
        updatedAt: Date.now()
      };
    } else if (action === "JOIN") {
      if (!lobby || !Array.isArray(lobby.players) || !lobby.players.some(pl => !pl.isBot)) {
        return jsonRes({ ok: false, notFound: true, error: "LOBBY_NOT_FOUND" }, 404);
      }
      const p = body.player;
      if (p) {
        const exists = lobby.players.find(pl => pl.id === p.id);
        if (!exists) {
          const maxGuests = (lobby.settings && lobby.settings.maxGuests) || 10;
          if (lobby.players.length >= maxGuests) {
            return jsonRes({ ok: false, error: "LOBBY_FULL" }, 200);
          }
          const lowerNames = new Set(lobby.players.map(pl => (pl.name || "").trim().toLowerCase()));
          let finalName = (p.name || "Pemain").trim();
          if (lowerNames.has(finalName.toLowerCase())) {
            let n = 2;
            while (lowerNames.has(`${finalName} (${n})`.toLowerCase())) n++;
            finalName = `${finalName} (${n})`;
          }
          p.name = finalName;
          lobby.players.push(p);
        } else {
          exists.name = p.name;
        }
      }
    } else if (!lobby) {
      return jsonRes({ ok: false, notFound: true }, 404);
    } else if (action === "SYNC_HOST") {
      if (Array.isArray(body.players)) {
        const hostIds = new Set(body.players.map(p => p.id));
        const kept = [...body.players];
        lobby.players.forEach(existing => {
          if (!existing.isBot && !hostIds.has(existing.id)) {
            kept.push(existing);
          }
        });
        lobby.players = kept;
      }
      if (body.settings) lobby.settings = body.settings;
      if (typeof body.roundsPlayed === "number") lobby.roundsPlayed = body.roundsPlayed;
    } else if (action === "START_GAME") {
      lobby.status = "playing";
      lobby.deck = Array.isArray(body.deck) ? body.deck : [];
      if (Array.isArray(body.usedQuestionIds)) lobby.usedQuestionIds = body.usedQuestionIds;
      if (body.settings) lobby.settings = body.settings;
      lobby.currentQ = 0;
      lobby.players.forEach(p => {
        p.score = 0;
        p.correct = 0;
        p.answeredQ = -1;
      });
    } else if (action === "ANSWER") {
      const target = lobby.players.find(p => p.id === body.playerId);
      if (target) {
        target.score = body.score;
        target.correct = body.correct;
        target.answeredQ = body.qIndex;
      }
    } else if (action === "ADVANCE") {
      if (typeof body.nextIndex === "number") {
        lobby.currentQ = body.nextIndex;
        if (lobby.deck.length && lobby.currentQ >= lobby.deck.length) {
          lobby.status = "finished";
        }
      }
    } else if (action === "FINISH_ROUND") {
      lobby.status = "finished";
      if (Array.isArray(body.players)) lobby.players = body.players;
      if (typeof body.roundsPlayed === "number") lobby.roundsPlayed = body.roundsPlayed;
    } else if (action === "SET_READY") {
      const target = (lobby.players || []).find(pl => pl.id === body.playerId);
      if (target) {
        target.ready = Boolean(body.ready);
      }
    } else if (action === "BINGO_BAN") {
      if (lobby.bingo && lobby.bingo.phase === "ban") {
        if (!body.roundId || !lobby.bingo.roundId || lobby.bingo.roundId === body.roundId) {
          if (!lobby.bingo.bans) lobby.bingo.bans = {};
          if (body.playerId && body.topic) {
            lobby.bingo.bans[body.playerId] = body.topic;
            lobby.bingo.rev = (lobby.bingo.rev || 0) + 1;
          }
          maybeBuildBingoBoard(lobby);
        }
      }
    } else if (action === "BINGO_SYNC") {
      lobby.status = "bingo";
      const prev = lobby.bingo || null;
      const incoming = body.bingo || {};
      const isNewRound = Boolean(incoming.roundId && (!prev || prev.roundId !== incoming.roundId));

      if (!prev || isNewRound) {
        lobby.bingo = {
          ...incoming,
          bans: { ...(incoming.bans || {}) },
          rev: typeof incoming.rev === "number" ? incoming.rev : 1
        };
      } else {
        const prevRev = typeof prev.rev === "number" ? prev.rev : 0;
        const incRev = typeof incoming.rev === "number" ? incoming.rev : 0;
        const mergedBans = { ...(prev.bans || {}), ...(incoming.bans || {}) };
        if (incRev >= prevRev) {
          lobby.bingo = { ...incoming, bans: mergedBans, rev: Math.max(prevRev, incRev) };
        } else {
          lobby.bingo = { ...prev, bans: mergedBans };
        }
      }
      maybeBuildBingoBoard(lobby);
      if (Array.isArray(body.players)) lobby.players = body.players;
      if (typeof body.roundsPlayed === "number") lobby.roundsPlayed = body.roundsPlayed;
    } else if (action === "RETURN_LOBBY") {
      lobby.status = "waiting";
      lobby.currentQ = 0;
      lobby.deck = [];
      lobby.bingo = null;
      (lobby.players || []).forEach(pl => {
        if (!pl.isBot) pl.ready = false;
      });
    } else if (action === "LEAVE") {
      lobby.players = (lobby.players || []).filter(pl => pl.id !== body.playerId);
      const remainingHumans = lobby.players.filter(pl => !pl.isBot);
      if (body.isHost || remainingHumans.length === 0) {
        await deleteLobbyRecord(env, code);
        return jsonRes({ ok: true, deleted: true });
      }
    }

    await saveLobbyRecord(env, code, lobby);
    return jsonRes({ ok: true, lobby });
  }

  return jsonRes({ ok: false, error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lobby") {
      return handleLobbyApi(request, env, url);
    }
    if (url.pathname === "/api/questions") {
      return handleQuestionsApi(request, env, url);
    }

    const assetRes = await env.ASSETS.fetch(request);
    const ct = assetRes.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      let html = await assetRes.text();
      const absThumb = `${url.origin}/og-thumbnail.jpg`;
      const lobbyCode = (url.searchParams.get("lobby") || "").trim().toUpperCase();

      html = html
        .replaceAll('content="/og-thumbnail.jpg"', `content="${absThumb}"`)
        .replace(
          '<meta property="og:type" content="website" />',
          `<meta property="og:type" content="website" />
  <meta property="og:url" content="${url.href.replace(/"/g, "&quot;")}" />`
        );

      if (lobbyCode && lobbyCode.length >= 4) {
        const safeCode = lobbyCode.replace(/[^A-Z0-9]/g, "");
        html = html
          .replace('<meta property="og:title" content="SainsTrivia" />', `<meta property="og:title" content="Gabung Lobby ${safeCode} — SainsTrivia" />`)
          .replace('<meta name="twitter:title" content="SainsTrivia" />', `<meta name="twitter:title" content="Gabung Lobby ${safeCode} — SainsTrivia" />`)
          .replace(
            '<meta property="og:description" content="Uji wawasan sainsmu dalam mode Solo atau tantang teman di Lobby Multiplayer!" />',
            `<meta property="og:description" content="Kamu diundang bermain kuis SainsTrivia di Lobby ${safeCode}. Klik tautan untuk bergabung!" />`
          )
          .replace(
            '<meta name="twitter:description" content="Uji wawasan sainsmu dalam mode Solo atau tantang teman di Lobby Multiplayer!" />',
            `<meta name="twitter:description" content="Kamu diundang bermain kuis SainsTrivia di Lobby ${safeCode}. Klik tautan untuk bergabung!" />`
          );
      }

      const headers = new Headers(assetRes.headers);
      headers.set("content-type", "text/html; charset=UTF-8");
      return new Response(html, { status: assetRes.status, headers });
    }

    return assetRes;
  }
};
